"""
Phase 1 differential-expression kernel: Scanpy Wilcoxon rank-sum test.

Pure compute — no I/O, no job/queue concepts. Given an AnnData and two boolean
cell masks, return a ranked list of differentially expressed genes. This is the
piece that runs on the worker (hgcompute-08) and the only piece that depends on
scanpy; keeping it free of transport concerns makes it testable in isolation.

Statistics note: treats each cell as an independent observation (the standard
single-cell exploratory approach). It inflates significance via pseudoreplication
and is not a substitute for a replicate-aware method — Memento (Phase 2) is the
sounder long-term target. Good enough for interactive exploration.

Input expectations: adata.X is log-normalized expression (what cbScanpy writes).
rank_genes_groups operates on that directly.
"""
import numpy as np
import scanpy as sc


def run_wilcoxon(adata, pop1_mask, pop2_mask, params=None):
    """Two-group Wilcoxon DE of pop1 vs pop2.

    adata      : AnnData, log-normalized expression in .X
    pop1_mask  : boolean array over adata.n_obs — the group of interest
    pop2_mask  : boolean array over adata.n_obs — the reference group
    params     : optional dict; recognized keys:
                   min_cells (int, default 10) — floor per group
                   top_n     (int, default None) — cap returned genes

    Returns a list of dicts sorted by ascending FDR:
        {"symbol": str, "logFC": float, "pValue": float, "fdr": float,
         "score": float}
    logFC is log2 fold change of pop1 over pop2 (scanpy convention).
    Raises ValueError if either group is below min_cells or they overlap.
    """
    params = params or {}
    min_cells = int(params.get("min_cells", 10))

    pop1_mask = np.asarray(pop1_mask, dtype=bool)
    pop2_mask = np.asarray(pop2_mask, dtype=bool)
    if pop1_mask.shape[0] != adata.n_obs or pop2_mask.shape[0] != adata.n_obs:
        raise ValueError("population masks must match adata.n_obs")

    overlap = int(np.count_nonzero(pop1_mask & pop2_mask))
    if overlap:
        raise ValueError("pop1 and pop2 overlap in %d cells" % overlap)

    n1 = int(np.count_nonzero(pop1_mask))
    n2 = int(np.count_nonzero(pop2_mask))
    if n1 < min_cells:
        raise ValueError("pop1 has %d cells, need >= %d" % (n1, min_cells))
    if n2 < min_cells:
        raise ValueError("pop2 has %d cells, need >= %d" % (n2, min_cells))

    # Build a two-level grouping column and subset to just those cells. Working
    # on the subset (rather than the whole matrix) keeps the test to the two
    # populations and speeds up rank_genes_groups.
    group = np.full(adata.n_obs, "", dtype=object)
    group[pop1_mask] = "pop1"
    group[pop2_mask] = "pop2"
    keep = pop1_mask | pop2_mask

    sub = adata[keep].copy()
    sub.obs["_deGroup"] = group[keep].astype(str)
    sub.obs["_deGroup"] = sub.obs["_deGroup"].astype("category")

    sc.tl.rank_genes_groups(
        sub,
        groupby="_deGroup",
        groups=["pop1"],
        reference="pop2",
        method="wilcoxon",
    )

    res = sub.uns["rank_genes_groups"]
    names = res["names"]["pop1"]
    lfc = res["logfoldchanges"]["pop1"]
    pvals = res["pvals"]["pop1"]
    pvals_adj = res["pvals_adj"]["pop1"]

    # Descriptive stats the UI shows: per-group mean expression, % expressing, and
    # AUC (effect size). log2FC/p-adj come from scanpy above.
    a_sub = (sub.obs["_deGroup"] == "pop1").to_numpy()
    b_sub = ~a_sub
    meanA, meanB, pctA, pctB = _group_means_pct(sub.X, a_sub, b_sub)
    auc = _auc_per_gene(sub.X, a_sub, b_sub)
    col = {g: i for i, g in enumerate(sub.var_names)}  # var order -> the arrays above

    genes = []
    for i in range(len(names)):
        sym = str(names[i])
        c = col.get(sym)
        genes.append({
            "symbol": sym,
            "log2FC": _finite(lfc[i]),
            "pValue": _finite(pvals[i]),
            "pAdj": _finite(pvals_adj[i]),
            "auc": None if c is None else _finite(auc[c]),
            "meanA": None if c is None else _finite(meanA[c]),
            "meanB": None if c is None else _finite(meanB[c]),
            "pctA": None if c is None else _finite(pctA[c]),
            "pctB": None if c is None else _finite(pctB[c]),
        })

    # order by ascending adjusted p (the client re-sorts; default there is AUC)
    genes.sort(key=lambda g: (g["pAdj"] if g["pAdj"] is not None else 2.0))

    top_n = params.get("top_n")
    if top_n:
        genes = genes[:int(top_n)]
    return genes


def _densify(X):
    import scipy.sparse as sp
    return X.toarray() if sp.issparse(X) else np.asarray(X)


def _group_means_pct(X, a_sub, b_sub):
    """Per-gene mean expression and fraction expressing (non-zero), per group.
    Works directly on sparse — cheap, uses the full cell set."""
    import scipy.sparse as sp
    Xa, Xb = X[a_sub], X[b_sub]
    na, nb = int(a_sub.sum()), int(b_sub.sum())
    meanA = np.asarray(Xa.mean(axis=0)).ravel()
    meanB = np.asarray(Xb.mean(axis=0)).ravel()
    if sp.issparse(X):
        pctA = np.asarray((Xa > 0).sum(axis=0)).ravel() / max(na, 1)
        pctB = np.asarray((Xb > 0).sum(axis=0)).ravel() / max(nb, 1)
    else:
        pctA = (Xa > 0).mean(axis=0)
        pctB = (Xb > 0).mean(axis=0)
    return meanA, meanB, pctA, pctB


def _auc_per_gene(X, a_sub, b_sub, cap=2500):
    """Mann-Whitney AUC per gene = P(expr in A > expr in B): 0.5 = no separation,
    1 = always higher in A. Ranks are computed on a densified (optionally
    subsampled, to bound memory) cell subset."""
    from scipy.stats import rankdata
    a_idx = np.flatnonzero(a_sub)
    b_idx = np.flatnonzero(b_sub)
    # deterministic subsample for the ranking if a group is very large
    if a_idx.size > cap:
        a_idx = a_idx[np.linspace(0, a_idx.size - 1, cap).astype(int)]
    if b_idx.size > cap:
        b_idx = b_idx[np.linspace(0, b_idx.size - 1, cap).astype(int)]
    n1, n2 = a_idx.size, b_idx.size
    both = np.concatenate([a_idx, b_idx])
    M = _densify(X[both])                      # (n1+n2) x n_genes
    ranks = rankdata(M, axis=0)                # rank each gene column
    R1 = ranks[:n1].sum(axis=0)                # sum of A-ranks per gene
    U1 = R1 - n1 * (n1 + 1) / 2.0
    return U1 / (n1 * n2)


def _finite(x):
    """JSON can't carry NaN/Inf — coerce to None so the result serializes."""
    x = float(x)
    if np.isnan(x) or np.isinf(x):
        return None
    return x
