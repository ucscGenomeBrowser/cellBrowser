#!/bin/bash
# Restart the DE worker daemon. Run AS THE USER that owns it (otto in production).
# The worker has no reload signal, so a restart = stop it and respawn via the
# watchdog, picking up new deWorker.py code and any de.env changes (e.g. a new
# DE_WORKER_PYTHON).
#
#   restart-worker.sh          # graceful: SIGTERM, the worker finishes its current
#                              #   job, then exits; respawn a fresh one
#   restart-worker.sh force    # SIGKILL if it doesn't exit in time (a running job's
#                              #   subprocess is in its own session and keeps going)
set -uo pipefail

MODE="${1:-graceful}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${DE_ENV_FILE:-/hive/data/inside/cells/cbAnnotServer/de.env}"

# Source de.env so we know the pidfile location (and to pass it to the watchdog).
if [ -f "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE"; set +a
fi
PIDFILE="${DE_WORKER_PIDFILE:-/tmp/deWorker.pid}"

find_worker() {
    # Worker owned by us; exclude this script's own ps/awk line so we can't self-match.
    ps -eo pid=,user=,args= \
        | awk -v u="$(id -un)" '$2==u && /deWorker\.py/ && !/awk/ {print $1; exit}'
}

pid=""
if [ -f "$PIDFILE" ]; then
    p="$(cat "$PIDFILE" 2>/dev/null || true)"
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && pid="$p"
fi
[ -z "$pid" ] && pid="$(find_worker)"

if [ -n "$pid" ]; then
    echo "stopping DE worker $pid (SIGTERM; it finishes the current job first)"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
        if [ "$MODE" = "force" ]; then
            echo "still running after 20s — SIGKILL (its current job keeps running detached)"
            kill -9 "$pid" 2>/dev/null || true
            sleep 1
        else
            echo "worker $pid is still finishing a job (up to DE_JOB_TIMEOUT). It will exit"
            echo "and the cron watchdog will respawn it automatically; or re-run: ${0##*/} force"
            exit 0
        fi
    fi
else
    echo "no running DE worker found for $(id -un)"
fi

echo "respawning via the watchdog"
DE_ENV_FILE="$ENV_FILE" "$HERE/deWorkerWatchdog.sh"
sleep 2

newpid=""
[ -f "$PIDFILE" ] && newpid="$(cat "$PIDFILE" 2>/dev/null || true)"
[ -z "$newpid" ] && newpid="$(find_worker)"
if [ -n "$newpid" ] && kill -0 "$newpid" 2>/dev/null; then
    echo "OK: DE worker running (pid $newpid)"
    ps -o pid,user,etime,args -p "$newpid" 2>/dev/null | tail -1
else
    echo "WARNING: DE worker not detected after restart — check ${DE_WORKER_LOG:-the worker log}"
    exit 1
fi
