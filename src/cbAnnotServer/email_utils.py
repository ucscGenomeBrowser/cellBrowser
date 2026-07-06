"""
Email sending. The backend is picked via CBANNOT_MAIL_BACKEND:

    console  (default) — print the rendered email to stdout. Used during dev.
    smtp               — actually send via Flask-Mail using MAIL_SERVER/PORT/etc.

Verification and reset emails carry one-time tokens. The link points to the
frontend (SITE_BASE_URL), which is responsible for relaying the token to the
appropriate API endpoint.
"""
from flask import current_app, render_template
from flask_mail import Message

from extensions import mail


def _backend():
    return (current_app.config.get("MAIL_BACKEND") or "console").lower()


def _send(subject, recipient, text_body, html_body):
    backend = _backend()
    if backend == "smtp":
        msg = Message(subject=subject, recipients=[recipient])
        msg.body = text_body
        msg.html = html_body
        mail.send(msg)
    else:
        # Print to stdout so a dev can grab the token from the console
        sender = current_app.config.get("MAIL_DEFAULT_SENDER", "noreply@cells.ucsc.edu")
        print("=" * 60)
        print(f"[EMAIL STUB] To: {recipient}")
        print(f"[EMAIL STUB] From: {sender}")
        print(f"[EMAIL STUB] Subject: {subject}")
        print("-" * 60)
        print(text_body)
        print("=" * 60, flush=True)


def send_verification_email(user, token):
    base = current_app.config["SITE_BASE_URL"].rstrip("/")
    verify_url = f"{base}/api/auth/verify?token={token}"

    text_body = (
        f"Welcome to the UCSC Cell Browser.\n\n"
        f"Click the link below to verify your email address:\n\n"
        f"{verify_url}\n\n"
        f"If you did not create an account, you can ignore this email."
    )
    html_body = render_template("email/verify.html", user=user, verify_url=verify_url)
    _send("Verify your Cell Browser account", user.email, text_body, html_body)


def send_reset_email(user, token):
    base = current_app.config["SITE_BASE_URL"].rstrip("/")
    reset_url = f"{base}/reset?token={token}"

    text_body = (
        f"A password reset was requested for your Cell Browser account.\n\n"
        f"Click the link below to set a new password (link expires in 1 hour):\n\n"
        f"{reset_url}\n\n"
        f"If you did not request this, you can ignore this email."
    )
    html_body = render_template("email/reset.html", user=user, reset_url=reset_url)
    _send("Reset your Cell Browser password", user.email, text_body, html_body)
