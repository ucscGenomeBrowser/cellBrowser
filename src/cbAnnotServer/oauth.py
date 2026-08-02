"""
OAuth sign-in for Google and ORCID.

Both providers speak OpenID Connect, so each is registered against its OIDC
discovery document and the flow is identical:

    GET /api/auth/oauth/<provider>/login     -> redirect to the provider's consent screen
    GET /api/auth/oauth/<provider>/callback  -> exchange the code, resolve the identity,
                                                find-or-create the local user, log them in,
                                                and redirect back into the Cell Browser.

A provider is only wired up when BOTH its client id and secret are configured
(see config.py). With no credentials set the provider is skipped at startup, so
its /login and /callback routes return 404 and no button is offered on the
frontend (see GET /api/auth/providers). This lets the code ship dormant, before
the OAuth apps have been registered.

Authlib is an optional dependency: app.py imports this module inside a
try/except so the service still boots on a host where Authlib isn't installed
yet (OAuth simply stays off). Keep Authlib imports confined to this module.
"""
from datetime import datetime

from authlib.integrations.flask_client import OAuth
from flask import Blueprint, current_app, redirect, url_for

from extensions import db
from flask_login import login_user
from models import User

oauth_bp = Blueprint("oauth", __name__)

# Authlib registry. Populated by init_oauth() from the app config.
_oauth = OAuth()

GOOGLE_METADATA = "https://accounts.google.com/.well-known/openid-configuration"

# Which providers ended up configured (client id + secret both present). Read by
# the /api/auth/providers endpoint so the frontend only shows live buttons.
_enabled = set()


def _orcid_issuer(cfg):
    """Base ORCID host for the configured environment (production vs sandbox)."""
    if cfg.get("ORCID_ENV") == "sandbox":
        return "https://sandbox.orcid.org"
    return "https://orcid.org"


def init_oauth(app):
    """Register every provider whose credentials are present, and attach the
    blueprint to the app. Safe to call once from the app factory."""
    _oauth.init_app(app)
    cfg = app.config

    if cfg.get("GOOGLE_CLIENT_ID") and cfg.get("GOOGLE_CLIENT_SECRET"):
        _oauth.register(
            name="google",
            client_id=cfg["GOOGLE_CLIENT_ID"],
            client_secret=cfg["GOOGLE_CLIENT_SECRET"],
            server_metadata_url=GOOGLE_METADATA,
            client_kwargs={"scope": "openid email profile"},
        )
        _enabled.add("google")

    if cfg.get("ORCID_CLIENT_ID") and cfg.get("ORCID_CLIENT_SECRET"):
        issuer = _orcid_issuer(cfg)
        _oauth.register(
            name="orcid",
            client_id=cfg["ORCID_CLIENT_ID"],
            client_secret=cfg["ORCID_CLIENT_SECRET"],
            server_metadata_url=f"{issuer}/.well-known/openid-configuration",
            # ORCID's OpenID scope yields the ORCID iD ("sub") and the person's
            # name. Email is only returned when the user has made it public.
            client_kwargs={"scope": "openid"},
        )
        _enabled.add("orcid")

    app.register_blueprint(oauth_bp, url_prefix="/api/auth/oauth")
    if _enabled:
        app.logger.info("OAuth enabled for: %s", ", ".join(sorted(_enabled)))


def provider_status():
    """{'google': bool, 'orcid': bool} — which providers are live."""
    return {"google": "google" in _enabled, "orcid": "orcid" in _enabled}


def _client(provider):
    if provider not in _enabled:
        return None
    return getattr(_oauth, provider, None)


# ---------- routes ----------

@oauth_bp.get("/<provider>/login")
def oauth_login(provider):
    client = _client(provider)
    if client is None:
        return ("unknown or disabled provider", 404)
    # The provider redirects back here after consent. Build an absolute URL so
    # it matches the redirect URI registered with Google / ORCID exactly.
    redirect_uri = url_for("oauth.oauth_callback", provider=provider, _external=True)
    return client.authorize_redirect(redirect_uri)


@oauth_bp.get("/<provider>/callback")
def oauth_callback(provider):
    client = _client(provider)
    if client is None:
        return ("unknown or disabled provider", 404)

    # Exchange the authorization code for tokens. For an OIDC provider this also
    # returns the parsed id_token claims under "userinfo".
    token = client.authorize_access_token()
    claims = token.get("userinfo") or {}
    if not claims:
        # Fall back to the UserInfo endpoint if the id_token wasn't parsed.
        claims = client.userinfo(token=token)

    sub = claims.get("sub")
    if not sub:
        return ("the identity provider returned no subject id", 502)
    email = (claims.get("email") or "").strip().lower() or None
    name = claims.get("name") or claims.get("given_name") or None

    user = _find_or_create(provider, sub, email, name)

    login_user(user, remember=True)
    user.last_login = datetime.utcnow()
    db.session.commit()

    # Land the user back in the app, not on a bare JSON page — this route is
    # reached by a browser redirect from the provider.
    return redirect(current_app.config["SITE_BASE_URL"])


def _find_or_create(provider, sub, email, name):
    """Resolve an OAuth identity to a local user, creating or linking as needed.

    1. Known (provider, sub) -> that user.
    2. Otherwise, if the provider gave a verified email that matches an existing
       account, link this identity onto it (so a prior password account and a
       Google login with the same address are one account).
    3. Otherwise create a fresh account. The provider has already verified the
       identity, so email_verified is true and no verification email is sent.
    """
    user = db.session.query(User).filter_by(
        oauth_provider=provider, oauth_sub=sub).first()
    if user:
        return user

    if email:
        user = db.session.query(User).filter_by(email=email).first()
        if user:
            user.oauth_provider = provider
            user.oauth_sub = sub
            if not user.email_verified:
                user.email_verified = True
            db.session.commit()
            return user

    user = User(
        email=email,
        password_hash=None,
        display_name=name,
        email_verified=True,
        oauth_provider=provider,
        oauth_sub=sub,
    )
    db.session.add(user)
    db.session.commit()
    return user
