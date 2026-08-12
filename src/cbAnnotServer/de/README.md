# Cell Browser differential-expression worker (#24912)

The compute half of on-the-fly differential expression. Runs on **hgcompute-08**
under the **otto** service account, driven by a filesystem job queue on `/hive`
(hgwdev and hgcompute-08 share `/hive`; no parasol, no scheduler).

## Pieces

- `deWorker.py` — long-running daemon. Watches the job queue, atomically claims
  pending jobs (`worker.lock`, restart-safe), and runs each in its own subprocess
  so a crash/OOM can't take down the daemon. Handles per-job timeout and
  retention cleanup.
- `runDeJob.py` — runs one job: reads `spec.json`, loads the dataset's
  expression, resolves the two populations to cell masks, dispatches to the
  method, writes `result.json` + `status.json` (atomic).
- `cbExprReader.py` — Python port of the cbData.js expression reader. Decodes the
  uniform **cbBuild web output** (`exprMatrix.bin` + `exprMatrix.json` +
  `meta.tsv`) so DE runs on any published dataset — the same files, and the same
  numbers, the frontend serves — with no source `.h5ad` required.
- `methods/wilcoxon.py` — Phase 1 kernel: Scanpy Wilcoxon rank-sum, CPU.
  (`memento.py` / `rapids.py` come in later phases.)

## Where the expression comes from

`runDeJob.py` prefers the **cbBuild output** and falls back to a source `.h5ad`:

1. **cbBuild binary** (preferred) — if `DE_CBBUILD_DIR/<dataset>/` has
   `dataset.json` + `exprMatrix.bin` + `exprMatrix.json` + `meta.tsv`, read it via
   `cbExprReader`. Populations are resolved from `meta.tsv` first, then only the
   `pop1 ∪ pop2` cells are densified — so a 2M-cell matrix is never fully
   materialized. Integer matrices (raw counts, `matrixArrType` `Uint32`) are
   `normalize_total` + `log1p`'d to match the frontend's log-space display;
   `Float32` matrices (already log-normalized by cbScanpy) are used as-is.
   `DE_CBBUILD_DIR` defaults to `/usr/local/apache/htdocs-cells`.
2. **`.h5ad` fallback** — `DE_DATASETS_DIR/<dataset>/anndata.h5ad` (or a single
   `*.h5ad`). Used for dev datasets that were not cbBuild'd on this host.

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

Needs a Python with scanpy (Phase 1). In production this env lives in a shared,
otto-readable location (TODO: relocate from the current dev env at
`~mspeir/miniconda3/envs/scanpyenv`).

```
DE_WORKER_PYTHON=/path/to/scanpy-env/bin/python \
  python3 deWorker.py
```

Config via env (all optional; see `deWorker.py` header for the full list):
`DE_JOBS_DIR` (default `/hive/data/inside/cells/deJobs`), `DE_DATASETS_DIR`,
`DE_WORKER_PYTHON`, `DE_POLL_SEC`, `DE_JOB_TIMEOUT`, `DE_RETENTION_DAYS`.

Deploy as a systemd unit (or cron keep-alive) under otto, same pattern as
`../deploy/` for cbAnnotServer.

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

- Deploy: dev-side `de_submit.py` (direct) + `deWorker.py` as systemd units under
  otto on a `/hive` host + hgcompute-08; production cbAnnotServer registers the
  blueprint in proxy mode (`DE_RELAY_URL`); set `deUrl` in cb.conf.
- `de_jobs` table + account tie-in on the production (proxy) tier (per plan).
- Relocate the scanpy env off a personal home dir to a shared/otto-readable one.
- Auth on the proxy→direct call (`X-DE-Key` shared secret is stubbed in).
- Phase-2 params (minPct, subsample) and other tests are not yet in the kernel.
