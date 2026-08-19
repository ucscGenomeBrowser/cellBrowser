#!/usr/bin/env python3
"""
Run one differential-expression job on the worker (hgcompute-08).

Reads a job spec, reads the dataset's expression from the cbBuild web output
(exprMatrix.bin + meta.tsv, via cbExprReader), resolves the two populations to
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
    cellIds         : {"ids": [<barcode str> ...]}   matched against the cell ids
    cellIdx         : {"idx": [<int> ...]}            positional indices into the matrix

CLI (for testing without a queue):
    runDeJob.py --spec path/to/spec.json --cbbuild-dir /path/to/docroot --out outdir
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
import wilcoxon_np

DE_JOBS_DIR = os.environ.get("DE_JOBS_DIR", "/hive/data/inside/cells/deJobs")
# Root of the cbBuild web output (dataset dirs with exprMatrix.bin + meta.tsv).
# This is the uniform format the frontend serves, so DE can run on any dataset a
# user can open, reading exactly what the browser shows (see cbExprReader.py).
CBBUILD_DIR = os.environ.get(
    "DE_CBBUILD_DIR", "/usr/local/apache/htdocs-cells")
# Ceiling on cells tested per group. A one-vs-rest comparison on a large atlas
# would otherwise read every cell into the group of interest's complement; even
# sparse that can be tens of GB. Above this, each group is deterministically
# thinned (evenly spaced, reproducible) before the matrix is read — Wilcoxon
# p-values and AUC are stable under this kind of subsampling. 0 disables the cap.
MAX_CELLS_PER_GROUP = int(os.environ.get("DE_MAX_CELLS_PER_GROUP", "50000"))

METHODS = {
    "wilcoxon": wilcoxon_np.run_wilcoxon,   # numpy/scipy kernel (no scanpy)
}


def datasetCbBuildDir(dataset, cbbuild_dir):
    """Return the cbBuild output dir for a dataset if it has the binary matrix
    files we can read (dataset.json + exprMatrix.bin + exprMatrix.json + meta.tsv),
    else None. Dataset names may be collection-nested (a/b); the frontend uses
    that same path under the doc root."""
    if not cbbuild_dir:
        return None
    d = os.path.join(cbbuild_dir, dataset)
    need = ["dataset.json", "exprMatrix.bin", "exprMatrix.json", "meta.tsv"]
    if all(os.path.isfile(os.path.join(d, f)) for f in need):
        return d
    return None


def _normField(s):
    """cbBuild sanitizes metadata field names by stripping non-alphanumerics
    (e.g. 'Characteristics[developmental stage]' -> 'Characteristicsdevelopmentalstage').
    The frontend only knows the sanitized name, so map it back to the real
    AnnData obs column by normalizing both sides the same way."""
    import re
    return re.sub(r"[^A-Za-z0-9]", "", str(s))


def resolveFieldName(obs, field, label):
    if field in obs.columns:
        return field
    nf = _normField(field)
    for c in obs.columns:
        if _normField(c) == nf:
            return c
    raise ValueError("%s: field %r not in dataset metadata" % (label, field))


def _filterMask(obs, filt, label):
    """Boolean mask for a metadata restriction {field, value}."""
    field = resolveFieldName(obs, filt["field"], label)
    value = str(filt.get("value", ""))
    return obs[field].astype(str).eq(value).to_numpy()


def resolvePopulation(obs, sel, label):
    """Turn a population selector into a boolean mask over the cells in `obs`
    (a DataFrame whose index is the cell ids, in matrix order).
    An optional sel["filter"] = {field, value} narrows the population to cells
    also matching that metadata field (the per-group cross-field restriction)."""
    n_obs = len(obs)
    stype = sel.get("type", "field")

    if stype in ("field", "cluster"):
        field = resolveFieldName(obs, sel["field"], label)
        wanted = set(str(v) for v in sel["values"])
        mask = obs[field].astype(str).isin(wanted).to_numpy()

    elif stype == "cellIds":
        wanted = set(str(x) for x in sel["ids"])
        names = obs.index.astype(str)
        mask = np.array([n in wanted for n in names], dtype=bool)
        found = int(mask.sum())
        if found != len(wanted):
            # partial matches usually mean a barcode-suffix mismatch — surface it
            raise ValueError(
                "%s: matched %d of %d cell ids (barcode format mismatch?)"
                % (label, found, len(wanted)))

    elif stype == "cellIdx":
        idx = np.asarray(sel["idx"], dtype=int)
        if idx.min() < 0 or idx.max() >= n_obs:
            raise ValueError("%s: cell index out of range" % label)
        mask = np.zeros(n_obs, dtype=bool)
        mask[idx] = True

    else:
        raise ValueError("%s: unknown selector type %r" % (label, stype))

    filt = sel.get("filter")
    if filt and filt.get("field"):
        mask = mask & _filterMask(obs, filt, label)

    if not mask.any():
        raise ValueError("%s: no cells match the selection" % label)
    return mask


def writeStatus(outdir, **kw):
    tmp = os.path.join(outdir, "status.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(kw, fh)
    os.replace(tmp, os.path.join(outdir, "status.json"))  # atomic


def _resolveBothPops(obs, spec):
    """Resolve pop1/pop2 selectors to boolean masks over the cells in `obs`."""
    pop1 = resolvePopulation(obs, spec["pop1"], "pop1")
    p2 = spec["pop2"]
    if p2 == "rest" or (isinstance(p2, dict) and p2.get("type") == "rest"):
        # one-vs-rest: everything not in pop1, optionally within a filter
        pop2 = ~pop1
        filt = p2.get("filter") if isinstance(p2, dict) else None
        if filt and filt.get("field"):
            pop2 = pop2 & _filterMask(obs, filt, "pop2")
        if not pop2.any():
            raise ValueError("pop2 (rest) has no cells")
    else:
        pop2 = resolvePopulation(obs, p2, "pop2")
    return pop1, pop2


def _thinMask(mask, cap):
    """Deterministically subsample a boolean mask down to at most `cap` True
    cells, evenly spaced over the selected positions (reproducible, no RNG).
    Returns (thinned_mask, full_count)."""
    idx = np.flatnonzero(mask)
    full = idx.size
    if cap and full > cap:
        pick = idx[np.linspace(0, full - 1, cap).astype(int)]
        thin = np.zeros_like(mask)
        thin[pick] = True
        return thin, full
    return mask, full


def runJob(spec, outdir, cbbuild_dir=CBBUILD_DIR,
           max_cells=MAX_CELLS_PER_GROUP):
    t0 = time.time()

    def status(state, stage=None, error=None):
        writeStatus(outdir, state=state, stage=stage,
                    elapsed=round(time.time() - t0, 2), error=error)

    try:
        status("running", "loading data")
        method = spec.get("method", "wilcoxon")
        if method not in METHODS:
            raise ValueError("unknown method %r" % method)

        # Read the uniform cbBuild binary matrix — the same files (and numbers)
        # the frontend serves, so DE runs on any dataset a user can open. Resolve
        # the populations from meta.tsv first, then read only the pop1|pop2 union.
        cbdir = datasetCbBuildDir(spec["dataset"], cbbuild_dir)
        if not cbdir:
            raise ValueError(
                "no cbBuild expression output for dataset %r under %s "
                "(need dataset.json + exprMatrix.bin + exprMatrix.json + meta.tsv)"
                % (spec["dataset"], cbbuild_dir))

        import cbExprReader as cer
        reader = cer.CbExprReader(cbdir)
        try:
            _cellIds, obs = reader.readMeta()
        finally:
            reader.close()

        status("running", "resolving populations")
        pop1, pop2 = _resolveBothPops(obs, spec)
        # Thin each group before reading so the union we read stays bounded.
        cap = int((spec.get("parameters") or {}).get(
            "max_cells_per_group", max_cells))
        t1, full1 = _thinMask(pop1, cap)
        t2, full2 = _thinMask(pop2, cap)
        union = np.flatnonzero(t1 | t2)

        status("running", "loading expression")
        adata = cer.readAnnData(cbdir, cellIdx=union)
        m1 = t1[union]
        m2 = t2[union]

        status("running", "running test")
        genes = METHODS[method](adata, m1, m2, spec.get("parameters"))
        n1, n2 = full1, full2
        subsampled = (full1 > int(m1.sum())) or (full2 > int(m2.sum()))

        result = {
            "dataset": spec["dataset"],
            "method": method,
            "n_pop1": n1,             # cells selected
            "n_pop2": n2,
            "n_tested1": int(m1.sum()),   # cells actually tested (after any thinning)
            "n_tested2": int(m2.sum()),
            "subsampled": bool(subsampled),
            "filters": wilcoxon_np.resolve_filters(spec.get("parameters")),
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
    ap.add_argument("--cbbuild-dir", default=CBBUILD_DIR,
                    help="root of cbBuild web output (dataset dirs)")
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
    sys.exit(runJob(spec, outdir, args.cbbuild_dir))


if __name__ == "__main__":
    main()
