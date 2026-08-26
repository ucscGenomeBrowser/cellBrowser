#!/bin/bash
# Cron keep-alive for the DE worker daemon, the fallback for hosts where the
# systemd unit (deWorker.service) cannot be installed. Run once a minute from the
# otto crontab, and once at boot:
#
#   * * * * *  DE_ENV_FILE=/path/de.env /ABS/PATH/de/deploy/deWorkerWatchdog.sh >> /path/logs/deWorker-watchdog.log 2>&1
#   @reboot    DE_ENV_FILE=/path/de.env /ABS/PATH/de/deploy/deWorkerWatchdog.sh >> /path/logs/deWorker-watchdog.log 2>&1
#
# Unlike the cbAnnotServer watchdog, the worker has no HTTP endpoint, so health is
# "pidfile process alive AND heartbeat fresh". The heartbeat catches a hung worker
# (process up but loop stuck); a running job blocks the loop for up to
# DE_JOB_TIMEOUT, so the staleness threshold is derived to exceed it.
set -uo pipefail

if [ -n "${DE_ENV_FILE:-}" ] && [ -f "${DE_ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    . "${DE_ENV_FILE}"
    set +a
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PIDFILE="${DE_WORKER_PIDFILE:-/tmp/deWorker.pid}"
HEARTBEAT="${DE_WORKER_HEARTBEAT:-/tmp/deWorker.heartbeat}"
JOB_TIMEOUT="${DE_JOB_TIMEOUT:-600}"
# Allow a live job to hold the loop for its whole timeout, plus a margin, before
# we call the worker hung. Override with DE_WORKER_MAXSTALE if you know better.
MAXSTALE="${DE_WORKER_MAXSTALE:-$((JOB_TIMEOUT + 300))}"

alive=0
pid=""
if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        alive=1
    fi
fi

fresh=0
if [ -f "$HEARTBEAT" ]; then
    now="$(date +%s)"
    beat="$(stat -c %Y "$HEARTBEAT" 2>/dev/null || echo 0)"
    if [ $((now - beat)) -lt "$MAXSTALE" ]; then
        fresh=1
    fi
fi

if [ "$alive" = 1 ] && [ "$fresh" = 1 ]; then
    exit 0   # healthy, nothing to do
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') deWorker unhealthy (alive=$alive fresh=$fresh), restarting"

# Stop a stale/hung process from a previous start, if any.
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 3
    kill -9 "$pid" 2>/dev/null || true
fi

nohup "${here}/runDeWorker.sh" >> "${DE_WORKER_LOG:-/tmp/deWorker.log}" 2>&1 &
