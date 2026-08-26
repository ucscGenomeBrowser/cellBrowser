#!/bin/bash
# Launch the Cell Browser DE worker daemon (deWorker.py) with the deploy env.
#
# Sources an optional env file (DE_ENV_FILE) for the queue location, the scanpy
# python, pidfile/heartbeat paths, etc., then execs the worker so the process the
# watchdog/systemd tracks IS the python daemon (not a wrapper shell).
#
#   DE_ENV_FILE=/hive/data/inside/cells/cbAnnotServer/de.env  runDeWorker.sh
set -uo pipefail

if [ -n "${DE_ENV_FILE:-}" ] && [ -f "${DE_ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    . "${DE_ENV_FILE}"
    set +a
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The python that has scanpy/anndata/scipy. Point DE_WORKER_PYTHON at the shared,
# otto-readable env; falls back to whatever python3 is on PATH.
: "${DE_WORKER_PYTHON:=python3}"

exec "${DE_WORKER_PYTHON}" "${here}/../deWorker.py"
