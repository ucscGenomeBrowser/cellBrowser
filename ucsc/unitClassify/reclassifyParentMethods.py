#!/usr/bin/env python3
"""
Re-classify sub-datasets that have empty methods but whose parent has methods.
Updates the classified TSV in place.

Usage:
    python3 reclassifyParentMethods.py --dir /data/dir [--dry-run]
"""

import argparse, csv, json, os, re, html, subprocess, time

import unitPaths

DEFAULT_TSV = "float32_units_classified.tsv"
CALL_DELAY = 0.5

VALID_UNITS = {
    "UMI counts", "read counts", "log-normalized counts",
    "TPM", "log2(TPM+1)", "CPM", "log2(CPM+1)",
    "FPKM", "scTransform residuals", "unknown",
}

def strip_html(text):
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html.unescape(text)
    return re.sub(r'\s+', ' ', text).strip()

def load_desc(path):
    if not os.path.exists(path):
        return "", ""
    with open(path) as f:
        d = json.load(f)
    return strip_html(d.get("abstract") or ""), strip_html(d.get("methods") or "")

def call_claude(dataset_name, abstract, methods):
    prompt = (
        "You are helping classify the expression unit for a single-cell RNA-seq dataset.\n"
        "Given the methods and abstract below, what unit/normalization was used for the expression matrix?\n\n"
        "Reply with exactly one of these values and nothing else:\n"
        "  UMI counts\n"
        "  read counts\n"
        "  log-normalized counts\n"
        "  TPM\n"
        "  log2(TPM+1)\n"
        "  CPM\n"
        "  log2(CPM+1)\n"
        "  FPKM\n"
        "  scTransform residuals\n"
        "  unknown\n\n"
        f"Dataset: {dataset_name}\n"
        f"Abstract: {abstract[:1000]}\n"
        f"Methods: {methods[:2000]}"
    )
    result = subprocess.run(
        ["claude", "-p", "--model", "claude-haiku-4-5-20251001", prompt],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"claude exited {result.returncode}")
    raw = result.stdout.splitlines()[0].strip().strip('"').strip("'")
    if raw not in VALID_UNITS:
        print(f"  WARNING: unexpected response '{raw}', using 'unknown'")
        raw = "unknown"
    return raw

def main():
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", default=DEFAULT_TSV,
        help="classified TSV to update in place (default: %(default)s)")
    parser.add_argument("--dry-run", action="store_true",
        help="list the datasets that would be re-classified, without calling claude")
    unitPaths.add_common_args(parser)
    args = parser.parse_args()

    unitPaths.check_workdir(args.dir)
    tsv = unitPaths.resolve(args.file, args.dir)
    htdocs = args.htdocs

    # Targets: rows Claude already gave up on, whose own desc has no methods but
    # whose parent collection does.
    targets = {}  # dataset -> (abstract, parent_methods)
    with open(tsv) as f:
        for row in csv.DictReader(f, delimiter="\t"):
            if row["unit|str"] != "unknown" or row["basis"] != "claude cli":
                continue
            ds = row["dataset"]
            if "/" not in ds:
                continue
            own_abstract, own_methods = load_desc(os.path.join(htdocs, ds, "desc.json"))
            if own_methods.strip():
                continue  # has its own methods
            parent = ds.rsplit("/", 1)[0]
            _, parent_methods = load_desc(os.path.join(htdocs, parent, "desc.json"))
            if parent_methods.strip():
                targets[ds] = (own_abstract, parent_methods)

    print(f"Found {len(targets)} datasets to re-classify using parent methods")

    if args.dry_run:
        for ds in sorted(targets):
            print(f"  would re-classify {ds}")
        print(f"\nDry run, {tsv} not modified.")
        return

    updates = {}
    for ds, (abstract, methods) in sorted(targets.items()):
        try:
            unit = call_claude(ds, abstract, methods)
        except Exception as ex:
            print(f"  ERROR {ds}: {ex}")
            unit = "unknown"
        updates[ds] = unit
        print(f"  {ds} → {unit}")
        time.sleep(CALL_DELAY)

    # Rewrite in place via a temp file beside the target, so a crash mid-write
    # cannot truncate the only copy of the classifications.
    with open(tsv, newline="") as fin:
        header = next(csv.reader(fin, delimiter="\t"))
    tmp = tsv + ".tmp"
    with open(tsv, newline="") as fin, open(tmp, "w", newline="") as fout:
        writer = csv.writer(fout, delimiter="\t")
        writer.writerow(header)
        for row in csv.DictReader(fin, delimiter="\t"):
            ds = row["dataset"]
            if ds in updates:
                row["unit|str"] = updates[ds]
                row["basis"] = "claude cli (parent methods)"
            writer.writerow([row["dataset"], row["unit|str"],
                             row["confidence"], row["basis"]])
    os.replace(tmp, tsv)

    print(f"\nDone. Updated {len(updates)} rows in {tsv}")
    changed = {ds: u for ds, u in updates.items() if u != "unknown"}
    print(f"Changed from unknown to something else: {len(changed)}")
    for ds, u in sorted(changed.items()):
        print(f"  {ds} → {u}")


if __name__ == "__main__":
    main()
