#!/usr/bin/env python3
"""
Differential-expression worker daemon (Redmine #24912).

Long-running loop that watches the shared job queue on /hive, claims pending
jobs, and runs the compute kernel (runDeJob.py) once per job. Designed for the
"no parasol" model: a single server (hgcompute-08) processing jobs locally, run
under the `otto` service account.

Transport is the filesystem: the Cell Browser backend (or the dev-side Flask
service) writes DE_JOBS_DIR/<jobId>/spec.json; this daemon notices it, runs the
job, and the kernel writes status.json + result.json to the same directory. No
network, no scheduler — hgwdev and hgcompute-08 share /hive.

Each job runs in its own subprocess so a crash or OOM in one job can't take down
the daemon, and per-job memory (the AnnData load) is freed when it exits.

Claiming is restart-safe: a job is claimed by atomically creating a `worker.lock`
(O_EXCL). A job is "pending" if it has spec.json, no result, and either no lock
or a stale lock (worker died mid-job).

Config via environment (all optional):
    DE_JOBS_DIR       job queue root         (default /hive/data/inside/cells/deJobs)
    DE_CBBUILD_DIR    cbBuild web output root (dataset dirs; runDeJob reads it)
    DE_WORKER_PYTHON  python that has scanpy (default this interpreter)
    DE_POLL_SEC       queue poll interval    (default 2)
    DE_JOB_TIMEOUT    per-job wall-clock cap, seconds (default 600)
    DE_STALE_LOCK_SEC reclaim a lock older than this (default 1800)
    DE_RETENTION_DAYS delete finished job dirs older than this (default 7; 0=keep)
    DE_WORKER_PIDFILE write our PID here on start, remove on clean exit (optional)
    DE_WORKER_HEARTBEAT  touch this file every loop so a watchdog can tell a hung
                         worker from a healthy idle one (optional)
"""
import os
import sys
import json
import time
import signal
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
JOBS_DIR   = os.environ.get("DE_JOBS_DIR", "/hive/data/inside/cells/deJobs")
# Append-only TSV, one row per finished job: who ran what, on which data, how long.
DE_JOB_LOG = os.environ.get("DE_JOB_LOG",
    os.path.join(os.path.dirname(JOBS_DIR.rstrip("/")) or ".", "deJobs.tsv"))
PYTHON     = os.environ.get("DE_WORKER_PYTHON", sys.executable)
POLL_SEC   = float(os.environ.get("DE_POLL_SEC", "2"))
JOB_TIMEOUT= int(os.environ.get("DE_JOB_TIMEOUT", "600"))
STALE_LOCK = int(os.environ.get("DE_STALE_LOCK_SEC", "1800"))
RETENTION  = int(os.environ.get("DE_RETENTION_DAYS", "7"))
CANCEL_POLL= float(os.environ.get("DE_CANCEL_POLL", "1"))  # how often a running job checks cancel.flag
PIDFILE    = os.environ.get("DE_WORKER_PIDFILE")
HEARTBEAT  = os.environ.get("DE_WORKER_HEARTBEAT")

_stop = False


def _beat():
    """Touch the heartbeat file so the watchdog can distinguish a healthy idle
    worker from a hung one. Best-effort; a failure here must not stop the loop."""
    if not HEARTBEAT:
        return
    try:
        with open(HEARTBEAT, "a"):
            os.utime(HEARTBEAT, None)
    except OSError:
        pass


def log(msg):
    sys.stdout.write("[deWorker %s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    sys.stdout.flush()


def _onsig(signum, frame):
    global _stop
    _stop = True
    log("caught signal %d, finishing current job then exiting" % signum)


def isFinished(jobdir):
    """A job is finished if it has a result, or a terminal status."""
    if os.path.isfile(os.path.join(jobdir, "result.json")):
        return True
    st = _readStatusState(jobdir)
    return st in ("done", "failed", "canceled")


def _readStatusState(jobdir):
    import json
    p = os.path.join(jobdir, "status.json")
    if not os.path.isfile(p):
        return None
    try:
        with open(p) as fh:
            return json.load(fh).get("state")
    except Exception:
        return None


def claim(jobdir):
    """Atomically claim a job by creating worker.lock with O_EXCL. Returns True if
    we now own it. Reclaims a stale lock (previous worker died)."""
    lock = os.path.join(jobdir, "worker.lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        os.write(fd, ("%d\n" % os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        # someone holds it — reclaim only if it's stale AND the job never finished
        try:
            age = time.time() - os.path.getmtime(lock)
        except OSError:
            return False
        if age > STALE_LOCK and not isFinished(jobdir) and _readStatusState(jobdir) != "running":
            log("reclaiming stale lock on %s (age %ds)" % (os.path.basename(jobdir), int(age)))
            try:
                os.utime(lock, None)  # refresh so we own the window
                return True
            except OSError:
                return False
        return False


def pendingJobs():
    """Job dirs that have a spec, aren't finished, and are claimable, oldest first."""
    if not os.path.isdir(JOBS_DIR):
        return []
    out = []
    for name in os.listdir(JOBS_DIR):
        d = os.path.join(JOBS_DIR, name)
        if not os.path.isdir(d):
            continue
        if not os.path.isfile(os.path.join(d, "spec.json")):
            continue
        if isFinished(d):
            continue
        out.append(d)
    out.sort(key=lambda d: os.path.getmtime(os.path.join(d, "spec.json")))
    return out


def _killTree(p):
    """Stop the job subprocess and any children (it gets its own session, so we
    can signal the whole process group). SIGTERM, then SIGKILL if it lingers."""
    def _pg(sig):
        try:
            os.killpg(os.getpgid(p.pid), sig)
        except Exception:
            try:
                p.send_signal(sig)
            except Exception:
                pass
    _pg(signal.SIGTERM)
    try:
        p.wait(timeout=5)
    except Exception:
        _pg(signal.SIGKILL)
        try:
            p.wait(timeout=5)
        except Exception:
            pass


def runJob(jobdir):
    """Run one job in a subprocess via runDeJob.py <jobId>, polling for a cancel
    request (cancel.flag written by the API) and the per-job timeout. Each job runs
    in its own session so we can kill it and any children on cancel/timeout."""
    jobId = os.path.basename(jobdir)
    cancelFlag = os.path.join(jobdir, "cancel.flag")
    if os.path.exists(cancelFlag):
        log("job %s canceled before start" % jobId)
        _writeState(jobdir, "canceled", "canceled before it started")
        _logJob(jobdir, "canceled", 0.0)
        return

    env = dict(os.environ)
    env["DE_JOBS_DIR"] = JOBS_DIR
    cmd = [PYTHON, os.path.join(HERE, "runDeJob.py"), jobId]
    log("running job %s" % jobId)
    t0 = time.time()
    # write child output to a per-job log file (not a PIPE) so a chatty job can't
    # deadlock on a full pipe while we poll
    logPath = os.path.join(jobdir, "run.log")
    with open(logPath, "wb") as logf:
        p = subprocess.Popen(cmd, env=env, stdout=logf, stderr=subprocess.STDOUT,
                             start_new_session=True)
        outcome = "done"
        while True:
            try:
                p.wait(timeout=CANCEL_POLL)
                break  # finished on its own
            except subprocess.TimeoutExpired:
                if os.path.exists(cancelFlag):
                    log("job %s canceled — killing it" % jobId)
                    _killTree(p)
                    outcome = "canceled"
                    break
                if time.time() - t0 > JOB_TIMEOUT:
                    log("job %s TIMED OUT after %ds — killing it" % (jobId, JOB_TIMEOUT))
                    _killTree(p)
                    outcome = "timeout"
                    break

    runtime = time.time() - t0
    if outcome == "canceled":
        _writeState(jobdir, "canceled", "canceled by the user")
        logStatus = "canceled"
    elif outcome == "timeout":
        _writeState(jobdir, "failed", "job exceeded the %d s time limit" % JOB_TIMEOUT)
        logStatus = "timeout"
    else:
        ok = (p.returncode == 0)
        logStatus = "done" if ok else "failed"
        log("job %s finished rc=%d in %.1fs" % (jobId, p.returncode, runtime))
        if not ok:
            try:
                with open(logPath, "rb") as fh:
                    tail = fh.read()[-500:].decode(errors="replace")
                log("job %s output tail: %s" % (jobId, tail))
            except OSError:
                pass
    _logJob(jobdir, logStatus, runtime)


def _writeState(jobdir, state, error=None):
    tmp = os.path.join(jobdir, "status.json.tmp")
    with open(tmp, "w") as fh:
        json.dump({"state": state, "error": error}, fh)
    os.replace(tmp, os.path.join(jobdir, "status.json"))


# ---- per-job TSV log ------------------------------------------------------

_LOG_HEADER = ("timestamp\tjobId\trequester\tremote\tdataset\tfield\tgroupA\t"
               "groupB\tmethod\tn_pop1\tn_pop2\tn_genes\truntime_s\tstatus")


def _readJsonFile(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def _popField(p):
    return p.get("field", "") if isinstance(p, dict) else ""


def _popSummary(p):
    """Compact human summary of a population selector for the log."""
    if p == "rest":
        return "rest"
    if isinstance(p, dict):
        if p.get("type") == "cellIds" or "ids" in p:
            s = "cells:%d" % len(p.get("ids", []))
        else:
            s = "+".join(str(v) for v in p.get("values", []))
        f = p.get("filter")
        if f and f.get("field"):
            s += " [%s=%s]" % (f.get("field"), f.get("value"))
        return s
    return ""


def _tsv(v):
    return str(v).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def _logJob(jobdir, status, runtime_s):
    """Append one TSV row for a finished job (any outcome). Best-effort."""
    spec = _readJsonFile(os.path.join(jobdir, "spec.json")) or {}
    res = _readJsonFile(os.path.join(jobdir, "result.json")) or {}
    meta = spec.get("_meta") or {}
    p1, p2 = spec.get("pop1"), spec.get("pop2")
    row = [
        time.strftime("%Y-%m-%d %H:%M:%S"),
        os.path.basename(jobdir),
        meta.get("requester") or "",
        meta.get("remote") or "",
        spec.get("dataset") or "",
        _popField(p1) or _popField(p2) or "",
        _popSummary(p1),
        _popSummary(p2),
        spec.get("method") or "",
        res.get("n_pop1", ""),
        res.get("n_pop2", ""),
        len(res["genes"]) if isinstance(res.get("genes"), list) else "",
        "%.2f" % runtime_s,
        status,
    ]
    line = "\t".join(_tsv(c) for c in row)
    try:
        newfile = not os.path.exists(DE_JOB_LOG)
        with open(DE_JOB_LOG, "a") as fh:
            if newfile:
                fh.write(_LOG_HEADER + "\n")
            fh.write(line + "\n")
    except OSError as e:
        log("could not append to job log %s: %s" % (DE_JOB_LOG, e))


def sweepRetention():
    """Delete finished job dirs older than RETENTION days."""
    if RETENTION <= 0 or not os.path.isdir(JOBS_DIR):
        return
    cutoff = time.time() - RETENTION * 86400
    import shutil
    for name in os.listdir(JOBS_DIR):
        d = os.path.join(JOBS_DIR, name)
        if not os.path.isdir(d) or not isFinished(d):
            continue
        try:
            if os.path.getmtime(d) < cutoff:
                shutil.rmtree(d)
                log("retention: removed %s" % name)
        except OSError:
            pass


def main():
    signal.signal(signal.SIGTERM, _onsig)
    signal.signal(signal.SIGINT, _onsig)
    if PIDFILE:
        try:
            with open(PIDFILE, "w") as fh:
                fh.write("%d\n" % os.getpid())
        except OSError as e:
            log("could not write pidfile %s: %s" % (PIDFILE, e))
    log("starting; queue=%s python=%s" % (JOBS_DIR, PYTHON))
    last_sweep = 0
    try:
        while not _stop:
            _beat()
            did = False
            for jobdir in pendingJobs():
                if _stop:
                    break
                if claim(jobdir):
                    runJob(jobdir)
                    _beat()   # a long job shouldn't look hung to the watchdog
                    did = True
            now = time.time()
            if now - last_sweep > 3600:
                sweepRetention()
                last_sweep = now
            if not did:
                time.sleep(POLL_SEC)
    finally:
        if PIDFILE:
            try:
                os.remove(PIDFILE)
            except OSError:
                pass
    log("stopped")


if __name__ == "__main__":
    main()
