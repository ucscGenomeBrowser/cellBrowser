# Cell Browser differential-expression worker (#24912)

The compute half of on-the-fly differential expression. Runs on **hgcompute-08**
under the **otto** service account, driven by a filesystem job queue on `/hive`
(hgwdev and hgcompute-08 share `/hive`; no parasol, no scheduler).

## Pieces

- `deWorker.py` — long-running daemon. Watches the job queue, atomically claims
  pending jobs (`worker.lock`, restart-safe), and runs each in its own subprocess
  so a crash/OOM can't take down the daemon. Handles per-job timeout and
  retention cleanup.
- `runDeJob.py` — runs one job: reads `spec.json`, reads the dataset's expression
  from the cbBuild output (via `cbExprReader`), resolves the two populations to
  cell masks, dispatches to the method, writes `result.json` + `status.json`
  (atomic).
- `cbExprReader.py` — Python port of the cbData.js expression reader. Decodes the
  uniform **cbBuild web output** (`exprMatrix.bin` + `exprMatrix.json` +
  `meta.tsv`) so DE runs on any published dataset — the same files, and the same
  numbers, the frontend serves — with no source `.h5ad` required.
- `wilcoxon_np.py` — the compute kernel: Wilcoxon rank-sum DE in numpy + scipy
  only (no scanpy/AnnData). Verified bit-identical to scanpy's
  `rank_genes_groups(method="wilcoxon")` on Float32 and Uint32 datasets, and ~10×
  faster. Also computes the AUC effect size, per-group means and % expressing, and
  applies the gene filters (see below). `methods/wilcoxon.py` is the original
  scanpy implementation, kept as the validation oracle but no longer used at
  runtime. (`memento.py` / `rapids.py` come in later phases.)

  **Gene filtering** happens in the kernel, before the test, so the
  Benjamini-Hochberg FDR is computed over exactly the reported (and downloaded)
  gene set. Two detection floors define that set: `min_gene_cells` (default 3,
  detected in ≥N cells in at least one group) and `min_pct` (the builder's minPct,
  detected in ≥X% of at least one group). Category exclusions — mitochondrial,
  ribosomal, hemoglobin — are all on by default. `lfcCut`/`padjCut` are NOT
  applied here: filtering genes by their p-value before BH would bias the FDR, so
  those stay client-side significance thresholds. The result carries a `filters`
  summary so the downloaded CSV is self-documenting.

## Where the expression comes from

`runDeJob.py` reads the **cbBuild web output** — the same files the frontend
serves, so DE runs on any dataset a user can open, with no source `.h5ad`. If
`DE_CBBUILD_DIR/<dataset>/` has `dataset.json` + `exprMatrix.bin` +
`exprMatrix.json` + `meta.tsv`, `cbExprReader` decodes it; a dataset missing those
is a clear job error. `DE_CBBUILD_DIR` defaults to `/usr/local/apache/htdocs-cells`.

Populations are resolved from `meta.tsv` first, then only the `pop1 ∪ pop2` cells
are read, into a **sparse** (CSR) matrix — so a 2M-cell matrix is never fully
materialized and one-vs-rest stays feasible. Integer matrices (raw counts,
`matrixArrType` `Uint32`) are `normalize_total` + `log1p`'d to match the
frontend's log-space display; `Float32` matrices (already log-normalized by
cbScanpy) are used as-is.

Each group is also deterministically thinned to at most `DE_MAX_CELLS_PER_GROUP`
cells (default 50000; per-job override `parameters.max_cells_per_group`, 0
disables) before the matrix is read, so a one-vs-rest on a huge atlas can't blow
up memory. The result reports the selected counts (`n_pop1`/`n_pop2`), the tested
counts (`n_tested1`/`n_tested2`), and a `subsampled` flag.

The reader is validated exact: on a dataset decoded independently from
`exprMatrix.tsv.gz`, log2FC / p-adj / AUC match to the bit and means to float32
rounding.

A few old datasets on disk are mis-built (their `exprMatrix.bin` is 8-byte but
`matrixArrType` says `Uint32`); the reader raises a clear error rather than
returning garbage — the browser misrenders those datasets too.

## Job queue protocol

Each job is a directory `DE_JOBS_DIR/<jobId>/`:

| file | written by | meaning |
|---|---|---|
| `spec.json` | the enqueuer (CB backend) | the request (dataset, pop1, pop2, method, parameters) |
| `worker.lock` | the worker | claim marker (PID) |
| `status.json` | the kernel | `{state: running\|done\|failed, stage, elapsed, error}` |
| `result.json` | the kernel | `{genes: [...], n_pop1, n_pop2}` on success |

A job is *pending* when it has `spec.json`, no result, and is unclaimed (or the
lock is stale). The enqueuer just drops a `spec.json`; the worker does the rest.

`spec.json` shape and the population selector types (`field`/`cluster`,
`cellIds`, `cellIdx`) are documented in `runDeJob.py`'s header.

## Running it

Needs a Python with **numpy, scipy, and pandas** — that's it. The runtime path
(`runDeJob` → `cbExprReader.readExpr` → `wilcoxon_np`) imports neither scanpy nor
anndata; normalization and the Wilcoxon test are done in numpy/scipy. (scanpy is
only needed to run the `methods/wilcoxon.py` validation oracle.) For a one-off run:

```
DE_WORKER_PYTHON=/path/to/env/bin/python \
  python3 deWorker.py
```

Config via env (all optional; see `deWorker.py` header for the full list):
`DE_JOBS_DIR` (default `/hive/data/inside/cells/deJobs`), `DE_CBBUILD_DIR`,
`DE_WORKER_PYTHON`, `DE_POLL_SEC`, `DE_JOB_TIMEOUT`, `DE_MAX_CELLS_PER_GROUP`,
`DE_RETENTION_DAYS`.

## Durability (deploy)

Everything the worker needs to run unattended under otto is in `deploy/`:

| file | role |
|---|---|
| `de.env.sample` | copy to a private `de.env`; queue dir, scanpy python, pidfile/heartbeat/log paths |
| `runDeWorker.sh` | sources `DE_ENV_FILE` and `exec`s `deWorker.py` (so the tracked PID is the daemon) |
| `deWorkerWatchdog.sh` | cron keep-alive: restarts the worker if its PID is gone **or** its heartbeat is stale |
| `deWorker.service` | systemd unit for hosts where you can install one as root (preferred over cron) |

The worker has no HTTP endpoint, so liveness is "pidfile process alive **and**
heartbeat fresh" — the heartbeat (`DE_WORKER_HEARTBEAT`, touched each loop) catches
a *hung* worker, not just a dead one. A running job blocks the loop for up to
`DE_JOB_TIMEOUT`, so the watchdog's staleness threshold defaults to
`DE_JOB_TIMEOUT + 300` and never mistakes a long job for a hang.

**cron (otto crontab), the fallback where systemd can't be installed:**

```
* * * * *  DE_ENV_FILE=/hive/data/inside/cells/cbAnnotServer/de.env  ~mspeir/cellBrowser/src/cbAnnotServer/de/deploy/deWorkerWatchdog.sh >> /hive/data/inside/cells/cbAnnotServer/logs/deWorker-watchdog.log 2>&1
@reboot    DE_ENV_FILE=/hive/data/inside/cells/cbAnnotServer/de.env  ~mspeir/cellBrowser/src/cbAnnotServer/de/deploy/deWorkerWatchdog.sh >> /hive/data/inside/cells/cbAnnotServer/logs/deWorker-watchdog.log 2>&1
```

(mirrors the existing `cbAnnotServer` watchdog lines in `otto.crontab`.)

**Relocating the scanpy env off a personal home** (otto must be able to read it):

```
# one-time: pack the working dev env and unpack it under /hive
conda install -n base -c conda-forge conda-pack        # if not present
conda pack -n scanpyenv -o /tmp/scanpyenv.tar.gz
mkdir -p /hive/data/inside/cells/cbAnnotServer/scanpyenv
tar -xzf /tmp/scanpyenv.tar.gz -C /hive/data/inside/cells/cbAnnotServer/scanpyenv
/hive/data/inside/cells/cbAnnotServer/scanpyenv/bin/conda-unpack   # fixes hardcoded paths
```

then set `DE_WORKER_PYTHON=/hive/data/inside/cells/cbAnnotServer/scanpyenv/bin/python`
in `de.env`.

## Verified

2026-08-12, dev (scanpyenv on hgwdev): daemon claimed a queued job and ran real
Wilcoxon DE on `adipose-tissue` (Diabetic vs NonDiabetic, 11,979 vs 14,371) in
~4 s, writing status=done + a ranked result.json (CST3, LUM, APOE, …).

## Enqueuer

`de_submit.py` is the Flask blueprint the frontend talks to (one URL: POST the
builder spec, GET `?jobId=` for status/result). One codebase, two modes:

- **direct** (`DE_QUEUE_DIR` set; instance has `/hive`): writes `spec.json` here,
  reads status/result back. This is the dev-side service, run as otto.
- **proxy** (`DE_RELAY_URL` set; production, no `/hive`): forwards to the direct
  instance over HTTPS. Production has no `/hive` (Matt, 2026-08-12), so this tier
  is required.

It translates the builder spec (groupA/groupB/field) into the worker `spec.json`
shape, including one-vs-rest and the per-group metadata filter. Run the standalone
dev server (direct mode) with `python de_submit.py` (needs Flask).

Verified 2026-08-12: full loop on hgwdev — POST spec → direct Flask → queue →
worker → poll done, real Wilcoxon on adipose-tissue (Diabetic vs rest, 11,979 vs
14,371, 2006 genes).

## Still to wire

- Install the durability setup on the `/hive` host: relocate the scanpy env
  (above), write `de.env`, add the cron watchdog lines (or the systemd unit).
- Production cbAnnotServer registers the blueprint in proxy mode (`DE_RELAY_URL`)
  and sets `deUrl` in cb.conf; the dev-side `de_submit.py` runs in direct mode.
- `de_jobs` table + account tie-in on the production (proxy) tier (per plan).
- Auth on the proxy→direct call (`X-DE-Key` shared secret is stubbed in).
- Statistics: pseudoreplication caveat in the UI; Memento / pseudobulk as the
  Phase-2 sounder method. Other scanpy tests (t-test, logreg) are easy adds.
