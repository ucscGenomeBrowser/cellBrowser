"""
Scanpy-free Wilcoxon differential expression (numpy + scipy only).

Computes exactly what scanpy's rank_genes_groups(method="wilcoxon") produces —
verified bit-for-bit against it on Float32 (pre-normalized) and Uint32
(normalize_total+log1p) datasets — but with no scanpy or AnnData, so the worker
runs on numpy+scipy and DE can be computed straight off the decoded matrix.

Matched to scanpy's implementation:
  - per-gene ranks over the COMBINED pop1+pop2 cells, average ties
    (scanpy's custom rankdata == scipy.stats.rankdata(axis=0))
  - reference path, NO tie correction (scanpy default):
        z = (R1 - n1*(N+1)/2) / sqrt(n1*n2*(N+1)/12),  N = n1+n2
        p = 2 * norm.sf(|z|)
  - log2FC: log2((expm1(meanA)+1e-9)/(expm1(meanB)+1e-9))
  - Benjamini-Hochberg FDR (== statsmodels fdr_bh)
AUC (Mann-Whitney effect size) falls out of the SAME ranks: U1/(n1*n2).

Gene-level filtering happens HERE, before the test, so the FDR correction reflects
only the retained genes:
  - low-expression: drop genes detected in fewer than `min_gene_cells` of the
    tested cells (like scanpy's filter_genes(min_cells=...))
  - category exclusions: mitochondrial / ribosomal / hemoglobin, all ON by
    default (they dominate a comparison for technical rather than biological
    reasons); a free-form `exclude_regex` adds to them.
The results-table thresholds (lfcCut / padjCut / minPct) are applied client-side
and are intentionally NOT part of this — they stay freely adjustable without a
re-run.

Input X is the (cells x genes) log-space matrix (sparse CSR or dense).
"""
import re

import numpy as np
from scipy import sparse as sp
from scipy.stats import rankdata, norm


# Gene categories excluded before the test — scanpy's mt/ribo/hb trio, all on by
# default. ribo is anchored so it hits structural ribosomal proteins (RPS6, RPL13A,
# RPLP0, RPSA) but NOT the RPS6-kinases or mito-ribosomal MRPL/MRPS genes.
_GENE_CATEGORIES = [
    ("exclude_mito", True, r"^(?:MT|mt)[-.]"),
    ("exclude_ribo", True, r"^(?:RP[SL]\d+[A-Z]*|RPLP\d+|RPSA|Rp[sl]\d+[a-z]*|Rplp\d+|Rpsa)$"),
    ("exclude_hemo", True, r"^(?:HB[ABDEGMQZ]|Hb[abq])\d*$"),
]


def resolve_filters(params=None):
    """The gene filters this kernel will apply, with defaults resolved — so results
    can be self-documenting (e.g. the downloaded CSV header). The FDR is computed
    over exactly the genes surviving these filters."""
    params = params or {}
    f = {
        "min_gene_cells": int(params.get("min_gene_cells", 3)),
        "min_pct": float(params.get("min_pct", 0.0)),
        "exclude_regex": params.get("exclude_regex"),
    }
    for key, default, _rx in _GENE_CATEGORIES:
        f[key] = bool(params.get(key, default))
    return f


def _excluded_gene_mask(var_names, params):
    """Boolean mask (over var_names) of genes to drop per the exclude_* flags,
    plus any custom exclude_regex (string or list)."""
    names = [str(g) for g in var_names]
    mask = np.zeros(len(names), dtype=bool)
    pats = [rx for key, default, rx in _GENE_CATEGORIES if params.get(key, default)]
    extra = params.get("exclude_regex")
    if extra:
        pats += [extra] if isinstance(extra, str) else list(extra)
    for rx in pats:
        pat = re.compile(rx)
        mask |= np.array([bool(pat.match(n)) for n in names])
    return mask


def _bh(pvals):
    """Benjamini-Hochberg adjusted p-values (same result as statsmodels fdr_bh)."""
    p = np.asarray(pvals, dtype=float).copy()
    p[np.isnan(p)] = 1.0
    n = p.size
    order = np.argsort(p)
    ranked = p[order] * n / np.arange(1, n + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]   # enforce monotonicity
    out = np.empty(n, dtype=float)
    out[order] = np.clip(ranked, 0.0, 1.0)
    return out


def _finite(x):
    x = float(x)
    return None if (np.isnan(x) or np.isinf(x)) else x


def wilcoxon_np(X, a_mask, b_mask, var_names, params=None, progress=None):
    """Two-group Wilcoxon DE of A vs B, numpy/scipy only. Returns a list of dicts
    (schema: symbol, log2FC, pValue, pAdj, auc, meanA, meanB, pctA, pctB), sorted
    by ascending adjusted p. `progress(frac, done, total)` is called during the
    rank loop, if given (the slow step on a large comparison)."""
    params = params or {}
    min_cells = int(params.get("min_cells", 10))          # floor per GROUP
    min_gene_cells = int(params.get("min_gene_cells", 3))  # low-expression gene filter

    a_idx = np.flatnonzero(np.asarray(a_mask, dtype=bool))
    b_idx = np.flatnonzero(np.asarray(b_mask, dtype=bool))
    n1, n2 = int(a_idx.size), int(b_idx.size)
    if n1 < min_cells or n2 < min_cells:
        raise ValueError("need >= %d cells per group (have %d / %d)"
                         % (min_cells, n1, n2))
    N = n1 + n2
    G = X.shape[1]
    var_names = np.asarray(var_names, dtype=object)

    # per-group mean (log space) + detection counts — cheap on sparse, all genes
    Xa, Xb = X[a_idx], X[b_idx]
    meanA = np.asarray(Xa.mean(axis=0)).ravel().astype(float)
    meanB = np.asarray(Xb.mean(axis=0)).ravel().astype(float)
    if sp.issparse(X):
        detA = np.asarray((Xa > 0).sum(axis=0)).ravel()
        detB = np.asarray((Xb > 0).sum(axis=0)).ravel()
    else:
        detA = (Xa > 0).sum(axis=0)
        detB = (Xb > 0).sum(axis=0)
    pctA = detA / max(n1, 1)
    pctB = detB / max(n2, 1)

    # ---- gene-level pre-filters (before the test -> FDR over the reported set) --
    # Two detection filters define the tested universe (== the downloaded set, ==
    # the FDR denominator): an absolute floor (min_gene_cells, detected in >= N in
    # at least one group, Seurat's min.cells.feature) and a fraction floor (min_pct,
    # detected in >= X of at least one group). Plus the mito/ribo/hemo categories.
    min_pct = float(params.get("min_pct", 0.0))
    keep = ~_excluded_gene_mask(var_names, params)          # mito/ribo/hemo/custom
    keep &= np.maximum(detA, detB) >= min_gene_cells        # low-expression (count)
    if min_pct > 0:
        keep &= np.maximum(pctA, pctB) >= min_pct           # low-expression (fraction)
    if not keep.any():                                      # never drop every gene
        keep[:] = True
    kcols = np.flatnonzero(keep)

    # ---- rank sums of A over the combined cells, kept genes only, in chunks --
    both = np.concatenate([a_idx, b_idx])
    Xsub = X[both]
    if sp.issparse(Xsub):
        Xsub = Xsub.tocsc()                                # cheap column slicing
    R1 = np.empty(kcols.size, dtype=float)
    total = kcols.size
    step = max(1, 2_000_000 // max(N, 1))
    for lo in range(0, total, step):
        cols = kcols[lo:lo + step]
        block = Xsub[:, cols]
        block = block.toarray() if sp.issparse(block) else np.asarray(block)
        ranks = rankdata(block, axis=0)                    # average ties, per gene
        R1[lo:lo + step] = ranks[:n1].sum(axis=0)
        if progress is not None:
            done = min(lo + step, total)
            progress(done / total, done, total)

    std = np.sqrt(n1 * n2 * (N + 1) / 12.0)
    z = (R1 - n1 * (N + 1) / 2.0) / std
    z[np.isnan(z)] = 0.0
    pvals = 2.0 * norm.sf(np.abs(z))
    auc = (R1 - n1 * (n1 + 1) / 2.0) / (n1 * n2)           # U1/(n1*n2)
    lfc = np.log2((np.expm1(meanA[kcols]) + 1e-9) / (np.expm1(meanB[kcols]) + 1e-9))
    padj = _bh(pvals)                                       # over kept genes only

    genes = []
    for j, c in enumerate(kcols):
        genes.append({
            "symbol": str(var_names[c]),
            "log2FC": _finite(lfc[j]),
            "pValue": _finite(pvals[j]),
            "pAdj": _finite(padj[j]),
            "auc": _finite(auc[j]),
            "meanA": _finite(meanA[c]),
            "meanB": _finite(meanB[c]),
            "pctA": _finite(pctA[c]),
            "pctB": _finite(pctB[c]),
        })
    genes.sort(key=lambda g: (g["pAdj"] if g["pAdj"] is not None else 2.0))
    top_n = params.get("top_n")
    if top_n:
        genes = genes[:int(top_n)]
    return genes


def run_wilcoxon(adata, pop1_mask, pop2_mask, params=None):
    """Adapter matching methods/wilcoxon.py's signature, so runDeJob can call this
    kernel unchanged. Reads .X and .var_names off the AnnData the reader builds."""
    return wilcoxon_np(adata.X, pop1_mask, pop2_mask, list(adata.var_names), params)
