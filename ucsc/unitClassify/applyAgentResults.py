#!/usr/bin/env python3
"""
Apply DOI/URL/GEO lookup results to the classified TSV.
Only updates rows currently classified as 'unknown'.
Uses prefix matching against dataset names.

The lookup table below is inline on purpose: it records which paper settled
which dataset, so it doubles as the provenance for those rows.

Usage:
    python3 applyAgentResults.py --dir /data/dir [--dry-run]
"""

import argparse, csv, os, shutil, sys

import unitPaths

DEFAULT_TSV = "float32_units_classified.tsv"

# (prefix, unit, confidence, basis)
# Longer/more-specific prefixes must come before shorter ones that would
# otherwise shadow them (e.g. kidney-atlas/fetal before kidney-atlas).
PREFIX_UPDATES = [
    # --- Agent 2: bioRxiv preprints ---
    ("retina/hrca/snrna",             "log-normalized counts", "high",   "doi:10.1101/2023.11.07.566105"),
    ("retina/hrca/scrna/chen",        "log-normalized counts", "high",   "doi:10.1101/2023.11.07.566105"),
    ("tabula-microcebus",             "log-normalized counts", "high",   "doi:10.1101/2021.12.12.469460"),
    ("neural-tube-organoids",         "log-normalized counts", "high",   "doi:10.1101/2025.05.23.655442"),
    ("fly-cell-atlas",                "log-normalized counts", "high",   "doi:10.1101/2021.07.04.451050"),

    # --- Agent 1: PubMed DOI lookups ---
    ("mosquito",                      "log-normalized counts", "high",   "doi:10.1016/j.cell.2025.10.008"),
    ("fetal-lung-atlas",              "log-normalized counts", "high",   "doi:10.1016/j.cell.2022.11.005"),
    # rosmap-ad-aging-brain unknowns are all snATAC-seq — skip (wrong vocab)
    # ("rosmap-ad-aging-brain",       "log-normalized counts", "high",   "pubmed doi lookup"),
    ("hoc",                           "log-normalized counts", "high",   "pubmed doi lookup"),
    ("human-intestine",               "log-normalized counts", "high",   "pubmed doi lookup"),
    ("hnoca",                         "log-normalized counts", "high",   "pubmed doi lookup"),
    ("tissue-stability",              "log-normalized counts", "high",   "pubmed doi lookup"),
    ("ms-cross-regional",             "scTransform residuals", "high",   "pubmed doi lookup"),
    ("rat-liver-atlas",               "scTransform residuals", "high",   "pubmed doi lookup"),
    # Only RNA sub-datasets — snATAC sub-datasets are skipped (wrong vocab)
    ("multiomic-cortex/rnaseq",       "scTransform residuals", "high",   "pubmed doi lookup"),
    ("zebrafish-heart",               "scTransform residuals", "high",   "pubmed doi lookup"),
    ("multiomic-human-heart/rna",     "UMI counts",            "high",   "pubmed doi lookup"),
    ("multiomic-human-heart/subset",  "UMI counts",            "high",   "pubmed doi lookup"),
    ("sami",                          "UMI counts",            "high",   "pubmed doi lookup"),
    ("melanoma",                      "log2(TPM+1)",           "high",   "pubmed doi lookup"),
    ("macaque-brain-aging",           "log-normalized counts", "high",   "pubmed doi lookup"),
    ("dev-mammal-inhibneurons",       "log-normalized counts", "high",   "pubmed doi lookup"),
    ("cortical-lineage-perturb-44tf", "log-normalized counts", "medium", "pubmed doi lookup"),
    ("gbm-nvp",                       "log-normalized counts", "high",   "pubmed doi lookup"),
    ("hydractinia",                   "log-normalized counts", "high",   "pubmed doi lookup"),

    # --- Agent 4: URL + GEO lookups ---
    ("acute-myeloid-leuk",            "log-normalized counts", "high",   "scpca url lookup"),
    ("dr-marrow-thymus",              "scTransform residuals", "high",   "url lookup"),
    ("choroid-rpe-dev",               "log-normalized counts", "high",   "url lookup"),
    ("fetal-thymus",                  "log-normalized counts", "high",   "url lookup"),
    ("ciona-cao",                     "log-normalized counts", "high",   "url lookup"),
    ("kidney-atlas/fetal",            "log-normalized counts", "high",   "url lookup"),
    ("kidney-atlas/mature-full",      "log-normalized counts", "low",    "url lookup"),
    ("mouse-embryonic-pancreas",      "log-normalized counts", "high",   "url lookup"),
    ("primate-brain-regions",         "log-normalized counts", "high",   "url lookup"),
    ("mouse-kidney-sepsis",           "log-normalized counts", "high",   "geo lookup"),
    ("marmoset-eae-ms",               "log-normalized counts", "high",   "geo lookup"),
    ("lepto-metastasis",              "log-normalized counts", "high",   "geo lookup"),
    ("morphogen-screen",              "scTransform residuals", "high",   "geo lookup"),
    ("dev-whole-brain-hqm",           "UMI counts",            "high",   "geo lookup"),
    ("lung-airway/boucher-epithelium",  "UMI counts",            "high",   "geo lookup"),
    ("lung-airway/stripp-epithelium",  "UMI counts",            "high",   "geo lookup"),
    ("mouse-hsc",                     "log-normalized counts", "high",   "geo lookup"),
    ("human-colon",                   "log2(TPM+1)",           "high",   "url lookup"),
    ("human-cornea",                  "log-normalized counts", "high",   "url lookup"),
    ("mouse-lvcp-multiome",           "UMI counts",            "high",   "geo lookup"),
    ("shalek-alexandria-project",     "log-normalized counts", "high",   "url lookup"),

    # --- Agent 3 (re-run): Nature/Cell/Science papers via PMC full text ---
    ("tabula-muris-senis",            "log-normalized counts", "high",   "doi:10.1038/s41586-020-2496-1 PMC8240505"),
    ("tabulamuris",                   "log-normalized counts", "high",   "doi:10.1038/s41586-018-0590-4 PMC6642641"),
    ("evocell",                       "log-normalized counts", "high",   "doi:10.1038/s41586-018-0590-4 PMC6642641"),
    ("dev-inhibitory-neurons",        "log-normalized counts", "high",   "doi:10.1038/s41586-022-04510-w PMC8967711"),
    ("airway-cf",                     "scTransform residuals", "high",   "doi:10.1038/s41591-021-01332-7 PMC9009537"),
    ("mouse-limb",                    "log-normalized counts", "high",   "doi:10.1038/s41586-020-2536-x PMC7410830"),
    ("organoidreportcard",            "log-normalized counts", "high",   "doi:10.1038/s41586-020-1962-0 PMC7433012"),
    ("placenta-decidua",              "log-normalized counts", "high",   "doi:10.1038/s41586-018-0698-6 PMC7612850"),
    ("dev-brain-regions",             "log-normalized counts", "high",   "doi:10.1038/s41586-021-03910-8 PMC8494648"),
    ("gut-cell-atlas",                "log-normalized counts", "high",   "doi:10.1038/s41586-021-03852-1 PMC8426186"),
    ("heart-cell-atlas",              "log-normalized counts", "high",   "doi:10.1038/s41586-020-2797-4 PMC7681775"),
    ("teichmann-asthma",              "log-normalized counts", "high",   "doi:10.1038/s41591-019-0468-5 Seurat NormalizeData"),
    ("covid19-immuno",                "log-normalized counts", "high",   "doi:10.1038/s41590-020-0762-x NormalizeData confirmed"),
    ("covid-airways",                 "log-normalized counts", "medium", "doi:10.1038/s41587-020-0602-4 inferred 10x pipeline"),

    # --- Additional DOI lookups ---
    ("adult-brain-vasc",              "scTransform residuals", "high",   "doi:10.1126/science.abi7377 PMC8995178"),
    ("storming-cancer",               "log-normalized counts", "medium", "doi:10.1126/science.aaw2368 10x CellRanger v3 inferred"),
    ("mouse-mammary-epithelium-integrated", "log-normalized counts", "high", "doi:10.1038/s42003-021-02201-2 PMC8172904"),
    ("morphogen",                     "scTransform residuals", "medium", "doi:10.1038/s41592-025-02927-5 PMC12904787 primary analysis"),
    # RNA sub-datasets from olg-eae-ms multiome (ATAC sub-datasets left as unknown)
    ("olg-eae-ms/eae-atac/rna",       "log-normalized counts", "medium", "doi:10.1016/j.neuron Meijer multiome RNA inferred"),
    ("olg-eae-ms/eae-multiomics/rna", "log-normalized counts", "medium", "doi:10.1016/j.neuron Meijer multiome RNA inferred"),
    ("olg-eae-ms/human-multiomics-control/rna", "log-normalized counts", "medium", "doi:10.1016/j.neuron Meijer multiome RNA inferred"),
]

def find_update(dataset):
    for prefix, unit, conf, basis in PREFIX_UPDATES:
        # Match exact name OR sub-path (separated by / or -)
        if dataset == prefix or dataset.startswith(prefix + "/") or dataset.startswith(prefix + "-"):
            return unit, conf, basis
    return None, None, None


parser = argparse.ArgumentParser(description=__doc__,
    formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--file", default=DEFAULT_TSV,
    help="classified TSV to update in place (default: %(default)s)")
parser.add_argument("--dry-run", action="store_true",
    help="report what would change without writing")
unitPaths.add_common_args(parser)
args = parser.parse_args()

dry_run = args.dry_run
unitPaths.check_workdir(args.dir)
OUTPUT_TSV = unitPaths.resolve(args.file, args.dir)

# Read all rows
rows = []
with open(OUTPUT_TSV, newline="") as f:
    reader = csv.DictReader(f, delimiter="\t")
    fieldnames = reader.fieldnames
    for row in reader:
        rows.append(row)

updated = 0
by_prefix = {}
for row in rows:
    if row["unit|str"] != "unknown":
        continue
    new_unit, new_conf, new_basis = find_update(row["dataset"])
    if new_unit is None:
        continue
    prefix_used = next(p for p, u, c, b in PREFIX_UPDATES
                       if row["dataset"] == p or row["dataset"].startswith(p + "/") or row["dataset"].startswith(p + "-"))
    by_prefix.setdefault(prefix_used, []).append(row["dataset"])
    if not dry_run:
        row["unit|str"]    = new_unit
        row["confidence"]  = new_conf
        row["basis"]       = new_basis
    updated += 1

print(f"{'[DRY RUN] ' if dry_run else ''}Datasets to update: {updated}")
print()
for prefix, datasets in sorted(by_prefix.items(), key=lambda x: -len(x[1])):
    unit, conf, basis = next((u, c, b) for p, u, c, b in PREFIX_UPDATES if p == prefix)
    print(f"  {prefix!r} ({len(datasets)}) → {unit!r}  [{conf}]  basis={basis}")
    if len(datasets) <= 5:
        for ds in datasets:
            print(f"    {ds}")

if not dry_run:
    tmp = OUTPUT_TSV + ".tmp"
    with open(tmp, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)
    shutil.move(tmp, OUTPUT_TSV)
    print(f"\nWrote {OUTPUT_TSV}")
