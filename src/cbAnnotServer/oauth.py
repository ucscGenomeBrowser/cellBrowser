"""
OAuth / OpenID Connect sign-in.

Every provider is configured, not coded. providers.py reads a server-side conf
file into a list of ProviderSpec; init_oauth() registers each one against its
OIDC discovery document, and the two routes below are generic over the slug:

    GET /api/auth/oauth/<provider>/login     -> redirect to the provider's consent screen
    GET /api/auth/oauth/<provider>/callback  -> exchange the code, resolve the identity,
                                                sign the user in, and redirect back
                                                into the Cell Browser

Adding Microsoft, CILogon, Globus or any other OIDC issuer therefore needs no
change here: a stanza in providers.conf and a restart is the whole job. See
providers.py for the file format and the built-in presets.

A provider with no client id/secret is skipped at startup, so its routes 404
and the frontend offers no button (see GET /api/auth/providers). That lets a
provider ship dormant, before its app has been registered.

Signing in while already signed in *links* the new identity to the current
account instead of creating a second one — see oauth_login()'s ?link=1 and
_link_identity() below.

Authlib is an optional dependency: app.py imports this module inside a
try/except so the service still boots where Authlib isn't installed (OAuth
simply stays off). Keep Authlib imports confined to this module.
"""
from datetime import datetime
from urllib.parse import urlencode

from authlib.integrations.flask_client import OAuth
from flask import Blueprint, current_app, redirect, request, session, url_for
from flask_login import current_user, login_user

from extensions import db
from models import OAuthIdentity, User
from providers import load_providers

oauth_bp = Blueprint("oauth", __name__)

# Authlib registry, populated by init_oauth() from the conf file.
_oauth = OAuth()

# slug -> ProviderSpec for everything that ended up configured. Read by the
# /api/auth/providers endpoint so the frontend only shows live buttons.
_specs = {}

# Session key holding the id of the user who started a "link another sign-in"
# flow, so the callback can tell linking from a plain sign-in.
_LINK_KEY = "oauth_link_user_id"


def init_oauth(app):
    """Register every configured provider and attach the blueprint. Called once
    from the app factory."""
    _specs.clear()
    # app.config["PROVIDERS_CONF"] is None unless CBANNOT_PROVIDERS_CONF was
    # set; load_providers() then falls back to the default /hive path.
    for spec in load_providers(path=app.config.get("PROVIDERS_CONF"),
                               warn=app.logger.warning):
        if spec.slug in _specs:
            app.logger.warning("duplicate sign-in provider %r — ignoring the later one", spec.slug)
            continue
        _oauth.register(
            name=spec.slug,
            client_id=spec.client_id,
            client_secret=spec.client_secret,
            server_metadata_url=spec.discovery,
            client_kwargs={"scope": spec.scope},
        )
        _specs[spec.slug] = spec

    _oauth.init_app(app)
    app.register_blueprint(oauth_bp, url_prefix="/api/auth/oauth")
    if _specs:
        app.logger.info("OAuth sign-in enabled for: %s", ", ".join(_specs))
    else:
        app.logger.info("OAuth sign-in: no providers configured (password login only)")


def provider_list():
    """[{"slug": ..., "label": ...}] for the frontend, in conf-file order."""
    return [{"slug": s.slug, "label": s.label} for s in _specs.values()]


def _client(provider):
    if provider not in _specs:
        return None
    return getattr(_oauth, provider, None)


def _back_to_app(status=None, **params):
    """Redirect the browser back into the Cell Browser. The OAuth callback is
    reached by a redirect from the provider, so the user must land on the app,
    not on a JSON error page. Outcomes are passed as query parameters the
    frontend surfaces (see handleOAuthReturn in cellBrowser.js)."""
    base = current_app.config["SITE_BASE_URL"]
    if status:
        params["cbAuth"] = status
    if params:
        return redirect(base + ("&" if "?" in base else "?") + urlencode(params))
    return redirect(base)


# ---------- routes ----------

@oauth_bp.get("/<provider>/login")
def oauth_login(provider):
    client = _client(provider)
    if client is None:
        return ("unknown or disabled provider", 404)

    # ?link=1 from a signed-in session means "add this as another way to sign
    # in to the account I am already using" rather than "sign me in". Remember
    # who asked, in the server-side session, so the callback cannot be talked
    # into linking an identity onto somebody else's account.
    if request.args.get("link") and current_user.is_authenticated:
        session[_LINK_KEY] = current_user.id
    else:
        session.pop(_LINK_KEY, None)

    # Build an absolute callback URL so it matches the redirect URI registered
    # with the provider exactly.
    redirect_uri = url_for("oauth.oauth_callback", provider=provider, _external=True)
    return client.authorize_redirect(redirect_uri)


@oauth_bp.get("/<provider>/callback")
def oauth_callback(provider):
    client = _client(provider)
    if client is None:
        return ("unknown or disabled provider", 404)
    spec = _specs[provider]

    link_user_id = session.pop(_LINK_KEY, None)

    # Exchange the authorization code for tokens. For an OIDC provider this
    # also returns the parsed id_token claims under "userinfo".
    token = client.authorize_access_token()
    claims = token.get("userinfo") or {}
    if not claims:
        # Fall back to the UserInfo endpoint if the id_token wasn't parsed.
        claims = client.userinfo(token=token)

    # The stable per-user id at this provider. Configurable because a campus
    # IdP reached through a broker may recycle its default subject when a
    # person leaves; see providers.py subject_claim.
    subject = claims.get(spec.subject_claim) or None
    if not subject:
        current_app.logger.warning(
            "provider %s returned no %r claim; got %s",
            provider, spec.subject_claim, sorted(claims))
        return _back_to_app("error", reason="no-subject")
    subject = str(subject)

    email = (claims.get("email") or "").strip().lower() or None
    # OIDC email_verified is a boolean, but some issuers send the string.
    raw_verified = claims.get("email_verified")
    email_verified = raw_verified is True or str(raw_verified).strip().lower() == "true"
    name = claims.get("name") or claims.get("given_name") or None

    if link_user_id is not None:
        return _link_identity(link_user_id, spec, subject, email, email_verified, name)

    user, identity = _find_or_create(spec, subject, email, email_verified, name)

    login_user(user, remember=True)
    now = datetime.utcnow()
    user.last_login = now
    identity.last_login = now
    db.session.commit()
    return _back_to_app()


# ---------- identity resolution ----------

def _find_or_create(spec, subject, email, email_verified, name):
    """Resolve an external identity to a local account, creating or linking it.

    1. A known (provider, subject) is that account, always.
    2. Otherwise, if the provider is trusted to vouch for email addresses AND
       asserted this one is verified AND it matches an existing account, adopt
       that account and attach this identity to it. Both conditions matter: an
       issuer that hands out unverified addresses could otherwise be used to
       take over an account by signing up there with somebody else's address.
    3. Otherwise create a new account.

    Returns (user, identity).
    """
    identity = db.session.query(OAuthIdentity).filter_by(
        provider=spec.slug, subject=subject).first()
    if identity:
        # Refresh what the provider says about them; it may have changed.
        identity.email = email or identity.email
        identity.display_name = name or identity.display_name
        return identity.user, identity

    user = None
    can_link_by_email = bool(email) and spec.trust_email and email_verified
    if can_link_by_email:
        user = db.session.query(User).filter_by(email=email).first()

    if user is None:
        # A new account. Only claim the email address for the account itself if
        # this provider is trusted for it and it is not already spoken for --
        # otherwise the account starts without one (the user can add and verify
        # an address later, or link this identity from a signed-in session).
        account_email = email if can_link_by_email else None
        if account_email and db.session.query(User).filter_by(email=account_email).first():
            account_email = None
        if email and not can_link_by_email:
            current_app.logger.info(
                "provider %s supplied an email for a new account but is not "
                "trusted to vouch for it (trust_email=%s, email_verified=%s) "
                "- creating the account without one",
                spec.slug, spec.trust_email, email_verified)
        user = User(
            email=account_email,
            password_hash=None,
            display_name=name,
            # The provider authenticated them, so there is nothing for us to
            # verify by email -- but only say so when we actually kept the address.
            email_verified=bool(account_email),
        )
        db.session.add(user)
        db.session.flush()   # assign user.id without ending the transaction

    identity = OAuthIdentity(
        user_id=user.id,
        provider=spec.slug,
        subject=subject,
        email=email,
        display_name=name,
    )
    db.session.add(identity)
    db.session.commit()
    return user, identity


def _link_identity(user_id, spec, subject, email, email_verified, name):
    """Attach this external identity to an existing, signed-in account."""
    user = db.session.get(User, user_id)
    if user is None:
        return _back_to_app("error", reason="link-no-user")

    existing = db.session.query(OAuthIdentity).filter_by(
        provider=spec.slug, subject=subject).first()
    if existing is not None:
        if existing.user_id == user.id:
            return _back_to_app("linked", provider=spec.slug)   # already linked; no-op
        # Bound to a different account. Merging two accounts means merging
        # their saved annotations and DE runs, which is not something to do
        # behind the user's back -- refuse and let a human sort it out.
        return _back_to_app("error", reason="link-taken", provider=spec.slug)

    db.session.add(OAuthIdentity(
        user_id=user.id,
        provider=spec.slug,
        subject=subject,
        email=email,
        display_name=name,
    ))
    # An account with no address of its own can adopt one here: the user is
    # already signed in, so this is not a takeover path -- but still only from
    # a provider trusted to vouch for the address, and only if it is free.
    if not user.email and email and spec.trust_email and email_verified:
        if not db.session.query(User).filter_by(email=email).first():
            user.email = email
            user.email_verified = True
    db.session.commit()
    return _back_to_app("linked", provider=spec.slug)
