"""
Differential-expression submit/poll API (Redmine #24912).

One Flask blueprint, two modes (chosen by config), so there is a single codebase
for both tiers of the firewall-split deployment:

  direct  — the instance has /hive: it writes spec.json into the DE job queue and
            reads status.json/result.json back. (dev-side service, runs as otto.)
  proxy   — the instance has no /hive (production): it forwards submit/poll to the
            direct instance over HTTPS.

The frontend (cellBrowser.js deSubmitJobHttp) speaks one URL:
    POST  <deUrl>            body = the builder spec  -> {jobId, status}
    GET   <deUrl>?jobId=...                            -> {status, stage, ...,
                                                           result:{genes,n_pop1,n_pop2}}

Config keys (app.config or env, env wins for the standalone dev server):
    DE_QUEUE_DIR    job queue root (enables *direct* mode)
    DE_RELAY_URL    direct-instance URL (enables *proxy* mode)
    DE_RELAY_KEY    shared secret, set to the same value on both tiers. The proxy
                    sends it as X-DE-Key along with X-DE-Requester (who really
                    asked); the direct side believes X-DE-Requester only when the
                    key matches. It is not required on every request, because
                    browsers on the dev-side sites post to the direct instance
                    without one.
    DE_DATA_HOSTS   hosts a job's dataUrl may point at (see deCache.checkDataUrl)
    DE_MAX_JOBS_PER_REQUESTER  queued+running jobs one person may have (2)
    DE_MAX_JOBS_TOTAL          queued+running jobs across everyone (20)
    DE_QUEUE_STALE_SEC         unfinished jobs older than this stop counting
                               toward those limits (3600)

The builder spec (from deBuildSpec) is translated to the worker's spec.json shape
(pop1/pop2 selectors + method + parameters). de_jobs DB tracking / account tie-in
is added by the production (proxy) instance later; direct mode is pure filesystem.
"""
import os
import re
import hmac
import json
import time
import secrets

from flask import Blueprint, request, jsonify, current_app

try:
    from . import deCache
except ImportError:          # run standalone (python de_submit.py)
    import deCache

bp = Blueprint("de", __name__)

# only the Wilcoxon kernel exists in Phase 1
_TEST_TO_METHOD = {"wilcox": "wilcoxon", "wilcoxon": "wilcoxon"}


def _cfg(key, default=None):
    return current_app.config.get(key) or os.environ.get(key) or default


def _cfgInt(key, default):
    try:
        return int(_cfg(key, default))
    except (TypeError, ValueError):
        return default


# A dataset name is a docroot-relative path, possibly collection-nested (a/b).
# Anything else (absolute paths, "..") could walk the worker's local-docroot
# fallback out of the docroot.
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


# ---- direct mode (has /hive) ---------------------------------------------

def _jobDir(queue, jobId):
    return os.path.join(queue, jobId)


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


def _relayKeyOk():
    """True if the request carries the shared relay key (and one is configured)."""
    key = _cfg("DE_RELAY_KEY")
    got = request.headers.get("X-DE-Key", "")
    return bool(key) and hmac.compare_digest(got.encode(), key.encode())


def _requesterMeta():
    """Who submitted this job, for the DE job log and the queue limits. A request
    relayed by the production instance carries the real user in X-DE-Requester;
    that is believed only when the relay key matches, otherwise anyone could
    claim to be anyone and dodge the per-requester limit."""
    who = None
    if request.headers.get("X-DE-Requester") and _relayKeyOk():
        try:
            fwd = json.loads(request.headers["X-DE-Requester"])
            who = {"requester": (str(fwd["requester"])[:200] if fwd.get("requester") else None),
                   "remote": str(fwd.get("remote") or "")[:100]}
        except (ValueError, TypeError, AttributeError, KeyError):
            who = None
    if who is None:
        who = _localRequester()
    who["submitted_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    return who


def _requesterKey(meta):
    """The identity the per-requester limit counts: the account if signed in,
    else the IP address."""
    return (meta or {}).get("requester") or (meta or {}).get("remote") or "unknown"


def _queueBusy(queue, who):
    """Return a message if the queue is too full to take another job from `who`,
    else None. Counts unfinished jobs: queued or running, not done/failed/canceled.
    Jobs older than DE_QUEUE_STALE_SEC are ignored so a dead job can't block the
    queue forever. Two submits arriving at the same instant can both get in, so
    the limits are approximate. That's fine, since they only exist to stop one
    person from filling the queue."""
    perUser = _cfgInt("DE_MAX_JOBS_PER_REQUESTER", 2)
    total = _cfgInt("DE_MAX_JOBS_TOTAL", 20)
    cutoff = time.time() - _cfgInt("DE_QUEUE_STALE_SEC", 3600)
    nAll = nMine = 0
    try:
        entries = list(os.scandir(queue))
    except OSError:
        return None
    for e in entries:
        spec = os.path.join(e.path, "spec.json")
        try:
            if not e.is_dir() or os.path.getmtime(spec) < cutoff:
                continue
        except OSError:
            continue
        st = _readJson(os.path.join(e.path, "status.json")) or {}
        if st.get("state") in ("done", "failed", "canceled"):
            continue
        nAll += 1
        try:
            with open(os.path.join(e.path, "requester")) as fh:
                if fh.read() == who:
                    nMine += 1
        except OSError:
            pass
    if perUser > 0 and nMine >= perUser:
        return ("You already have %d comparisons running or waiting. "
                "Please wait for one to finish." % nMine)
    if total > 0 and nAll >= total:
        return "The server is busy with other comparisons right now. Please try again in a few minutes."
    return None


def _submitDirect(queue, feSpec, meta=None):
    spec = translateSpec(feSpec)
    if meta:
        spec["_meta"] = meta            # requester/remote/time, for the worker's job log
    jobId = "de_" + secrets.token_hex(6)
    d = _jobDir(queue, jobId)
    os.makedirs(d, exist_ok=True)
    # small side file so _queueBusy can count jobs per requester without
    # parsing every spec (a cellIds spec can be megabytes)
    with open(os.path.join(d, "requester"), "w") as fh:
        fh.write(_requesterKey(meta))
    tmp = os.path.join(d, "spec.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(spec, fh)
    os.replace(tmp, os.path.join(d, "spec.json"))   # atomic; the worker watches for this
    return {"jobId": jobId, "status": "submitted"}


def _statusDirect(queue, jobId):
    if not jobId or "/" in jobId or ".." in jobId:
        return {"status": "failed", "error": "bad jobId"}
    d = _jobDir(queue, jobId)
    if not os.path.isdir(d):
        return {"status": "failed", "error": "unknown jobId"}
    st = _readJson(os.path.join(d, "status.json")) or {"state": "submitted"}
    out = {
        "jobId": jobId,
        "status": st.get("state", "running"),
        "stage": st.get("stage"),
        "step": st.get("step"),
        "nSteps": st.get("nSteps"),
        "progress": st.get("progress"),
        "elapsed": st.get("elapsed"),
        "error": st.get("error"),
    }
    if out["status"] == "done":
        res = _readJson(os.path.join(d, "result.json")) or {}
        out["result"] = {
            "genes": res.get("genes", []),
            "n_pop1": res.get("n_pop1"),
            "n_pop2": res.get("n_pop2"),
            "filters": res.get("filters"),
        }
    return out


def _readJson(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


# ---- proxy mode (no /hive) -----------------------------------------------

def _submitProxy(relay, key, feSpec):
    """Forward a submit. Returns (body, http status) so a refusal from the
    direct side (e.g. 429 queue full) reaches the browser unchanged."""
    import requests
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-DE-Key"] = key
        # who really asked; the direct side only sees this instance's address
        headers["X-DE-Requester"] = json.dumps(_localRequester())
    r = requests.post(relay, json=feSpec, headers=headers, timeout=15)
    return r.json(), r.status_code


def _statusProxy(relay, key, jobId):
    import requests
    headers = {"X-DE-Key": key} if key else {}
    r = requests.get(relay, params={"jobId": jobId}, headers=headers, timeout=15)
    return r.json()


# ---- cancel ---------------------------------------------------------------

def _cancelDirect(queue, jobId):
    if not jobId or "/" in jobId or ".." in jobId:
        return {"status": "failed", "error": "bad jobId"}
    d = _jobDir(queue, jobId)
    if not os.path.isdir(d):
        return {"status": "failed", "error": "unknown jobId"}
    # drop a marker the worker polls for: it kills a running job or skips one that
    # hasn't started yet (see deWorker.runJob).
    try:
        open(os.path.join(d, "cancel.flag"), "w").close()
    except OSError as e:
        return {"status": "failed", "error": "could not request cancel: %s" % e}
    return {"jobId": jobId, "status": "canceling"}


def _cancelProxy(relay, key, jobId):
    import requests
    headers = {"X-DE-Key": key} if key else {}
    r = requests.delete(relay, params={"jobId": jobId}, headers=headers, timeout=15)
    return r.json()


# ---- routes ---------------------------------------------------------------

@bp.route("", methods=["GET", "POST", "DELETE"], strict_slashes=False)
def de():
    relay = _cfg("DE_RELAY_URL")
    queue = _cfg("DE_QUEUE_DIR")
    key = _cfg("DE_RELAY_KEY")

    if request.method == "POST":
        feSpec = request.get_json(force=True, silent=True) or {}
        why = _checkSpec(feSpec)
        if why:
            return jsonify({"status": "failed", "error": why}), 400
        try:
            if relay:
                body, code = _submitProxy(relay, key, feSpec)
                return jsonify(body), code
            if queue:
                meta = _requesterMeta()
                busy = _queueBusy(queue, _requesterKey(meta))
                if busy:
                    return jsonify({"status": "failed", "error": busy}), 429
                return jsonify(_submitDirect(queue, feSpec, meta))
        except KeyError as e:
            return jsonify({"status": "failed", "error": "missing field %s" % e}), 400
        return jsonify({"status": "failed", "error": "DE backend not configured"}), 503

    if request.method == "DELETE":     # cancel a running/queued job
        jobId = request.args.get("jobId")
        if relay:
            return jsonify(_cancelProxy(relay, key, jobId))
        if queue:
            return jsonify(_cancelDirect(queue, jobId))
        return jsonify({"status": "failed", "error": "DE backend not configured"}), 503

    jobId = request.args.get("jobId")
    if relay:
        return jsonify(_statusProxy(relay, key, jobId))
    if queue:
        return jsonify(_statusDirect(queue, jobId))
    return jsonify({"status": "failed", "error": "DE backend not configured"}), 503


# ---- standalone dev server (direct mode) for testing ----------------------

if __name__ == "__main__":
    from flask import Flask
    app = Flask(__name__)
    app.config["DE_QUEUE_DIR"] = os.environ.get("DE_QUEUE_DIR", "/tmp/deJobs")
    os.makedirs(app.config["DE_QUEUE_DIR"], exist_ok=True)
    app.register_blueprint(bp, url_prefix="/api/de")
    app.run(host="127.0.0.1", port=int(os.environ.get("DE_DEV_PORT", "8899")))
