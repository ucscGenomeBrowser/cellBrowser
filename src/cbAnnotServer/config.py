import os
import secrets

basedir = os.path.abspath(os.path.dirname(__file__))


class Config:
    # Sessions
    SECRET_KEY = os.environ.get("CBANNOT_SECRET_KEY") or secrets.token_hex(32)

    # Database. Default lives under the cells project area on /hive, which is
    # GPFS — unlike NFS (/cluster/home), GPFS honors POSIX fcntl locking, so
    # SQLite works reliably there and the dev DB persists across reboots.
    # Override with CBANNOT_DATABASE_URI (e.g. postgresql://...) in production.
    SQLALCHEMY_DATABASE_URI = os.environ.get("CBANNOT_DATABASE_URI") \
        or "sqlite:////hive/data/inside/cells/cbAnnotServer/cbAnnot.db"
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Token TTLs
    RESET_TOKEN_TTL_SECONDS = 3600          # 1 hour for password reset
    VERIFY_TOKEN_TTL_SECONDS = 7 * 24 * 3600  # 7 days for email verification

    # Password policy
    PASSWORD_MIN_LENGTH = 8

    # Email — stubbed by default; flip CBANNOT_MAIL_BACKEND=smtp to enable Flask-Mail
    MAIL_BACKEND = os.environ.get("CBANNOT_MAIL_BACKEND", "console")
    MAIL_SERVER = os.environ.get("CBANNOT_MAIL_SERVER", "localhost")
    MAIL_PORT = int(os.environ.get("CBANNOT_MAIL_PORT", "25"))
    MAIL_USE_TLS = os.environ.get("CBANNOT_MAIL_USE_TLS", "false").lower() == "true"
    MAIL_DEFAULT_SENDER = os.environ.get("CBANNOT_MAIL_FROM", "noreply@cells.ucsc.edu")

    # Base URL used to construct links in verification / reset emails, and the
    # base for OAuth redirect (callback) URLs.
    SITE_BASE_URL = os.environ.get("CBANNOT_SITE_BASE_URL", "http://localhost:5000")

    # ---- OAuth sign-in (Google, ORCID) ----------------------------------
    # Each provider is DORMANT until its client id AND secret are both set —
    # exactly like the frontend's showLogin flag. With the defaults below
    # (empty strings) no OAuth buttons appear and the /oauth routes 404, so it
    # is safe to ship this code before the apps are registered. The PI creates
    # the client credentials (see ticket #37492) and drops them into cbAnnot.env.
    GOOGLE_CLIENT_ID     = os.environ.get("CBANNOT_GOOGLE_CLIENT_ID", "")
    GOOGLE_CLIENT_SECRET = os.environ.get("CBANNOT_GOOGLE_CLIENT_SECRET", "")

    ORCID_CLIENT_ID      = os.environ.get("CBANNOT_ORCID_CLIENT_ID", "")
    ORCID_CLIENT_SECRET  = os.environ.get("CBANNOT_ORCID_CLIENT_SECRET", "")
    # "production" (orcid.org) or "sandbox" (sandbox.orcid.org). The sandbox is
    # a separate registration with separate credentials — use it to test the
    # flow without touching real ORCID accounts.
    ORCID_ENV            = os.environ.get("CBANNOT_ORCID_ENV", "production").lower()

    # Dev-only CORS. Production serves the frontend and this API from the same
    # Apache host (same origin), so no CORS is needed. For local dev, where the
    # static frontend runs on a different port than the Flask dev server, set
    # CBANNOT_DEV_CORS_ORIGIN to the frontend origin (e.g. http://localhost:8888)
    # to allow credentialed cross-origin requests. Leave unset in production.
    DEV_CORS_ORIGIN = os.environ.get("CBANNOT_DEV_CORS_ORIGIN")

    # Session cookie. In production the site is HTTPS and the API is same-origin
    # behind Apache, so set CBANNOT_COOKIE_SECURE=true to keep the login cookie
    # off plain HTTP. SameSite=Lax is fine for the same-origin setup; the dev
    # default leaves Secure off so the cookie works over http://localhost.
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = os.environ.get("CBANNOT_COOKIE_SAMESITE", "Lax")
    SESSION_COOKIE_SECURE = os.environ.get("CBANNOT_COOKIE_SECURE", "false").lower() == "true"
