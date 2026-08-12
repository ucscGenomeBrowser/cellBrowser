# Cell Browser differential-expression worker (#24912)

The compute half of on-the-fly differential expression. Runs on **hgcompute-08**
under the **otto** service account, driven by a filesystem job queue on `/hive`
(hgwdev and hgcompute-08 share `/hive`; no parasol, no scheduler).

## Pieces

- `deWorker.py` — long-running daemon. Watches the job queue, atomically claims
  pending jobs (`worker.lock`, restart-safe), and runs each in its own subprocess
  so a crash/OOM can't take down the daemon. Handles per-job timeout and
  retention cleanup.
- `runDeJob.py` — runs one job: reads `spec.json`, loads the dataset AnnData,
  resolves the two populations to cell masks, dispatches to the method, writes
  `result.json` + `status.json` (atomic).
- `methods/wilcoxon.py` — Phase 1 kernel: Scanpy Wilcoxon rank-sum, CPU.
  (`memento.py` / `rapids.py` come in later phases.)

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

## Still to wire

- The enqueuer: the Cell Browser Flask backend's `/api/de` submit/poll routes
  write `spec.json` here and read status/result back (see `de_submit.py`, TBD).
  If the backend host has `/hive` (its SQLite already lives there), it writes the
  queue directly; otherwise a dev-side Flask service does, reached over HTTPS.
- Relocate the scanpy env off a personal home dir; run as otto.
