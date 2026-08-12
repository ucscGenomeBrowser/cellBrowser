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
    scores = res["scores"]["pop1"]
    lfc = res["logfoldchanges"]["pop1"]
    pvals = res["pvals"]["pop1"]
    pvals_adj = res["pvals_adj"]["pop1"]

    genes = []
    for i in range(len(names)):
        genes.append({
            "symbol": str(names[i]),
            "logFC": _finite(lfc[i]),
            "pValue": _finite(pvals[i]),
            "fdr": _finite(pvals_adj[i]),
            "score": _finite(scores[i]),
        })

    # scanpy already orders by score; sort by FDR then descending |score| so the
    # output contract is explicit rather than relying on scanpy's internal order.
    genes.sort(key=lambda g: (g["fdr"], -abs(g["score"])))

    top_n = params.get("top_n")
    if top_n:
        genes = genes[:int(top_n)]
    return genes


def _finite(x):
    """JSON can't carry NaN/Inf — coerce to None so the result serializes."""
    x = float(x)
    if np.isnan(x) or np.isinf(x):
        return None
    return x
