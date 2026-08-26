#!/usr/bin/env python3
"""
Classify expression units for Float32 datasets using claude -p (Claude Code CLI).

Reads units_audit.tsv, processes Float32 rows with no current unit, and writes
float32_units.tsv with columns: dataset, unit|str, confidence, basis.

Datasets with no methods text are auto-assigned 'unknown' without a claude call.
Supports resuming: rows already in float32_units.tsv are skipped.

Usage:
    python3 classifyUnitsFloat.py --dir /data/dir [--dry-run] [--limit N]
"""

import csv
import json
import os
import re
import subprocess
import sys
import time
import argparse
import html

import unitPaths

AUDIT_TSV  = "units_audit.tsv"
OUTPUT_TSV = "float32_units.tsv"
CALL_DELAY = 0.2  # seconds between claude calls

# set from --htdocs in main(); load_desc() is called from several places
HTDOCS = unitPaths.DEFAULT_HTDOCS

VALID_UNITS = {
    "UMI counts",
    "read counts",
    "log-normalized counts",
    "TPM",
    "log2(TPM+1)",
    "CPM",
    "log2(CPM+1)",
    "FPKM",
    "scTransform residuals",
    "unknown",
}

# Keywords that strongly indicate a unit without needing Claude
HIGH_CONF_PATTERNS = [
    (r'\bscTransform\b',                     "scTransform residuals"),
    (r'\bSCTransform\b',                     "scTransform residuals"),
    (r'\bTPM\b',                             "TPM"),
    (r'log2\s*\(\s*TPM\s*[+]\s*1\s*\)',      "log2(TPM+1)"),
    (r'\bCPM\b',                             "CPM"),
    (r'log2\s*\(\s*CPM\s*[+]\s*1\s*\)',      "log2(CPM+1)"),
    (r'NormalizeData|normalize_total.*log1p|log.?normalize', "log-normalized counts"),
    (r'\bSMART-?[Ss]eq\b|\bplate.?based\b|\bfull.?length\b|\bCEL-?[Ss]eq\b', "read counts"),
]


def strip_html(text):
    text = re.sub(r'<[^>]+>', ' ', text)
    text = html.unescape(text)
    return re.sub(r'\s+', ' ', text).strip()


def load_desc(dataset_name):
    """Return (abstract, methods) strings from desc.json, or ('', '') if missing."""
    path = os.path.join(HTDOCS, dataset_name, "desc.json")
    if not os.path.exists(path):
        return "", ""
    try:
        with open(path) as f:
            d = json.load(f)
        abstract = strip_html(d.get("abstract") or "")
        methods  = strip_html(d.get("methods")  or "")
        return abstract, methods
    except Exception:
        return "", ""


def keyword_confidence(abstract, methods):
    """
    Return (unit, confidence) if a strong keyword match is found, else (None, None).
    Checks methods first, then abstract.
    """
    combined = methods + " " + abstract
    for pattern, unit in HIGH_CONF_PATTERNS:
        if re.search(pattern, combined):
            return unit, "high"
    return None, None


def call_claude(dataset_name, abstract, methods):
    """Invoke claude -p and return the classified unit string."""
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
    return result.stdout.strip()


def load_existing(output_path):
    """Return set of dataset names already in the output file."""
    done = {}
    if not os.path.exists(output_path):
        return done
    with open(output_path, newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            done[row["dataset"]] = row
    return done


def main():
    global HTDOCS
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be done without calling claude")
    parser.add_argument("--limit", type=int, default=0,
                        help="Stop after processing this many claude calls (0 = no limit)")
    parser.add_argument("--audit", default=AUDIT_TSV,
                        help="Audit TSV from auditUnits.py (default: %(default)s)")
    parser.add_argument("--output", default=OUTPUT_TSV,
                        help="Output TSV file (default: %(default)s)")
    parser.add_argument("--no-text-only", action="store_true",
                        help="Only process datasets with no text (auto-assign unknown, no claude calls)")
    unitPaths.add_common_args(parser)
    args = parser.parse_args()

    HTDOCS = args.htdocs
    unitPaths.check_workdir(args.dir)
    audit_tsv = unitPaths.resolve(args.audit, args.dir)
    output_tsv = unitPaths.resolve(args.output, args.dir)
    existing = load_existing(output_tsv)
    print(f"Already classified: {len(existing)} datasets", flush=True)

    # Read audit TSV, collect Float32 rows with no unit
    to_process = []
    with open(audit_tsv, newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            if row["matrixArrType"] == "Float32" and not row["current_unit"].strip():
                to_process.append(row["name"])

    print(f"Float32 datasets needing classification: {len(to_process)}", flush=True)
    remaining = [d for d in to_process if d not in existing]
    print(f"Remaining after skipping done: {len(remaining)}", flush=True)

    # Open output file for appending (create with header if new); skip in dry-run
    if not args.dry_run:
        write_header = not os.path.exists(output_tsv)
        outfile = open(output_tsv, "a", newline="")
        writer = csv.writer(outfile, delimiter="\t")
        if write_header:
            writer.writerow(["dataset", "unit|str", "confidence", "basis"])
    else:
        outfile = None
        writer = None

    api_calls = 0
    auto_unknown = 0

    for dataset in remaining:
        abstract, methods = load_desc(dataset)
        has_text = bool(abstract.strip() or methods.strip())

        if not has_text:
            # No text at all → unknown without claude call
            unit, confidence, basis = "unknown", "low", "no text available"
            auto_unknown += 1
        elif args.no_text_only:
            # Skip datasets that have text when --no-text-only is set
            continue
        else:
            # Try keyword match first
            kw_unit, kw_conf = keyword_confidence(abstract, methods)
            if kw_conf == "high":
                unit, confidence, basis = kw_unit, "high", "keyword match"
            elif args.dry_run:
                unit, confidence, basis = "?", "?", "would call API"
            else:
                # Call Claude
                try:
                    raw = call_claude(dataset, abstract, methods)
                except Exception as ex:
                    print(f"  ERROR {dataset}: {ex}", flush=True)
                    unit, confidence, basis = "unknown", "low", f"api error: {ex}"
                else:
                    # Take only the first line in case Claude adds explanation
                    raw = raw.splitlines()[0].strip().strip('"').strip("'")
                    if raw not in VALID_UNITS:
                        print(f"  WARNING: unexpected response '{raw}' for {dataset}, using 'unknown'")
                        raw = "unknown"
                    unit = raw
                    confidence = "medium"
                    basis = "claude cli"
                    api_calls += 1
                    time.sleep(CALL_DELAY)

                if args.limit and api_calls >= args.limit:
                    if writer:
                        writer.writerow([dataset, unit, confidence, basis])
                        outfile.flush()
                    print(f"  {dataset} → {unit} [{confidence}]", flush=True)
                    print(f"Limit of {args.limit} API calls reached. Stopping.", flush=True)
                    break

        if writer:
            writer.writerow([dataset, unit, confidence, basis])
            outfile.flush()
        print(f"  {dataset} → {unit} [{confidence}]", flush=True)

    if outfile:
        outfile.close()
    print(f"\nDone. API calls made: {api_calls}, auto-unknown: {auto_unknown}", flush=True)
    print(f"Output: {output_tsv}", flush=True)


if __name__ == "__main__":
    main()
