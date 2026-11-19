# Cell Browser differential-expression worker (#24912)

The compute half of on-the-fly differential expression. Two programs, which
share only the database:

- the **web service** (cbAnnotServer, which also does sign-in) takes a comparison
  from the browser, adds it to the `cbDeJobs` table, and answers status requests
  from that table. It can run on any number of web machines.
- the **worker** (`deWorker.py`) runs on the one machine that has the datasets.
  It takes queued jobs from the table, oldest first, one at a time, and writes
  progress and the result back into the job's row.

For cells-test both run on **hgwdev** as **otto**, with hgcentraltest as the
database, and the worker reads the datasets from the local docroot
(`DE_READ_LOCAL=1`). On the RR the web service runs on every web node and the
worker on hgw0, with hgcentral as the database. No parasol, no scheduler, no
shared filesystem, and no connection between the web nodes and hgw0 other than
the database.

## Pieces

- `de_submit.py` — the web side: the `/api/de` submit, status and cancel
  endpoints, which add and read `cbDeJobs` rows (see "Web side" below).
- `deWorker.py` — the worker daemon. Takes queued jobs from `cbDeJobs` and runs
  each in its own subprocess so a crash or out-of-memory can't take down the
  daemon. Handles cancel, the per-job timeout, and retention cleanup.
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
serves, so DE runs on any dataset a user can open, with no source `.h5ad`. Where
the worker runs on a web host with the datasets in its docroot (hgw0, hgwdev),
set `DE_READ_LOCAL=1` and every job reads `DE_CBBUILD_DIR/<dataset>/` directly,
ignoring the job's `dataUrl`: no downloads, no cache. Without it, a job's
`dataUrl` is fetched over HTTP into a cache (hgcompute-08, which has no docroot). If
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

## Job queue

One row per comparison in `cbDeJobs` (`models.DeJob`, `deploy/schema-mysql.sql`):

| state | set by | meaning |
|---|---|---|
| `queued` | web service (POST) | waiting; the status reply says how many jobs are ahead |
| `running` | worker | taken by a conditional UPDATE (queued -> running), so it can't be taken twice |
| `done` | worker | `result` holds the gzipped result JSON (~6 MB of JSON is ~1.4 MB stored) |
| `failed` | worker | `error` says why, in words the browser can show |
| `canceled` | web service or worker | DELETE cancels a queued job directly, or sets `cancel_requested` on a running one, which the worker then kills |

While a job runs, the worker copies its stage and progress into the row once a
second, and checks `cancel_requested`. The job itself runs in a scratch dir,
`DE_JOBS_DIR/<jobId>/` (spec.json in, status.json and result.json out), in its
own process session, so on cancel or timeout the worker kills it and any
children. The scratch dir is removed when the row is updated. BLAS/OpenMP
threads are capped per job by `DE_CPU_LIMIT` (default 20).

Housekeeping, all done by the worker:

- at startup, jobs this host's earlier worker left `running` are marked failed
  ("the server restarted"), so the browser stops waiting;
- queued jobs older than `DE_QUEUE_STALE_SEC` (3600, the browser's own limit)
  are marked failed instead of run, since nobody is waiting for them;
- finished jobs older than `DE_RETENTION_DAYS` (7) are deleted.

If the database is unreachable the worker logs it and keeps retrying; a running
job carries on and its result is written once the database is back.

## Job log

The worker appends one TSV row per finished job to `DE_JOB_LOG` (default
`deJobs.tsv` next to `DE_JOBS_DIR`) — for seeing who uses the feature and how it
performs. Columns: `timestamp, jobId, requester, remote, dataset, field, groupA,
groupB, method, n_pop1, n_pop2, n_genes, runtime_s, status`. The requester
(logged-in email, else client IP) is captured by the submit API into the spec's
`_meta` and read back here; `status` is `done`/`failed`/`canceled`/`timeout`.

`spec.json` shape and the population selector types (`field`/`cluster`,
`cellIds`, `cellIdx`) are documented in `runDeJob.py`'s header.

## Running it

Needs a Python with **numpy, scipy and pandas** for the computation, and
SQLAlchemy + PyMySQL to reach the job table (`requirements.txt` here). The runtime path
(`runDeJob` → `cbExprReader.readExpr` → `wilcoxon_np`) imports neither scanpy nor
anndata; normalization and the Wilcoxon test are done in numpy/scipy. (scanpy is
only needed to run the `methods/wilcoxon.py` validation oracle.) For a one-off run:

```
CBANNOT_DATABASE_URI='mysql+pymysql://USER:PW@HOST/hgcentraltest?charset=utf8mb4' \
DE_READ_LOCAL=1 DE_WORKER_PYTHON=/path/to/env/bin/python \
  /path/to/env/bin/python deWorker.py
```

`CBANNOT_DATABASE_URI` is required and is the same database the web service
uses (an `sqlite:///` file works for local development). Everything else is
optional; see the `deWorker.py` header for the list: `DE_JOBS_DIR` (scratch,
default `/cluster/home/otto/cellsServer/deJobs`), `DE_READ_LOCAL`,
`DE_CBBUILD_DIR`, `DE_WORKER_PYTHON`, `DE_POLL_SEC`, `DE_JOB_TIMEOUT`,
`DE_MAX_CELLS_PER_GROUP`, `DE_RETENTION_DAYS`.

## Durability (deploy)

Everything the worker needs to run unattended under otto is in `deploy/`:

| file | role |
|---|---|
| `de.env.sample` | copy to a private `de.env` (it holds the database password): database, python, docroot, pidfile/heartbeat/log paths |
| `runDeWorker.sh` | sources `DE_ENV_FILE` and `exec`s `deWorker.py` (so the tracked PID is the daemon) |
| `deWorkerWatchdog.sh` | cron keep-alive: restarts the worker if its PID is gone **or** its heartbeat is stale |
| `restart-worker.sh` | stop the worker and respawn it (to pick up new code / de.env); run as its owner (otto) |
| `deWorker.service` | systemd unit for hosts where you can install one as root (preferred over cron) |

The worker has no HTTP endpoint, so liveness is "pidfile process alive **and**
heartbeat fresh" — the heartbeat (`DE_WORKER_HEARTBEAT`, touched each loop) catches
a *hung* worker, not just a dead one. A running job blocks the loop for up to
`DE_JOB_TIMEOUT`, so the watchdog's staleness threshold defaults to
`DE_JOB_TIMEOUT + 300` and never mistakes a long job for a hang.

**cron (otto crontab), the fallback where systemd can't be installed:**

```
* * * * *  DE_ENV_FILE=/cluster/home/otto/cellsServer/etc/de.env  /cluster/home/otto/cellsServer/cbAnnotServer/de/deploy/deWorkerWatchdog.sh >> /cluster/home/otto/cellsServer/logs/deWorker-watchdog.log 2>&1
@reboot    DE_ENV_FILE=/cluster/home/otto/cellsServer/etc/de.env  /cluster/home/otto/cellsServer/cbAnnotServer/de/deploy/deWorkerWatchdog.sh >> /cluster/home/otto/cellsServer/logs/deWorker-watchdog.log 2>&1
```

(mirrors the existing `cbAnnotServer` watchdog lines in `otto.crontab`.)

**The worker's python** is pinned in `requirements.txt` here. At UCSC,
`make setup-annot` in `ucsc/` builds it as /cluster/home/otto/cellsServer/deenv
from /usr/bin/python3.13 (the RHEL 9 python3.13 package), and `de.env` points
`DE_WORKER_PYTHON` at it. Elsewhere:

```
python3 -m venv deenv && deenv/bin/pip install -r requirements.txt
```

## Verified

2026-08-12, dev (scanpyenv on hgwdev): daemon claimed a queued job and ran real
Wilcoxon DE on `adipose-tissue` (Diabetic vs NonDiabetic, 11,979 vs 14,371) in
~4 s, writing status=done + a ranked result.json (CST3, LUM, APOE, …).

## Web side

`de_submit.py` is the Flask blueprint the frontend talks to, one URL: POST the
builder spec, GET `?jobId=` for status and result, DELETE `?jobId=` to cancel.
It translates the builder spec (groupA/groupB/field) into the worker spec,
including one-vs-rest and the per-group metadata filter, and stores it in the
job's row.

Every submit is checked before it is queued:

- **Dataset and dataUrl.** The dataset name must be a plain docroot-relative path
  (no `..`, not absolute). The dataUrl must be http(s), on the default port, with
  no user name, on a host matching `DE_DATA_HOSTS` (comma-separated wildcards;
  default in `deCache.DEFAULT_DATA_HOSTS`: cells.ucsc.edu, cells-*.gi.ucsc.edu and
  their project subdomains). With `DE_READ_LOCAL` the worker ignores dataUrl;
  without it, it repeats the check in `deCache.ensureDataset` and refuses
  redirects to hosts off the list.
- **Queue limits**: `DE_MAX_JOBS_PER_REQUESTER` (2) queued+running jobs per
  person, `DE_MAX_JOBS_TOTAL` (20) overall. Over either, the POST returns 429
  with a message the UI shows. A person is the signed-in account, or the client
  IP if anonymous: behind Apache, the *last* X-Forwarded-For entry. Unfinished
  jobs older than `DE_QUEUE_STALE_SEC` (3600) stop counting, so a dead job can't
  jam the queue.

## Still to wire

- Statistics: pseudoreplication caveat in the UI; Memento / pseudobulk as the
  Phase-2 sounder method. Other tests (t-test, logreg) are easy adds.
