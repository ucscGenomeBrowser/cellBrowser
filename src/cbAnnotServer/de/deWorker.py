#!/usr/bin/env python3
"""
Differential-expression worker daemon (Redmine #24912, #38664).

Takes jobs from the cbDeJobs table in the same database the web service uses
(CBANNOT_DATABASE_URI), oldest first, one at a time, and runs each with the
compute kernel (runDeJob.py). Progress and the gzipped result go back into the
job's row, where the web service reads them for the browser. The web service
can be on any machine that reaches the database; this daemon runs on the one
that has the datasets (hgwdev for cells-test, hgw0 on the RR).

Each job runs in its own subprocess, in its own session, so a crash or OOM in
one job can't take down the daemon, memory is freed when it exits, and a cancel
or timeout can kill it and any children. The subprocess works in a scratch
directory (DE_JOBS_DIR/<jobId>/: spec.json in, status.json and result.json out),
which is removed once the row is updated.

Taking a job is a conditional UPDATE (state queued -> running), so two workers
could share a queue safely, though one is the plan.

Config via environment:
    CBANNOT_DATABASE_URI  the database, as for the web service (required)
    DE_JOBS_DIR       scratch directory for running jobs (default /cluster/home/otto/cellsServer/deJobs)
    DE_JOB_LOG        append-only TSV, one row per finished job (default deJobs.tsv next to DE_JOBS_DIR)
    DE_CBBUILD_DIR    cbBuild web output root (dataset dirs; runDeJob reads it)
    DE_WORKER_PYTHON  python with numpy/scipy/pandas for runDeJob (default this interpreter)
    DE_POLL_SEC       how often to look for a new job, seconds (default 2)
    DE_JOB_TIMEOUT    per-job wall-clock cap, seconds (default 600)
    DE_CANCEL_POLL    how often a running job is checked for a cancel, seconds (default 1)
    DE_QUEUE_STALE_SEC  a queued job older than this is dropped, not run: nobody is
                      waiting for it any more (default 3600, the browser's limit)
    DE_RETENTION_DAYS delete finished jobs older than this (default 7; 0 = keep)
    DE_WORKER_PIDFILE write our PID here on start, remove on clean exit (optional)
    DE_WORKER_HEARTBEAT  touch this file every loop so a watchdog can tell a hung
                         worker from a healthy idle one (optional)
"""
import gzip
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, text

HERE = os.path.dirname(os.path.abspath(__file__))
JOBS_DIR   = os.environ.get("DE_JOBS_DIR", "/cluster/home/otto/cellsServer/deJobs")
DE_JOB_LOG = os.environ.get("DE_JOB_LOG",
    os.path.join(os.path.dirname(JOBS_DIR.rstrip("/")) or ".", "deJobs.tsv"))
PYTHON     = os.environ.get("DE_WORKER_PYTHON", sys.executable)
POLL_SEC   = float(os.environ.get("DE_POLL_SEC", "2"))
JOB_TIMEOUT= int(os.environ.get("DE_JOB_TIMEOUT", "600"))
CANCEL_POLL= float(os.environ.get("DE_CANCEL_POLL", "1"))
QUEUE_STALE= int(os.environ.get("DE_QUEUE_STALE_SEC", "3600"))
RETENTION  = int(os.environ.get("DE_RETENTION_DAYS", "7"))
PIDFILE    = os.environ.get("DE_WORKER_PIDFILE")
HEARTBEAT  = os.environ.get("DE_WORKER_HEARTBEAT")
HOST       = socket.gethostname().split(".")[0]
ME         = "%s:%d" % (HOST, os.getpid())

_stop = False
_engine = None


def db():
    """The database engine, made on first use. Short transactions only, so
    every query sees rows the web service committed since the last one."""
    global _engine
    if _engine is None:
        uri = os.environ.get("CBANNOT_DATABASE_URI")
        if not uri:
            raise SystemExit("set CBANNOT_DATABASE_URI (the web service's database)")
        args = {}
        if uri.startswith("mysql"):
            args["connect_args"] = {"init_command":
                "SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'"}
        _engine = create_engine(uri, pool_pre_ping=True, pool_recycle=3600, **args)
    return _engine


def sql(query, **params):
    with db().begin() as c:
        return c.execute(text(query), params)


def now():
    """UTC without a timezone, like the web service's datetime.utcnow() columns.
    (utcnow itself is deprecated in Python 3.12+ and would warn on every call.)"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _beat():
    """Touch the heartbeat file so the watchdog can tell a hung worker from an
    idle one. Best-effort; a failure here must not stop the loop."""
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


# ---- the queue ------------------------------------------------------------

def recoverOrphans():
    """At startup: a job this host was running when its worker died will never
    finish. Mark it failed so the browser stops waiting."""
    n = sql("UPDATE cbDeJobs SET state='failed', finished_at=:t, "
            "error='The server restarted while this comparison was running. Please run it again.' "
            "WHERE state='running' AND worker LIKE :h", t=now(), h=HOST + ":%").rowcount
    if n:
        log("marked %d job(s) left running by an earlier worker on %s as failed" % (n, HOST))
    # and their scratch dirs (only names this worker makes, nothing else there)
    for name in os.listdir(JOBS_DIR):
        if re.match(r"^de_[0-9a-f]{12}$", name):
            shutil.rmtree(os.path.join(JOBS_DIR, name), ignore_errors=True)


def expireOld():
    """Drop queued jobs nobody is waiting for any more (the browser stops
    polling after an hour), e.g. after the worker was down for a while."""
    n = sql("UPDATE cbDeJobs SET state='failed', finished_at=:t, "
            "error='This comparison waited too long to start. Please run it again.' "
            "WHERE state='queued' AND created_at < :cut",
            t=now(), cut=now() - timedelta(seconds=QUEUE_STALE)).rowcount
    if n:
        log("dropped %d queued job(s) older than %ds" % (n, QUEUE_STALE))


def takeNext():
    """Claim the oldest queued job. Returns (job_id, spec dict) or None."""
    row = sql("SELECT job_id FROM cbDeJobs WHERE state='queued' ORDER BY id LIMIT 1").first()
    if row is None:
        return None
    jobId = row[0]
    took = sql("UPDATE cbDeJobs SET state='running', worker=:me, started_at=:t, stage='Starting' "
               "WHERE job_id=:j AND state='queued'", me=ME, t=now(), j=jobId).rowcount
    if took != 1:          # canceled or taken in the meantime
        return None
    spec = sql("SELECT spec FROM cbDeJobs WHERE job_id=:j", j=jobId).scalar()
    return jobId, json.loads(spec)


def cancelRequested(jobId):
    return bool(sql("SELECT cancel_requested FROM cbDeJobs WHERE job_id=:j", j=jobId).scalar())


def pushProgress(jobId, st):
    sql("UPDATE cbDeJobs SET stage=:stage, step=:step, n_steps=:n, progress=:p "
        "WHERE job_id=:j AND state='running'",
        stage=(st.get("stage") or None) and str(st["stage"])[:255],
        step=st.get("step"), n=st.get("nSteps"), p=st.get("progress"), j=jobId)


def finish(jobId, state, error=None, result=None, elapsed=None):
    vals = dict(j=jobId, state=state, error=error, t=now(), el=elapsed,
                res=None, n1=None, n2=None, ng=None)
    if result is not None:
        vals.update(res=gzip.compress(json.dumps(result).encode(), 6),
                    n1=result.get("n_pop1"), n2=result.get("n_pop2"),
                    ng=len(result["genes"]) if isinstance(result.get("genes"), list) else None)
    sql("UPDATE cbDeJobs SET state=:state, error=:error, finished_at=:t, elapsed=:el, "
        "result=:res, n_pop1=:n1, n_pop2=:n2, n_genes=:ng WHERE job_id=:j", **vals)


def sweepRetention():
    if RETENTION <= 0:
        return
    n = sql("DELETE FROM cbDeJobs WHERE state IN ('done','failed','canceled') AND created_at < :cut",
            cut=now() - timedelta(days=RETENTION)).rowcount
    if n:
        log("retention: removed %d finished job(s) older than %d days" % (n, RETENTION))


# ---- running one job ------------------------------------------------------

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


def _readJsonFile(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def runJob(jobId, spec):
    """Run one job in a subprocess (runDeJob.py <jobId>) in a scratch dir,
    copying its progress to the row, checking for a cancel and the timeout."""
    jobdir = os.path.join(JOBS_DIR, jobId)
    shutil.rmtree(jobdir, ignore_errors=True)
    os.makedirs(jobdir)
    with open(os.path.join(jobdir, "spec.json"), "w") as fh:
        json.dump(spec, fh)

    env = dict(os.environ)
    env["DE_JOBS_DIR"] = JOBS_DIR
    cmd = [PYTHON, os.path.join(HERE, "runDeJob.py"), jobId]
    log("running job %s (%s)" % (jobId, spec.get("dataset")))
    t0 = time.time()
    statusPath = os.path.join(jobdir, "status.json")
    lastStatus = None
    # child output goes to a file, not a PIPE, so a chatty job can't deadlock
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
                pass
            try:
                if cancelRequested(jobId):
                    log("job %s canceled, killing it" % jobId)
                    _killTree(p)
                    outcome = "canceled"
                    break
                st = _readJsonFile(statusPath)
                if st and st != lastStatus:
                    pushProgress(jobId, st)
                    lastStatus = st
            except Exception as e:      # database hiccup: keep the job running
                log("job %s: could not reach the database: %s" % (jobId, e))
            if time.time() - t0 > JOB_TIMEOUT:
                log("job %s TIMED OUT after %ds, killing it" % (jobId, JOB_TIMEOUT))
                _killTree(p)
                outcome = "timeout"
                break

    runtime = time.time() - t0
    st = _readJsonFile(statusPath) or {}
    res = None
    if outcome == "canceled":
        finish(jobId, "canceled", "canceled by the user", elapsed=runtime)
        logStatus = "canceled"
    elif outcome == "timeout":
        finish(jobId, "failed", "The comparison took longer than the %d minute limit."
               % (JOB_TIMEOUT // 60), elapsed=runtime)
        logStatus = "timeout"
    else:
        res = _readJsonFile(os.path.join(jobdir, "result.json"))
        if p.returncode == 0 and res is not None and st.get("state") != "failed":
            finish(jobId, "done", result=res, elapsed=st.get("elapsed") or runtime)
            logStatus = "done"
        else:
            finish(jobId, "failed", st.get("error") or "The comparison failed.", elapsed=runtime)
            logStatus = "failed"
            try:
                with open(logPath, "rb") as fh:
                    tail = fh.read()[-500:].decode(errors="replace")
                log("job %s output tail: %s" % (jobId, tail))
            except OSError:
                pass
        log("job %s %s rc=%s in %.1fs" % (jobId, logStatus, p.returncode, runtime))
    _logJob(jobId, spec, res or {}, logStatus, runtime)
    shutil.rmtree(jobdir, ignore_errors=True)


# ---- per-job TSV log ------------------------------------------------------

_LOG_HEADER = ("timestamp\tjobId\trequester\tremote\tdataset\tfield\tgroupA\t"
               "groupB\tmethod\tn_pop1\tn_pop2\tn_genes\truntime_s\tstatus")


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
            val = ("+".join(str(v) for v in f["values"])
                   if f.get("values") is not None else f.get("value"))
            s += " [%s=%s]" % (f.get("field"), val)
        return s
    return ""


def _tsv(v):
    return str(v).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def _logJob(jobId, spec, res, status, runtime_s):
    """Append one TSV row for a finished job (any outcome). Best-effort."""
    meta = spec.get("_meta") or {}
    p1, p2 = spec.get("pop1"), spec.get("pop2")
    row = [
        time.strftime("%Y-%m-%d %H:%M:%S"),
        jobId,
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


# ---- main loop ------------------------------------------------------------

def main():
    signal.signal(signal.SIGTERM, _onsig)
    signal.signal(signal.SIGINT, _onsig)
    if PIDFILE:
        try:
            with open(PIDFILE, "w") as fh:
                fh.write("%d\n" % os.getpid())
        except OSError as e:
            log("could not write pidfile %s: %s" % (PIDFILE, e))
    os.makedirs(JOBS_DIR, exist_ok=True)
    log("starting as %s; database %s; python=%s" % (ME, db().url.render_as_string(hide_password=True), PYTHON))
    recovered = False
    lastSweep = 0
    try:
        while not _stop:
            _beat()
            try:
                if not recovered:
                    recoverOrphans()
                    recovered = True
                if time.time() - lastSweep > 3600:
                    sweepRetention()
                    lastSweep = time.time()
                expireOld()
                job = takeNext()
            except Exception as e:
                # database down or unreachable: keep trying, quietly
                log("database error: %s" % str(e).splitlines()[0][:200])
                job = None
                time.sleep(max(POLL_SEC, 10))
                continue
            if job is None:
                time.sleep(POLL_SEC)
                continue
            try:
                runJob(*job)
            except Exception as e:
                log("job %s: worker error: %s" % (job[0], e))
                try:
                    finish(job[0], "failed", "The comparison failed on the server.")
                except Exception:
                    pass
            _beat()   # a long job shouldn't look hung to the watchdog
    finally:
        if PIDFILE:
            try:
                os.remove(PIDFILE)
            except OSError:
                pass
    log("stopped")


if __name__ == "__main__":
    main()
