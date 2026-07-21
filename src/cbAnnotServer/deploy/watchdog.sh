#!/bin/bash
# Cron-based keep-alive for cbAnnotServer, as a fallback for hosts where the
# systemd unit (deploy/cbAnnotServer.service) cannot be installed.
#
# It checks the gunicorn health endpoint and (re)starts the service if it is
# not answering. Run it once a minute from the deploy user's crontab, and once
# at boot so a reboot brings the service back:
#
#   * * * * *   /ABSOLUTE/PATH/src/cbAnnotServer/deploy/watchdog.sh >> /var/log/cbAnnotServer/watchdog.log 2>&1
#   @reboot     /ABSOLUTE/PATH/src/cbAnnotServer/deploy/watchdog.sh >> /var/log/cbAnnotServer/watchdog.log 2>&1
#
# Set the same runtime environment here that the systemd unit would set
# (CBANNOT_SECRET_KEY, CBANNOT_DATABASE_URI, CBANNOT_COOKIE_SECURE, ...), e.g. by
# sourcing an env file that is not world-readable:
#   set -a; . /etc/cbAnnotServer.env; set +a
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Health URL — must match CBANNOT_BIND (default 127.0.0.1:5051).
HEALTH_URL="${CBANNOT_HEALTH_URL:-http://127.0.0.1:5051/api/health}"
PIDFILE="${CBANNOT_PIDFILE:-/tmp/cbAnnotServer.pid}"

if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    exit 0   # healthy, nothing to do
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') health check failed ($HEALTH_URL), starting cbAnnotServer"

# Kill a stale process from a previous start, if any.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 2
fi

nohup "$here/run-gunicorn.sh" >> "${CBANNOT_ERROR_LOG:-/var/log/cbAnnotServer/gunicorn.log}" 2>&1 &
echo $! > "$PIDFILE"
