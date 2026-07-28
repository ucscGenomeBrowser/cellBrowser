"""
Gunicorn configuration for cbAnnotServer.

Everything is overridable through the environment so the same file works on
dev, beta and production without edits. Apache proxies /api to the address in
``bind`` (see deploy/apache-cells-api.conf).

Run with:
    gunicorn -c gunicorn.conf.py wsgi:application
"""
import os

# Address gunicorn listens on. Loopback only — Apache is the public front door
# and forwards /api here. Keep this in sync with the ProxyPass target in
# deploy/apache-cells-api.conf. Override with CBANNOT_BIND.
bind = os.environ.get("CBANNOT_BIND", "127.0.0.1:5051")

# Worker processes. Two is plenty for the current request volume (login and
# annotation save/load); bump via CBANNOT_WORKERS if needed.
workers = int(os.environ.get("CBANNOT_WORKERS", "2"))

# Recycle workers periodically so a slow leak can never accumulate.
max_requests = int(os.environ.get("CBANNOT_MAX_REQUESTS", "1000"))
max_requests_jitter = 100

# A request to this API should never take long; time out well before Apache does.
timeout = int(os.environ.get("CBANNOT_TIMEOUT", "30"))

# Log to stdout/stderr so whatever supervises the process (systemd/journald or
# the cron watchdog's logfile) captures it.
accesslog = os.environ.get("CBANNOT_ACCESS_LOG", "-")
errorlog = os.environ.get("CBANNOT_ERROR_LOG", "-")
loglevel = os.environ.get("CBANNOT_LOG_LEVEL", "info")

proc_name = "cbAnnotServer"
