"""
Read the uniform cbBuild expression output (exprMatrix.bin + exprMatrix.json +
meta.tsv) so the DE worker can run on any published dataset without a source
.h5ad. This is the Python port of the reader in cbData.js (loadExprVec /
gunzipAndConvert); it decodes the SAME files the web frontend serves, so DE runs
on exactly the numbers the user sees in the browser.

Record format (see cellbrowser.py exprEncode / cbData.js loadExprVec):
    a per-gene record in exprMatrix.bin is zlib-compressed and, once inflated:
      - 2 bytes  : uint16 length of the descriptor string (little-endian)
      - descLen  : the descriptor string (ascii; the gene id/symbol)
      - N*itemsize bytes : the expression vector, N = sampleCount, one value per
                           cell, dtype given by dataset.json "matrixArrType"
    exprMatrix.json maps geneKey -> [byteOffset, byteLength] into exprMatrix.bin.
    meta.tsv is a tab-separated table, first column = cellId, one row per cell in
    matrix-column order.

cbData.js hardcodes 4 bytes/value (it only ever built Float32/Uint32/Int32);
here we honor the true itemsize of the declared dtype so the reader stays correct
if that ever changes. A handful of old datasets on disk are mis-built (bin is
8-byte but matrixArrType says Uint32) and the browser misrenders them too; we
raise a clear error rather than silently returning garbage.
"""
import csv
import itertools
import json
import os
import struct
import zlib
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import scipy.sparse as sp

# matrixArrType (cbData.js makeType) -> numpy dtype. Little-endian to match the
# struct.pack("<...") the builder uses.
_DTYPE = {
    "double": "<f8", "float64": "<f8",
    "float": "<f4", "float32": "<f4",
    "int32": "<i4",
    "uint32": "<u4", "dword": "<u4",
    "uint16": "<u2", "word": "<u2",
    "uint8": "<u1", "byte": "<u1",
}


def _numpyDtype(matrixArrType):
    dt = _DTYPE.get(str(matrixArrType).lower())
    if dt is None:
        raise ValueError("unknown matrixArrType %r" % matrixArrType)
    return np.dtype(dt)


def defaultThreads():
    """Threads for inflating gene records: DE_READ_THREADS if set, else
    DE_CPU_LIMIT (the job's CPU cap), capped at 16 and at the host's cores."""
    val = os.environ.get("DE_READ_THREADS") or os.environ.get("DE_CPU_LIMIT")
    try:
        n = int(val) if val else 16
    except ValueError:
        n = 16
    return max(1, min(n, 16, os.cpu_count() or 1))


class CbExprReader:
    """Decoder for one cbBuild output directory."""

    def __init__(self, datasetDir):
        self.dir = datasetDir
        confPath = os.path.join(datasetDir, "dataset.json")
        with open(confPath) as fh:
            self.conf = json.load(fh)
        self.sampleCount = int(self.conf["sampleCount"])
        self.dtype = _numpyDtype(self.conf["matrixArrType"])
        self.itemsize = self.dtype.itemsize

        with open(os.path.join(datasetDir, "exprMatrix.json")) as fh:
            self.offsets = json.load(fh)          # geneKey -> [offset, length]
        # Underscore-prefixed keys (e.g. "_range" for ATAC datasets) are not
        # genes; cbData.js skips them and so do we.
        self.geneKeys = [k for k in self.offsets  # var order == matrix order
                         if not k.startswith("_")]
        # display symbol: the part after "|" (cbBuild's "geneId|symbol"), else the key
        self.geneSyms = [k.split("|", 1)[1] if "|" in k else k
                         for k in self.geneKeys]
        self.binPath = os.path.join(datasetDir, "exprMatrix.bin")
        self._binFh = None

    # -- expression -------------------------------------------------------

    def _fh(self):
        if self._binFh is None:
            self._binFh = open(self.binPath, "rb")
        return self._binFh

    def readGene(self, geneKey):
        """Decode one gene's expression vector (length sampleCount).

        Reads with os.pread (no shared file position), so several threads can
        call this at once on the same reader."""
        off, length = self.offsets[geneKey]
        fd = self._fh().fileno()
        comp = os.pread(fd, int(length), int(off))
        if len(comp) != int(length):
            raise ValueError("%s: short read from exprMatrix.bin" % geneKey)
        expected = self.itemsize * self.sampleCount
        # Size the output buffer up front (vector + header; the descriptor is a
        # short gene id) so zlib doesn't grow it in steps, and slice through a
        # memoryview so the vector isn't copied again.
        raw = memoryview(zlib.decompress(comp, bufsize=expected + 1024))
        descLen = struct.unpack("<H", raw[:2])[0]
        body = raw[2 + descLen:]
        if len(body) != expected:
            raise ValueError(
                "%s: expression record is %d bytes, expected %d "
                "(%d cells x %d-byte %s). Dataset is mis-built; "
                "matrixArrType does not match exprMatrix.bin."
                % (geneKey, len(body), expected, self.sampleCount,
                   self.itemsize, self.conf["matrixArrType"]))
        return np.frombuffer(body, dtype=self.dtype)

    def _mapGenes(self, fn, threads):
        """Yield fn(geneKey) for every gene, in matrix order.

        Most of a big job's time is inflating gene records; zlib and numpy drop
        the GIL, so a thread pool scales close to linearly. At most 2*threads
        genes are in flight, which bounds the extra memory to about 2*threads
        full-length gene vectors."""
        keys = self.geneKeys
        if threads <= 1 or len(keys) < 2:
            for key in keys:
                yield fn(key)
            return
        window = 2 * threads
        with ThreadPoolExecutor(max_workers=threads) as pool:
            pending = deque()
            it = iter(keys)
            for key in itertools.islice(it, window):
                pending.append(pool.submit(fn, key))
            while pending:
                result = pending.popleft().result()
                nxt = next(it, None)
                if nxt is not None:
                    pending.append(pool.submit(fn, nxt))
                yield result

    def readMatrix(self, cellIdx=None, sparse=True, threads=None):
        """Build a (n_cells x n_genes) float32 matrix.

        cellIdx : optional 1-D int array of cell (row) positions to keep. When
                  given, only those cells are materialized — this is how the DE
                  worker avoids reading a whole 2M-cell matrix: it resolves the
                  two populations from metadata first, then reads just their union.
        sparse  : return a scipy CSR matrix (default). Single-cell matrices are
                  ~90% zeros, so this is the memory difference between a feasible
                  one-vs-rest on a large atlas and an OOM. Pass False for a dense
                  ndarray (handy for small tests).

        Genes are decoded a few at a time (each is a column), so peak memory is
        about 2*threads gene vectors plus the accumulated nonzeros — never a dense
        n_cells x n_genes block.
        threads : how many genes to inflate at once. None = defaultThreads().
        """
        if threads is None:
            threads = defaultThreads()
        if cellIdx is None:
            rows = self.sampleCount
            take = None
        else:
            cellIdx = np.asarray(cellIdx, dtype=int)
            rows = cellIdx.size
            take = cellIdx
        nGenes = len(self.geneKeys)

        if not sparse:
            M = np.empty((rows, nGenes), dtype=np.float32)
            cols = self._mapGenes(
                lambda key: (self.readGene(key) if take is None
                             else self.readGene(key)[take]), threads)
            for j, vec in enumerate(cols):
                M[:, j] = vec
            return M

        def column(key):
            vec = self.readGene(key)
            if take is not None:
                vec = vec[take]
            nz = np.flatnonzero(vec)
            return nz.astype(np.int32), vec[nz].astype(np.float32)

        data, indices, indptr = [], [], [0]   # CSC: one column per gene
        for nz, vals in self._mapGenes(column, threads):
            indices.append(nz)
            data.append(vals)
            indptr.append(indptr[-1] + nz.size)
        data = np.concatenate(data) if data else np.zeros(0, np.float32)
        indices = (np.concatenate(indices) if indices
                   else np.zeros(0, np.int32))
        M = sp.csc_matrix((data, indices, np.asarray(indptr, dtype=np.int64)),
                          shape=(rows, nGenes))
        return M.tocsr()   # scanpy/AnnData prefer CSR

    # -- metadata ---------------------------------------------------------

    def readMeta(self):
        """Return (cellIds list, obs dict of column->list) from meta.tsv.
        Row order matches the expression-matrix column order."""
        import pandas as pd
        path = os.path.join(self.dir, "meta.tsv")
        df = pd.read_csv(path, sep="\t", dtype=str, keep_default_na=False,
                         quoting=csv.QUOTE_NONE)
        cellIds = df.iloc[:, 0].astype(str).tolist()
        if len(cellIds) != self.sampleCount:
            raise ValueError(
                "meta.tsv has %d rows but sampleCount is %d"
                % (len(cellIds), self.sampleCount))
        df.index = cellIds
        return cellIds, df

    def close(self):
        if self._binFh is not None:
            self._binFh.close()
            self._binFh = None


def _should_normalize(dtype, normalize):
    """Whether to total-normalize + log1p. "auto" does it for integer dtypes (raw
    counts); float matrices are cbScanpy's already-log-normalized values."""
    return normalize == "log1p" or (
        normalize == "auto" and np.issubdtype(dtype, np.integer))


def _normalize_total_log1p(X, target_sum=1e4):
    """numpy/scipy port of scanpy's normalize_total(target_sum) + log1p (natural
    log) — so the runtime path needs no scanpy. Each cell is scaled to `target_sum`
    total counts, then log1p'd; zero-count cells stay zero. Sparsity-preserving.

    Wilcoxon p-values and AUC are invariant to this monotonic per-gene transform,
    so it only affects log2FC and the reported group means (the log-space display).
    """
    if sp.issparse(X):
        X = X.tocsr()
        row = np.asarray(X.sum(axis=1)).ravel()
        inv = np.zeros(row.shape, dtype=X.dtype)
        nz = row > 0
        inv[nz] = (target_sum / row[nz]).astype(X.dtype)
        X = (sp.diags(inv) @ X).tocsr()
        X.data = np.log1p(X.data)
        return X
    X = np.asarray(X, dtype=np.float32)
    row = X.sum(axis=1, keepdims=True)
    inv = np.divide(target_sum, row, out=np.zeros_like(row), where=row > 0)
    return np.log1p(X * inv)


def readExpr(datasetDir, cellIdx=None, normalize="auto", sparse=True):
    """Decode a cbBuild output dir to (X, var_names): the (cells x genes) matrix
    (optionally only the `cellIdx` rows — the pop1|pop2 union) and the gene symbols.
    No AnnData, no scanpy — this is what the DE kernel needs; populations are
    resolved from meta.tsv separately (see runDeJob)."""
    r = CbExprReader(datasetDir)
    try:
        X = r.readMatrix(cellIdx, sparse=sparse)
        var_names = list(r.geneSyms)
        dtype = r.dtype
    finally:
        r.close()
    if _should_normalize(dtype, normalize):
        X = _normalize_total_log1p(X)
    return X, var_names


def readAnnData(datasetDir, cellIdx=None, normalize="auto", sparse=True):
    """Decode into an AnnData (cells x genes). Convenience for testing / the
    scanpy validation oracle — the runtime path uses readExpr and needs neither
    anndata nor scanpy. Uses the same numpy normalization as readExpr."""
    import anndata as ad
    import pandas as pd

    r = CbExprReader(datasetDir)
    try:
        _cellIds, obs = r.readMeta()
        X = r.readMatrix(cellIdx, sparse=sparse)
        if cellIdx is not None:
            obs = obs.iloc[np.asarray(cellIdx, dtype=int)]
        var = pd.DataFrame(index=pd.Index(r.geneSyms, name=None))
        var["geneKey"] = r.geneKeys
        dtype = r.dtype
    finally:
        r.close()
    if _should_normalize(dtype, normalize):
        X = _normalize_total_log1p(X)
    return ad.AnnData(X=X, obs=obs, var=var)
