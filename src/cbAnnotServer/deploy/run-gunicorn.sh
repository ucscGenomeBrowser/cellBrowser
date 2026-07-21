#!/bin/bash
# Start the cbAnnotServer (login + custom-annotation API) under gunicorn.
#
# Apache proxies /api on the cells vhost to the address gunicorn binds to
# (default 127.0.0.1:5051, set in gunicorn.conf.py / $CBANNOT_BIND). This is the
# command that systemd or the cron watchdog runs; see deploy/README.md.
#
# Production secrets/paths are passed in through the environment (the systemd
# unit sets them). Do NOT hard-code secrets here.
set -euo pipefail

# Resolve the cbAnnotServer directory (this script lives in deploy/ under it).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

# Activate the local virtualenv if it exists; otherwise assume gunicorn is on
# PATH (e.g. a conda env activated by the caller).
if [ -f venv/bin/activate ]; then
    # shellcheck disable=SC1091
    source venv/bin/activate
fi

exec gunicorn -c gunicorn.conf.py wsgi:application
