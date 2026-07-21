"""
WSGI entry point for running cbAnnotServer under a WSGI server (gunicorn).

Production is served behind Apache: Apache proxies /api to a gunicorn process
that runs this module. See deploy/README.md for the full setup.

    gunicorn -c gunicorn.conf.py wsgi:application
"""
from app import create_app

application = create_app()
