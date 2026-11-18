import os
import secrets

basedir = os.path.abspath(os.path.dirname(__file__))


class Config:
    # Sessions
    SECRET_KEY = os.environ.get("CBANNOT_SECRET_KEY") or secrets.token_hex(32)

    # Database. Production uses hgcentral on MySQL/MariaDB:
    #   CBANNOT_DATABASE_URI=mysql+pymysql://USER:PASSWORD@HOST/hgcentral?charset=utf8mb4
    # (URL-encode any special characters in the password). The tables must
    # already exist there (deploy/schema-mysql.sql); the service never creates
    # tables on MySQL. With an sqlite:/// URI it creates them itself, which is
    # handy for local development.
    SQLALCHEMY_DATABASE_URI = os.environ.get("CBANNOT_DATABASE_URI") \
        or "sqlite:////cluster/home/otto/cellsServer/db/cbAnnot.db"
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    # pool_pre_ping/pool_recycle: MySQL drops idle connections after
    # wait_timeout, and without these the first request after a quiet night
    # fails with "MySQL server has gone away". Ignored by SQLite.
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True, "pool_recycle": 3600}
    if SQLALCHEMY_DATABASE_URI.startswith("mysql"):
        # Strict mode: an over-long value is an error, not silently cut short
        # (hgcentral's server default is non-strict).
        SQLALCHEMY_ENGINE_OPTIONS["connect_args"] = {
            "init_command": "SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'"}

    # Largest request body accepted, in bytes. A saved annotation or comparison
    # has to fit in one MEDIUMTEXT column (16 MB) and one MySQL packet
    # (max_allowed_packet, 16 MB on hgcentral), with room for JSON escaping and
    # the rest of the row. Larger requests get a 413. The largest item saved on
    # cells-test so far is 0.5 MB.
    MAX_CONTENT_LENGTH = int(os.environ.get("CBANNOT_MAX_CONTENT_LENGTH", 12 * 1024 * 1024))

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

    # ---- OAuth / OpenID Connect sign-in -----------------------------------
    # Providers are NOT configured here. They live in a server-side conf file
    # (default /cluster/home/otto/cellsServer/etc/providers.conf, override
    # with CBANNOT_PROVIDERS_CONF), one [provider:slug] stanza each, so adding
    # Microsoft / CILogon / any other OIDC issuer is a config change plus a
    # restart -- no code, no release. See providers.py for the format and the
    # built-in presets, and deploy/providers.conf.sample for a worked example.
    #
    # That file holds client secrets, so it must stay off the web tree and
    # chmod 600. It is emphatically not the frontend's cb.conf, which the
    # browser fetches over HTTP.
    #
    # The original CBANNOT_GOOGLE_* / CBANNOT_ORCID_* environment variables
    # still work (providers.py folds them in), so an existing deployment keeps
    # running unchanged; a conf-file stanza for the same slug wins.
    PROVIDERS_CONF = os.environ.get("CBANNOT_PROVIDERS_CONF")

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
