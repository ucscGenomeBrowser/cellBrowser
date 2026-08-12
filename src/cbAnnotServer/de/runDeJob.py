#!/usr/bin/env python3
"""
Run one differential-expression job on the worker (hgcompute-08).

Reads a job spec, loads the dataset's AnnData, resolves the two populations to
cell masks, dispatches to the requested compute method, and writes results and
status back to the job directory. Deliberately transport-agnostic: it only
touches the filesystem job dir, so it works whether the CB backend writes specs
directly or a thin RR bridge relays them (see differential-expression.md).

Job directory layout (all under DE_JOBS_DIR/<jobId>/):
    spec.json    - written by the enqueuer; the request
    status.json  - written here; {state, stage, elapsed, error?}
    result.json  - written here on success; {genes: [...]}

Spec shape (see plan "Job Submission API"):
    {
      "dataset":    "adipose-tissue",
      "pop1":       {"type": "field", "field": "Condition", "values": ["Diabetic"]},
      "pop2":       {"type": "field", "field": "Condition", "values": ["NonDiabetic"]},
      "method":     "wilcoxon",
      "parameters": {"min_cells": 10, "top_n": 200}
    }

Population selector types:
    field / cluster : {"field": <obs column>, "values": [...]}  (values matched as strings)
    cellIds         : {"ids": [<barcode str> ...]}   matched against adata.obs_names
    cellIdx         : {"idx": [<int> ...]}            positional indices into adata

CLI (for testing without a queue):
    runDeJob.py --spec path/to/spec.json --datasets-dir /hive/... --out path/to/outdir
    runDeJob.py <jobId>            # uses DE_JOBS_DIR/<jobId>
"""
import argparse
import json
import os
import sys
import time
import traceback

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from methods import wilcoxon

DE_JOBS_DIR = os.environ.get("DE_JOBS_DIR", "/hive/data/inside/cells/deJobs")
DATASETS_DIR = os.environ.get(
    "DE_DATASETS_DIR", "/hive/data/inside/cells/datasets")

METHODS = {
    "wilcoxon": wilcoxon.run_wilcoxon,
}


def datasetAnnDataPath(dataset, datasets_dir):
    """Locate the AnnData file for a dataset. cbScanpy writes anndata.h5ad in
    the dataset's build dir; fall back to any single *.h5ad there."""
    d = os.path.join(datasets_dir, dataset)
    cand = os.path.join(d, "anndata.h5ad")
    if os.path.isfile(cand):
        return cand
    if os.path.isdir(d):
        h5ads = [f for f in os.listdir(d) if f.endswith(".h5ad")]
        if len(h5ads) == 1:
            return os.path.join(d, h5ads[0])
        if len(h5ads) > 1:
            raise ValueError(
                "dataset %s has multiple .h5ad files; spec must disambiguate"
                % dataset)
    raise ValueError("no AnnData (.h5ad) found for dataset %s" % dataset)


def _normField(s):
    """cbBuild sanitizes metadata field names by stripping non-alphanumerics
    (e.g. 'Characteristics[developmental stage]' -> 'Characteristicsdevelopmentalstage').
    The frontend only knows the sanitized name, so map it back to the real
    AnnData obs column by normalizing both sides the same way."""
    import re
    return re.sub(r"[^A-Za-z0-9]", "", str(s))


def resolveFieldName(adata, field, label):
    if field in adata.obs.columns:
        return field
    nf = _normField(field)
    for c in adata.obs.columns:
        if _normField(c) == nf:
            return c
    raise ValueError("%s: field %r not in dataset metadata" % (label, field))


def _filterMask(adata, filt, label):
    """Boolean mask for a metadata restriction {field, value}."""
    field = resolveFieldName(adata, filt["field"], label)
    value = str(filt.get("value", ""))
    return adata.obs[field].astype(str).eq(value).to_numpy()


def resolvePopulation(adata, sel, label):
    """Turn a population selector into a boolean mask over adata.n_obs.
    An optional sel["filter"] = {field, value} narrows the population to cells
    also matching that metadata field (the per-group cross-field restriction)."""
    stype = sel.get("type", "field")

    if stype in ("field", "cluster"):
        field = resolveFieldName(adata, sel["field"], label)
        wanted = set(str(v) for v in sel["values"])
        mask = adata.obs[field].astype(str).isin(wanted).to_numpy()

    elif stype == "cellIds":
        wanted = set(str(x) for x in sel["ids"])
        names = adata.obs_names.astype(str)
        mask = np.array([n in wanted for n in names], dtype=bool)
        found = int(mask.sum())
        if found != len(wanted):
            # partial matches usually mean a barcode-suffix mismatch — surface it
            raise ValueError(
                "%s: matched %d of %d cell ids (barcode format mismatch?)"
                % (label, found, len(wanted)))

    elif stype == "cellIdx":
        idx = np.asarray(sel["idx"], dtype=int)
        if idx.min() < 0 or idx.max() >= adata.n_obs:
            raise ValueError("%s: cell index out of range" % label)
        mask = np.zeros(adata.n_obs, dtype=bool)
        mask[idx] = True

    else:
        raise ValueError("%s: unknown selector type %r" % (label, stype))

    filt = sel.get("filter")
    if filt and filt.get("field"):
        mask = mask & _filterMask(adata, filt, label)

    if not mask.any():
        raise ValueError("%s: no cells match the selection" % label)
    return mask


def writeStatus(outdir, **kw):
    tmp = os.path.join(outdir, "status.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(kw, fh)
    os.replace(tmp, os.path.join(outdir, "status.json"))  # atomic


def runJob(spec, outdir, datasets_dir):
    t0 = time.time()

    def status(state, stage=None, error=None):
        writeStatus(outdir, state=state, stage=stage,
                    elapsed=round(time.time() - t0, 2), error=error)

    try:
        status("running", "loading data")
        method = spec.get("method", "wilcoxon")
        if method not in METHODS:
            raise ValueError("unknown method %r" % method)

        # Import lazily so a spec error is reported before we pay the h5ad load.
        import anndata as ad
        path = datasetAnnDataPath(spec["dataset"], datasets_dir)
        adata = ad.read_h5ad(path)

        status("running", "resolving populations")
        pop1 = resolvePopulation(adata, spec["pop1"], "pop1")
        p2 = spec["pop2"]
        if p2 == "rest" or (isinstance(p2, dict) and p2.get("type") == "rest"):
            # one-vs-rest: everything not in pop1, optionally within a filter
            pop2 = ~pop1
            filt = p2.get("filter") if isinstance(p2, dict) else None
            if filt and filt.get("field"):
                pop2 = pop2 & _filterMask(adata, filt, "pop2")
            if not pop2.any():
                raise ValueError("pop2 (rest) has no cells")
        else:
            pop2 = resolvePopulation(adata, p2, "pop2")

        status("running", "running test")
        genes = METHODS[method](adata, pop1, pop2, spec.get("parameters"))

        result = {
            "dataset": spec["dataset"],
            "method": method,
            "n_pop1": int(pop1.sum()),
            "n_pop2": int(pop2.sum()),
            "genes": genes,
        }
        tmp = os.path.join(outdir, "result.json.tmp")
        with open(tmp, "w") as fh:
            json.dump(result, fh)
        os.replace(tmp, os.path.join(outdir, "result.json"))

        status("done")
        return 0
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        status("failed", error=str(e))
        return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("jobId", nargs="?", help="job id under DE_JOBS_DIR")
    ap.add_argument("--spec", help="path to spec.json (overrides jobId lookup)")
    ap.add_argument("--out", help="output dir (default: the spec's dir)")
    ap.add_argument("--datasets-dir", default=DATASETS_DIR)
    args = ap.parse_args()

    if args.spec:
        specpath = args.spec
        outdir = args.out or os.path.dirname(os.path.abspath(specpath))
    elif args.jobId:
        outdir = args.out or os.path.join(DE_JOBS_DIR, args.jobId)
        specpath = os.path.join(outdir, "spec.json")
    else:
        ap.error("give a jobId or --spec")

    with open(specpath) as fh:
        spec = json.load(fh)
    os.makedirs(outdir, exist_ok=True)
    sys.exit(runJob(spec, outdir, args.datasets_dir))


if __name__ == "__main__":
    main()
