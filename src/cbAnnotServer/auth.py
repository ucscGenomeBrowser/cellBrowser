"""
Auth endpoints — signup, login, logout, email verification, password reset, /me.

All responses are JSON. The session cookie is set by Flask-Login on successful
login and cleared on logout. Verification and reset tokens are one-time use.
"""
import re
import secrets
from datetime import datetime, timedelta

from flask import Blueprint, current_app, jsonify, redirect, request
from flask_login import current_user, login_required, login_user, logout_user
from werkzeug.security import check_password_hash, generate_password_hash

from extensions import db
from email_utils import send_reset_email, send_verification_email
from models import User

auth_bp = Blueprint("auth", __name__)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _bad(msg, status=400):
    return jsonify({"error": msg}), status


def _ok(**extra):
    return jsonify({"ok": True, **extra})


def _new_token():
    return secrets.token_urlsafe(32)


# ---------- signup ----------

@auth_bp.post("/signup")
def signup():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    display_name = (data.get("display_name") or "").strip() or None

    if not EMAIL_RE.match(email):
        return _bad("invalid email")
    min_len = current_app.config["PASSWORD_MIN_LENGTH"]
    if len(password) < min_len:
        return _bad(f"password must be at least {min_len} characters")

    if db.session.query(User).filter_by(email=email).first():
        return _bad("an account with that email already exists", status=409)

    user = User(
        email=email,
        password_hash=generate_password_hash(password),
        display_name=display_name,
        email_verified=False,
        verify_token=_new_token(),
    )
    db.session.add(user)
    db.session.commit()

    # The account already exists at this point, so a mail failure must not turn
    # into a 500 that hides that. Log it and let the user recover via
    # "resend verification" rather than losing the signup.
    try:
        send_verification_email(user, user.verify_token)
    except Exception:
        current_app.logger.exception("failed to send verification email to %s", email)
        return _ok(requiresVerification=True, emailSent=False)
    return _ok(requiresVerification=True, emailSent=True)


# ---------- verify ----------

@auth_bp.get("/verify")
def verify():
    token = request.args.get("token", "")
    if not token:
        return _bad("missing token")

    user = db.session.query(User).filter_by(verify_token=token).first()
    if not user:
        return _bad("invalid or expired verification token", status=404)

    user.email_verified = True
    user.verify_token = None
    db.session.commit()

    # Log the user in so they don't have to immediately type the password they just signed up with
    login_user(user)
    user.last_login = datetime.utcnow()
    db.session.commit()

    # Redirect back to the site rather than returning JSON — verification is hit
    # via an email link, so the user expects to land in the app.
    return redirect(current_app.config["SITE_BASE_URL"])


@auth_bp.post("/resend-verification")
def resend_verification():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    user = db.session.query(User).filter_by(email=email).first()
    if user and not user.email_verified:
        user.verify_token = _new_token()
        db.session.commit()
        send_verification_email(user, user.verify_token)
    # Return ok regardless to avoid revealing whether the account exists
    return _ok()


# ---------- login / logout ----------

@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    user = db.session.query(User).filter_by(email=email).first()
    if not user or not check_password_hash(user.password_hash, password):
        return _bad("invalid email or password", status=401)

    if not user.email_verified:
        return _bad("email not verified — check your inbox for the verification link", status=403)

    login_user(user, remember=bool(data.get("remember")))
    user.last_login = datetime.utcnow()
    db.session.commit()
    return _ok(email=user.email, display_name=user.display_name)


@auth_bp.post("/logout")
@login_required
def logout():
    logout_user()
    return _ok()


@auth_bp.get("/providers")
def providers():
    """Which sign-in providers the frontend should offer. "password" is always
    on; the OAuth flags reflect whether Google / ORCID credentials are
    configured (see oauth.py). Defaults to OAuth-off if Authlib isn't installed
    or OAuth failed to initialise, so the frontend degrades to password-only."""
    status = {"password": True, "google": False, "orcid": False}
    try:
        from oauth import provider_status
        status.update(provider_status())
    except Exception:
        pass
    return jsonify(status)


@auth_bp.get("/me")
def me():
    if not current_user.is_authenticated:
        return jsonify({"loggedIn": False})
    return jsonify({
        "loggedIn": True,
        "email": current_user.email,
        "display_name": current_user.display_name,
    })


# ---------- password reset ----------

@auth_bp.post("/reset-request")
def reset_request():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    user = db.session.query(User).filter_by(email=email).first()
    if user:
        user.reset_token = _new_token()
        user.reset_expires = datetime.utcnow() + timedelta(
            seconds=current_app.config["RESET_TOKEN_TTL_SECONDS"]
        )
        db.session.commit()
        send_reset_email(user, user.reset_token)
    # Return ok regardless to avoid revealing which emails are registered
    return _ok()


@auth_bp.post("/reset-confirm")
def reset_confirm():
    data = request.get_json(silent=True) or {}
    token = data.get("token") or ""
    new_password = data.get("new_password") or ""

    if not token:
        return _bad("missing token")
    min_len = current_app.config["PASSWORD_MIN_LENGTH"]
    if len(new_password) < min_len:
        return _bad(f"password must be at least {min_len} characters")

    user = db.session.query(User).filter_by(reset_token=token).first()
    if not user:
        return _bad("invalid or expired reset token", status=404)
    if not user.reset_expires or user.reset_expires < datetime.utcnow():
        return _bad("reset link has expired", status=410)

    user.password_hash = generate_password_hash(new_password)
    user.reset_token = None
    user.reset_expires = None
    db.session.commit()

    return _ok()
