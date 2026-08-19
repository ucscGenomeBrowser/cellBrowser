#!/bin/bash
# Restart / reload the cbAnnotServer gunicorn. Run this AS THE USER that owns the
# gunicorn process (otto in production) — you cannot signal another user's process.
#
#   restart-gunicorn.sh            # graceful reload (HUP): reload workers, re-import
#                                  #   the app (picks up new blueprints, runs
#                                  #   db.create_all for new tables) — no downtime
#   restart-gunicorn.sh hard       # stop the master and respawn a fresh process
#                                  #   via the watchdog (brief downtime)
#
# The gunicorn master has no reliable pidfile (the watchdog's /tmp one gets cleaned),
# so we find it by process: gunicorn, owned by us, parented to init (PID 1). Finding
# it this way (not `pkill -f gunicorn`) avoids matching this script's own command.
set -uo pipefail

MODE="${1:-reload}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_URL="${CBANNOT_HEALTH_URL:-http://127.0.0.1:5051/api/health}"
ENV_FILE="${CBANNOT_ENV_FILE:-/hive/data/inside/cells/cbAnnotServer/cbAnnot.env}"

find_master() {
    # master = gunicorn process owned by the current user whose parent is init
    ps -eo pid=,ppid=,user=,args= \
        | awk -v u="$(id -un)" '$2==1 && $3==u && /gunicorn/ {print $1; exit}'
}

start_via_watchdog() {
    CBANNOT_ENV_FILE="$ENV_FILE" "$HERE/watchdog.sh"
}

check_health() {
    sleep 2
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
        echo "OK: gunicorn healthy at $HEALTH_URL"
    else
        echo "WARNING: health check failed at $HEALTH_URL — check the logs"
        return 1
    fi
}

MPID="$(find_master)"

case "$MODE" in
    reload)
        if [ -z "$MPID" ]; then
            echo "no gunicorn master owned by $(id -un); starting one via the watchdog"
            start_via_watchdog
        else
            echo "reloading gunicorn master $MPID (SIGHUP)"
            kill -HUP "$MPID"
        fi
        ;;
    hard|restart)
        if [ -n "$MPID" ]; then
            echo "stopping gunicorn master $MPID"
            kill "$MPID" 2>/dev/null || true
            sleep 3
            kill -9 "$MPID" 2>/dev/null || true
        fi
        echo "respawning via the watchdog"
        start_via_watchdog
        ;;
    *)
        echo "usage: ${0##*/} [reload|hard]" >&2
        exit 2
        ;;
esac

check_health
