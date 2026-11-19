"""
Differential-expression submit / status / cancel API (Redmine #24912, #38664).

The job queue is a table, cbDeJobs (models.DeJob). This service, which also
handles sign-in, adds a row for each comparison and reads it back when the
browser asks for status. The worker (deWorker.py), on whichever machine has the
datasets, takes queued rows in order, runs them, and writes progress and the
gzipped result into the row. The two only share the database, so every web
node can take jobs and one machine runs them.

The frontend (cellBrowser.js deSubmitJobHttp) speaks one URL:
    POST   <deUrl>            body = the builder spec  -> {jobId, status}
    GET    <deUrl>?jobId=...                            -> {status, stage, ...,
                                                            result:{genes,n_pop1,n_pop2,filters}}
    DELETE <deUrl>?jobId=...                            -> cancel

Settings (app.config or environment):
    DE_DATA_HOSTS              hosts a job's dataUrl may point at (see deCache.checkDataUrl)
    DE_MAX_JOBS_PER_REQUESTER  queued+running jobs one person may have (2)
    DE_MAX_JOBS_TOTAL          queued+running jobs across everyone (20)
    DE_QUEUE_STALE_SEC         unfinished jobs older than this stop counting
                               toward those limits (3600)

The builder spec (from deBuildSpec) is translated to the worker's spec shape
(pop1/pop2 selectors + method + parameters) before it is stored.
"""
import gzip
import json
import os
import re
import secrets
from datetime import datetime, timedelta

from flask import Blueprint, request, jsonify, current_app

from extensions import db
from models import DeJob

try:
    from . import deCache
except ImportError:          # run standalone
    import deCache

bp = Blueprint("de", __name__)

# only the Wilcoxon kernel exists in Phase 1
_TEST_TO_METHOD = {"wilcox": "wilcoxon", "wilcoxon": "wilcoxon"}

_FINISHED = ("done", "failed", "canceled")


def _cfg(key, default=None):
    return current_app.config.get(key) or os.environ.get(key) or default


def _cfgInt(key, default):
    try:
        return int(_cfg(key, default))
    except (TypeError, ValueError):
        return default


# A dataset name is a docroot-relative path, possibly collection-nested (a/b).
# Anything else (absolute paths, "..") could walk the worker's local-docroot
# read out of the docroot.
_DATASET_RE = re.compile(r"^[A-Za-z0-9_.+-]+(/[A-Za-z0-9_.+-]+)*$")


def _checkSpec(fe):
    """Return None if a builder spec is safe to queue, else a reason it isn't."""
    ds = fe.get("dataset")
    if not isinstance(ds, str) or not _DATASET_RE.match(ds) \
            or any(p in (".", "..") for p in ds.split("/")):
        return "bad dataset name"
    dataUrl = fe.get("dataUrl")
    if dataUrl is not None:
        if not isinstance(dataUrl, str):
            return "bad dataUrl"
        return deCache.checkDataUrl(dataUrl, deCache.dataHosts(_cfg("DE_DATA_HOSTS")))
    return None


def translateSpec(fe):
    """Builder spec (deBuildSpec) -> worker spec.json.

    Builder: {dataset, field, groupA:{values,filter}, groupB:'rest'|{values,filter},
              test, minPct, subsample, lfcCut, padjCut}
    Worker : {dataset, pop1:{type:'field',field,values,filter?}, pop2:'rest'|{...},
              method, parameters:{min_cells}}
    lfcCut/padjCut are client-side display filters and are intentionally NOT sent
    to compute (the table re-filters locally); minPct/subsample are Phase-2 TODO.
    """
    field = fe["field"]

    def pop(sideKey):
        g = fe.get(sideKey)
        if g == "rest":
            return "rest"
        # A group on a custom-annotation field arrives as explicit cell barcodes
        # (the field isn't in meta.tsv); a group on a real metadata field arrives
        # as field+values for the worker to resolve.
        if g.get("ids") is not None:
            sel = {"type": "cellIds", "ids": g["ids"]}
        else:
            sel = {"type": "field", "field": field, "values": g.get("values", [])}
        gf = g.get("filter")
        if gf and gf.get("field"):
            flt = {"field": gf["field"]}
            if gf.get("values") is not None:     # multi-value filter (new)
                flt["values"] = list(gf["values"])
            else:                                # single value (back-compat)
                flt["value"] = gf.get("value", "")
            sel["filter"] = flt
        return sel

    test = (fe.get("test") or "wilcox").lower()
    method = _TEST_TO_METHOD.get(test, test)  # unimplemented tests -> worker errors clearly

    parameters = {"min_cells": 25}   # matches the builder's 25-cell floor
    # Detection floor: minPct is a PRE-test filter (defines the tested universe, so
    # the FDR/downloaded set match what the table shows). lfcCut/padjCut stay
    # client-side significance thresholds — filtering genes by their p-value before
    # BH would bias the correction, so those are deliberately NOT sent.
    if fe.get("minPct") is not None:
        parameters["min_pct"] = float(fe["minPct"])
    # Gene-category prefilters (scanpy's mt / ribo / hb trio). Only forwarded when
    # the builder sends them, so the kernel's defaults apply otherwise (all on).
    # See wilcoxon_np.py _GENE_CATEGORIES.
    for feKey, paramKey in (("excludeMito", "exclude_mito"),
                            ("excludeRibo", "exclude_ribo"),
                            ("excludeHemo", "exclude_hemo")):
        if feKey in fe:
            parameters[paramKey] = bool(fe[feKey])

    out = {
        "dataset": fe["dataset"],
        "pop1": pop("groupA"),
        "pop2": pop("groupB"),
        "method": method,
        "parameters": parameters,
    }
    # Absolute dataset URL the browser loaded from. The worker uses it to fetch
    # the served expression files over HTTP (see deCache.py), so a compute host
    # with no docroot can still run the job. Multiple web hosts share one queue,
    # so this must travel per-job rather than be a single worker-side setting.
    if fe.get("dataUrl"):
        out["dataUrl"] = fe["dataUrl"]
    return out


def _localRequester():
    """Who is asking, as seen by this instance: the logged-in email if there is a
    session, else the client IP. Behind Apache the client IP is the LAST
    X-Forwarded-For entry, the one our own proxy appended; earlier entries come
    from the client and can say anything."""
    user = None
    try:
        from flask_login import current_user
        if current_user and current_user.is_authenticated:
            user = getattr(current_user, "email", None) or ("user#%s" % current_user.get_id())
    except Exception:
        user = None
    xff = request.headers.get("X-Forwarded-For", "")
    remote = (xff.split(",")[-1].strip() if xff else request.remote_addr) or ""
    return {"requester": user, "remote": remote}


def _requesterKey(who):
    """The identity the per-person limit counts: the account if signed in,
    else the IP address."""
    return who.get("requester") or who.get("remote") or "unknown"


def _queueBusy(key):
    """Return a message if the queue is too full to take another job from `key`,
    else None. Counts queued and running jobs younger than DE_QUEUE_STALE_SEC,
    so a job stuck by a crash can't block anyone for long. Two submits at the
    same instant can both get in; the limits only exist to stop one person
    from filling the queue, so that's fine."""
    perUser = _cfgInt("DE_MAX_JOBS_PER_REQUESTER", 2)
    total = _cfgInt("DE_MAX_JOBS_TOTAL", 20)
    since = datetime.utcnow() - timedelta(seconds=_cfgInt("DE_QUEUE_STALE_SEC", 3600))
    live = db.session.query(DeJob).filter(DeJob.state.in_(("queued", "running")),
                                          DeJob.created_at >= since)
    nMine = live.filter(DeJob.requester == key).count() if perUser > 0 else 0
    if perUser > 0 and nMine >= perUser:
        return ("You already have %d comparisons running or waiting. "
                "Please wait for one to finish." % nMine)
    if total > 0 and live.count() >= total:
        return "The server is busy with other comparisons right now. Please try again in a few minutes."
    return None


def _submit(feSpec):
    spec = translateSpec(feSpec)
    who = _localRequester()
    key = _requesterKey(who)
    busy = _queueBusy(key)
    if busy:
        return {"status": "failed", "error": busy}, 429
    who["submitted_at"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    spec["_meta"] = who                 # for the worker's job log
    job = DeJob(job_id="de_" + secrets.token_hex(6), state="queued",
                requester=key[:255], remote=(who.get("remote") or "")[:100],
                dataset=spec["dataset"], spec=json.dumps(spec))
    db.session.add(job)
    db.session.commit()
    return {"jobId": job.job_id, "status": "submitted"}, 200


def _job(jobId):
    if not jobId or not isinstance(jobId, str) or len(jobId) > 32:
        return None
    return db.session.query(DeJob).filter_by(job_id=jobId).first()


def _status(jobId):
    job = _job(jobId)
    if job is None:
        return {"status": "failed", "error": "unknown jobId"}
    out = {
        "jobId": job.job_id,
        "status": job.state,
        "stage": job.stage,
        "step": job.step,
        "nSteps": job.n_steps,
        "progress": job.progress,
        "elapsed": job.elapsed,
        "error": job.error,
    }
    if job.state == "queued":
        ahead = db.session.query(DeJob).filter(DeJob.state.in_(("queued", "running")),
                                               DeJob.id < job.id).count()
        out["stage"] = ("Waiting for %d other comparison%s to finish" % (ahead, "" if ahead == 1 else "s")
                        if ahead else "Starting")
    if job.state == "done":
        res = json.loads(gzip.decompress(job.result)) if job.result else {}
        out["result"] = {
            "genes": res.get("genes", []),
            "n_pop1": res.get("n_pop1"),
            "n_pop2": res.get("n_pop2"),
            "filters": res.get("filters"),
        }
    return out


def _cancel(jobId):
    job = _job(jobId)
    if job is None:
        return {"status": "failed", "error": "unknown jobId"}
    now = datetime.utcnow()
    # a queued job is canceled here; the conditional update loses cleanly if the
    # worker took it in the meantime, and then the worker stops it instead
    n = db.session.query(DeJob).filter_by(id=job.id, state="queued").update(
        {"state": "canceled", "error": "canceled before it started", "finished_at": now},
        synchronize_session=False)
    if not n:
        db.session.query(DeJob).filter_by(id=job.id, state="running").update(
            {"cancel_requested": True}, synchronize_session=False)
    db.session.commit()
    return {"jobId": job.job_id, "status": "canceling"}


@bp.route("", methods=["GET", "POST", "DELETE"], strict_slashes=False)
def de():
    if request.method == "POST":
        feSpec = request.get_json(force=True, silent=True) or {}
        why = _checkSpec(feSpec)
        if why:
            return jsonify({"status": "failed", "error": why}), 400
        try:
            body, code = _submit(feSpec)
        except (KeyError, TypeError, AttributeError) as e:
            return jsonify({"status": "failed", "error": "bad request (%s)" % e}), 400
        return jsonify(body), code
    if request.method == "DELETE":
        return jsonify(_cancel(request.args.get("jobId")))
    return jsonify(_status(request.args.get("jobId")))
