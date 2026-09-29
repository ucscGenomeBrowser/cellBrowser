"""
Flask app factory for cbAnnotServer.

Run for local development:
    cd src/cbAnnotServer
    source venv/bin/activate
    FLASK_APP=app.py flask run

Production: Apache proxies /api to a gunicorn process that serves this app via
wsgi.py. See deploy/README.md.
"""
from flask import Flask, jsonify

from config import Config
from extensions import db, login_manager, mail


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    db.init_app(app)
    login_manager.init_app(app)
    mail.init_app(app)

    login_manager.login_view = None  # API-only; no server-rendered login page

    @login_manager.unauthorized_handler
    def _unauthorized():
        return jsonify({"error": "not logged in"}), 401

    @login_manager.user_loader
    def _load_user(user_id):
        from models import User
        return db.session.get(User, int(user_id))

    # Blueprints (registered as we build them out)
    from auth import auth_bp
    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    from annotations import annotations_bp
    app.register_blueprint(annotations_bp, url_prefix="/api/annotations")
    from de.de_submit import bp as de_bp
    app.register_blueprint(de_bp, url_prefix="/api/de")
    from de.de_saved import bp as de_saved_bp
    app.register_blueprint(de_saved_bp, url_prefix="/api/de/saved")

    # OAuth (Google / ORCID) is optional. Import inside try/except so the
    # service still boots on a host where Authlib isn't installed yet — OAuth
    # just stays off. Each provider is further gated on having credentials
    # configured (see oauth.py / config.py).
    try:
        from oauth import init_oauth
        init_oauth(app)
    except ImportError as e:
        app.logger.warning("OAuth disabled (Authlib not available): %s", e)

    # Dev-only CORS: allow a single configured frontend origin to make
    # credentialed requests. No-op when DEV_CORS_ORIGIN is unset (production).
    cors_origin = app.config.get("DEV_CORS_ORIGIN")
    if cors_origin:
        @app.after_request
        def _add_cors_headers(resp):
            resp.headers["Access-Control-Allow-Origin"] = cors_origin
            resp.headers["Access-Control-Allow-Credentials"] = "true"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
            resp.headers["Vary"] = "Origin"
            return resp

        @app.route("/api/<path:_any>", methods=["OPTIONS"])
        def _cors_preflight(_any):
            # Empty 204 — the after_request hook above attaches the CORS headers.
            return ("", 204)

    @app.route("/api/health")
    def health():
        return jsonify({"ok": True})

    with app.app_context():
        # SQLAlchemy creates tables for any model imported before this runs
        import models  # noqa: F401
        _create_all_once(app)

    return app


def _create_all_once(app):
    """db.create_all(), tolerating the startup race between gunicorn workers.

    create_all's checkfirst is a check-then-create with no locking across
    processes. Every worker runs this factory, so when N workers boot in the
    same second they all see a table missing, all issue CREATE TABLE, and the
    losers get "table ... already exists". That fails the worker, and gunicorn
    shuts the entire master down when a worker fails to boot -- the service
    only comes back because the watchdog restarts it a minute later.

    It bites only on a release that actually adds a table, which is why it lay
    dormant from the first deploy until oauth_identities.

    Losing the race is harmless: the table exists either way, just created by
    the other worker. So swallow the error and verify, instead of letting a
    cosmetic collision take the service down.
    """
    from sqlalchemy import inspect
    from sqlalchemy.exc import OperationalError, ProgrammingError
    try:
        db.create_all()
    except (OperationalError, ProgrammingError) as e:
        missing = set(db.metadata.tables) - set(inspect(db.engine).get_table_names())
        if missing:
            raise   # a real failure: something we need is still not there
        app.logger.info(
            "create_all lost the startup race with another worker (%s); "
            "every table is present, continuing", e.orig)


if __name__ == "__main__":
    create_app().run(debug=True, port=5000)
