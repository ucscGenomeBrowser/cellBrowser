#!/bin/bash
# Cron-based keep-alive for cbAnnotServer, as a fallback for hosts where the
# systemd unit (deploy/cbAnnotServer.service) cannot be installed.
#
# It checks the gunicorn health endpoint and (re)starts the service if it is
# not answering. Run it once a minute from the deploy user's crontab, and once
# at boot so a reboot brings the service back. Pass the runtime environment
# (secret key, DB URI, cookie flags, log/pid paths) via CBANNOT_ENV_FILE, which
# this script sources on startup; keep that file non-world-readable:
#
#   * * * * *  CBANNOT_ENV_FILE=/path/cbAnnot.env /ABSOLUTE/PATH/deploy/watchdog.sh >> /path/logs/watchdog.log 2>&1
#   @reboot    CBANNOT_ENV_FILE=/path/cbAnnot.env /ABSOLUTE/PATH/deploy/watchdog.sh >> /path/logs/watchdog.log 2>&1
set -uo pipefail

# Optionally source a runtime env file (secrets, DB URI, cookie flags, log/pid
# paths). Point CBANNOT_ENV_FILE at a non-world-readable file; missing is fine.
if [ -n "${CBANNOT_ENV_FILE:-}" ] && [ -f "${CBANNOT_ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    . "${CBANNOT_ENV_FILE}"
    set +a
fi

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
