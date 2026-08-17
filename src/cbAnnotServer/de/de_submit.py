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
    DE_RELAY_KEY    shared secret sent as X-DE-Key on the relayed call (optional)

The builder spec (from deBuildSpec) is translated to the worker's spec.json shape
(pop1/pop2 selectors + method + parameters). de_jobs DB tracking / account tie-in
is added by the production (proxy) instance later; direct mode is pure filesystem.
"""
import os
import json
import time
import secrets

from flask import Blueprint, request, jsonify, current_app

bp = Blueprint("de", __name__)

# only the Wilcoxon kernel exists in Phase 1
_TEST_TO_METHOD = {"wilcox": "wilcoxon", "wilcoxon": "wilcoxon"}


def _cfg(key, default=None):
    return current_app.config.get(key) or os.environ.get(key) or default


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
        if g.get("filter") and g["filter"].get("field"):
            sel["filter"] = {"field": g["filter"]["field"], "value": g["filter"].get("value", "")}
        return sel

    test = (fe.get("test") or "wilcox").lower()
    method = _TEST_TO_METHOD.get(test, test)  # unimplemented tests -> worker errors clearly

    parameters = {"min_cells": 25}   # matches the builder's 25-cell floor
    # Gene-category prefilters (scanpy's mt / ribo / hb trio). Only forwarded when
    # the builder sends them, so the kernel's defaults apply otherwise (mito on,
    # ribo/hemo off). See methods/wilcoxon.py _GENE_CATEGORIES.
    for feKey, paramKey in (("excludeMito", "exclude_mito"),
                            ("excludeRibo", "exclude_ribo"),
                            ("excludeHemo", "exclude_hemo")):
        if feKey in fe:
            parameters[paramKey] = bool(fe[feKey])

    return {
        "dataset": fe["dataset"],
        "pop1": pop("groupA"),
        "pop2": pop("groupB"),
        "method": method,
        "parameters": parameters,
    }


# ---- direct mode (has /hive) ---------------------------------------------

def _jobDir(queue, jobId):
    return os.path.join(queue, jobId)


def _submitDirect(queue, feSpec):
    spec = translateSpec(feSpec)
    jobId = "de_" + secrets.token_hex(6)
    d = _jobDir(queue, jobId)
    os.makedirs(d, exist_ok=True)
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
        "elapsed": st.get("elapsed"),
        "error": st.get("error"),
    }
    if out["status"] == "done":
        res = _readJson(os.path.join(d, "result.json")) or {}
        out["result"] = {
            "genes": res.get("genes", []),
            "n_pop1": res.get("n_pop1"),
            "n_pop2": res.get("n_pop2"),
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
    import requests
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-DE-Key"] = key
    r = requests.post(relay, json=feSpec, headers=headers, timeout=15)
    return r.json()


def _statusProxy(relay, key, jobId):
    import requests
    headers = {"X-DE-Key": key} if key else {}
    r = requests.get(relay, params={"jobId": jobId}, headers=headers, timeout=15)
    return r.json()


# ---- routes ---------------------------------------------------------------

@bp.route("", methods=["GET", "POST"], strict_slashes=False)
def de():
    relay = _cfg("DE_RELAY_URL")
    queue = _cfg("DE_QUEUE_DIR")
    key = _cfg("DE_RELAY_KEY")

    if request.method == "POST":
        feSpec = request.get_json(force=True, silent=True) or {}
        try:
            if relay:
                return jsonify(_submitProxy(relay, key, feSpec))
            if queue:
                return jsonify(_submitDirect(queue, feSpec))
        except KeyError as e:
            return jsonify({"status": "failed", "error": "missing field %s" % e}), 400
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
