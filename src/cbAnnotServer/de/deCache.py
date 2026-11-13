"""
On-/hive cache of cbBuild expression output for the DE worker.

The worker (deWorker.py -> runDeJob.py) may run on a compute host (hgcompute-08)
that shares /hive but cannot see the web server's Apache docroot, where the
served exprMatrix.bin actually lives. So instead of reading the docroot directly,
the worker fetches the four files it needs over HTTP from the dataset's own URL
-- exactly what the browser serves -- into a per-dataset cache on /hive, then
hands that local directory to the existing CbExprReader (which is unchanged: it
still just reads local files).

This is the one data path for every deployment: the sandbox, cells-test, and the
firewall-split main site all fetch over HTTP, so the worker never needs a
filesystem view of any docroot -- only HTTPS reach to the web host and a /hive
cache to land the files in.

Cache layout:
    <cacheRoot>/<datasetKey>/<md5>/{dataset.json,exprMatrix.json,exprMatrix.bin,meta.tsv}
The <md5> is dataset.json's top-level build md5, so a rebuilt dataset lands in a
new directory and old versions age out. The cache is bounded by a byte budget and
evicted least-recently-used (by directory mtime, bumped on every hit).
"""
import fcntl
import fnmatch
import hashlib
import json
import os
import shutil
import urllib.error
import urllib.parse
import urllib.request

# The four files CbExprReader needs from a cbBuild output directory.
_NEEDED = ("dataset.json", "exprMatrix.json", "exprMatrix.bin", "meta.tsv")

# Hosts the worker may fetch a dataset from. The dataUrl comes from the browser,
# and the worker sits inside the firewall, so without this check anyone who can
# reach /api/de could make the worker fetch an internal URL. Override with
# DE_DATA_HOSTS (comma-separated, shell-style wildcards). "cells-*.gi.ucsc.edu"
# covers cells-test, cells-beta and the personal sandboxes; the "*." entries
# cover the project subdomains (e.g. sfari.cells-test.gi.ucsc.edu).
DEFAULT_DATA_HOSTS = ("cells.ucsc.edu,*.cells.ucsc.edu,cells-*.gi.ucsc.edu,"
                      "*.cells-test.gi.ucsc.edu,*.cells-beta.gi.ucsc.edu")


def dataHosts(value=None):
    """The allowed-host patterns, from value, else DE_DATA_HOSTS, else the default."""
    value = value or os.environ.get("DE_DATA_HOSTS") or DEFAULT_DATA_HOSTS
    return [h.strip().lower() for h in value.split(",") if h.strip()]


def checkDataUrl(dataUrl, hosts=None):
    """Return None if dataUrl is an http(s) URL on an allowed host and default
    port, else a short reason it was refused. hosts is a list from dataHosts()."""
    if hosts is None:
        hosts = dataHosts()
    try:
        u = urllib.parse.urlparse(dataUrl)
        port = u.port
    except (ValueError, TypeError, AttributeError):
        return "dataUrl is not a valid URL"
    if u.scheme not in ("http", "https"):
        return "dataUrl must be http or https"
    if u.username or u.password:
        return "dataUrl may not contain a user name or password"
    if port not in (None, 80, 443):
        return "dataUrl may not name a port"
    host = (u.hostname or "").lower()
    if not host or not any(fnmatch.fnmatchcase(host, pat) for pat in hosts):
        return "dataUrl host %r is not an allowed Cell Browser host" % host
    return None


class _CheckedRedirect(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only if its target passes checkDataUrl too, so an
    allowed host can't bounce the worker to a URL it would have refused."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        why = checkDataUrl(newurl)
        if why:
            raise urllib.error.HTTPError(newurl, code, "redirect refused: " + why, headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_CheckedRedirect)

# Streaming download chunk. exprMatrix.bin can be tens of GB, so never read a
# whole file into memory -- copy in fixed blocks straight to disk.
_CHUNK = 8 * 1024 * 1024


def _datasetKey(dataUrl):
    """A filesystem-safe directory name for a dataset URL. Collection-nested
    datasets have '/' in their path (a/b); keep them distinct but flat."""
    path = urllib.parse.urlparse(dataUrl).path.strip("/")
    if not path:
        path = urllib.parse.urlparse(dataUrl).netloc
    return path.replace("/", "__") or "dataset"


def _fetchToFile(url, destPath, onBytes=None):
    """Stream url to destPath (a .tmp path), chunked. Calls onBytes(nSoFar, total)
    as it goes so the caller can report progress; total is the Content-Length, or
    None if the server didn't send one. Raises on any HTTP/network error, and if
    fewer bytes arrive than Content-Length promised, so a dropped connection is
    never cached as a complete file."""
    req = urllib.request.Request(url, headers={"User-Agent": "cbDeWorker"})
    with _opener.open(req, timeout=120) as resp:
        try:
            total = int(resp.headers.get("Content-Length"))
        except (TypeError, ValueError):
            total = None
        got = 0
        with open(destPath, "wb") as out:
            while True:
                block = resp.read(_CHUNK)
                if not block:
                    break
                out.write(block)
                got += len(block)
                if onBytes:
                    onBytes(got, total)
    if total is not None and got != total:
        raise IOError("incomplete download of %s: got %d of %d bytes"
                      % (url, got, total))
    return got


def _fetchJson(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cbDeWorker"})
    with _opener.open(req, timeout=60) as resp:
        return json.load(resp)


def _dirBytes(path):
    """Bytes a directory actually occupies on disk. Uses allocated blocks
    (st_blocks*512), not apparent size: on /hive a 64 MB file can take ~128 MB of
    blocks, so counting st_size would let the cache grow to ~2x the intended cap."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.stat(os.path.join(root, f)).st_blocks * 512
            except OSError:
                pass
    return total


def _evict(cacheRoot, maxBytes, keepDir):
    """Delete whole <datasetKey>/<md5> version dirs, least-recently-used first
    (oldest mtime), until the cache is under maxBytes. Never touches keepDir (the
    version we just materialized) or a version whose fetch lock is currently held."""
    if not maxBytes or maxBytes <= 0:
        return
    versions = []   # (mtime, path, bytes)
    for name in os.listdir(cacheRoot):
        dsDir = os.path.join(cacheRoot, name)
        if not os.path.isdir(dsDir):
            continue
        for md5 in os.listdir(dsDir):
            vdir = os.path.join(dsDir, md5)
            if not os.path.isdir(vdir):
                continue
            try:
                versions.append((os.path.getmtime(vdir), vdir, _dirBytes(vdir)))
            except OSError:
                pass
    total = sum(v[2] for v in versions)
    if total <= maxBytes:
        return
    for mtime, vdir, nbytes in sorted(versions):     # oldest first
        if total <= maxBytes:
            break
        if os.path.abspath(vdir) == os.path.abspath(keepDir):
            continue
        # skip a version another job is actively fetching (its lock is held)
        lock = vdir.rstrip("/") + ".lock"
        if _isLocked(lock):
            continue
        shutil.rmtree(vdir, ignore_errors=True)
        total -= nbytes


def _isLocked(lockPath):
    """True if some process currently holds an exclusive flock on lockPath."""
    if not os.path.exists(lockPath):
        return False
    try:
        fd = os.open(lockPath, os.O_RDWR)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        os.close(fd)


def _complete(vdir):
    """True if a version dir already holds all four files (a finished fetch)."""
    return all(os.path.isfile(os.path.join(vdir, f)) for f in _NEEDED)


def ensureDataset(dataUrl, cacheRoot, maxBytes=0, status=None):
    """Ensure the dataset at dataUrl is present in the /hive cache and return the
    local directory holding its four cbBuild files.

    dataUrl   absolute base URL of the dataset dir (what the browser loaded from),
              e.g. https://cells-test.gi.ucsc.edu/cortex-dev
    cacheRoot directory on /hive to cache under
    maxBytes  LRU budget for the whole cache (0 = unbounded)
    status    optional callback status(msg) for progress (e.g. bytes downloaded)

    Raises ValueError if dataUrl is not on an allowed host (see checkDataUrl).
    """
    why = checkDataUrl(dataUrl)
    if why:
        raise ValueError(why)
    base = dataUrl.rstrip("/")
    # dataset.json is small and tells us the current build md5 (our version key),
    # so always fetch it fresh -- that is how a rebuilt dataset is detected.
    conf = _fetchJson(base + "/dataset.json")
    md5 = str(conf.get("md5") or "")
    if not md5:
        # no build md5 (unusual): fall back to a stable hash of the URL so the
        # cache still works, at the cost of not auto-refreshing on rebuild.
        md5 = "nomd5_" + hashlib.sha1(base.encode()).hexdigest()[:10]

    dsDir = os.path.join(cacheRoot, _datasetKey(base))
    vdir = os.path.join(dsDir, md5)
    os.makedirs(dsDir, exist_ok=True)

    if _complete(vdir):
        os.utime(vdir, None)     # bump mtime: most-recently-used
        return vdir

    # Serialize concurrent fetches of the same version (two jobs, one cold
    # dataset) so we download once. Whoever wins the lock fetches; the rest wait
    # and then find it complete.
    lockPath = vdir.rstrip("/") + ".lock"
    lockFd = os.open(lockPath, os.O_CREAT | os.O_RDWR, 0o664)
    try:
        fcntl.flock(lockFd, fcntl.LOCK_EX)
        if _complete(vdir):
            os.utime(vdir, None)
            return vdir

        # Download into a sibling temp dir, then atomically swap into place, so a
        # crashed/partial fetch never looks complete.
        tmp = vdir + ".tmp." + str(os.getpid())
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        # dataset.json we already have in memory; write it out.
        with open(os.path.join(tmp, "dataset.json"), "w") as fh:
            json.dump(conf, fh)
        for fname in ("exprMatrix.json", "meta.tsv", "exprMatrix.bin"):
            if status:
                status("Fetching %s" % fname)

            def onBytes(n, total, _f=fname):
                if status and _f == "exprMatrix.bin":
                    mb = 1024 * 1024
                    if total:
                        status("Fetching expression (%d of %d MB)"
                               % (n // mb, total // mb))
                    else:
                        status("Fetching expression (%d MB)" % (n // mb))
            try:
                _fetchToFile(base + "/" + fname, os.path.join(tmp, fname),
                             onBytes)
            except BaseException:
                # don't leave a partial download on /hive (it can be 100+ GB)
                shutil.rmtree(tmp, ignore_errors=True)
                raise

        shutil.rmtree(vdir, ignore_errors=True)
        os.replace(tmp, vdir)
        os.utime(vdir, None)
    finally:
        fcntl.flock(lockFd, fcntl.LOCK_UN)
        os.close(lockFd)

    # Enforce the LRU budget after landing a new version (keep the one we need).
    try:
        _evict(cacheRoot, maxBytes, keepDir=vdir)
    except Exception:
        pass   # eviction is best-effort; never fail a job over cache housekeeping
    return vdir
