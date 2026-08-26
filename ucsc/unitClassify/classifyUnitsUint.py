#!/usr/bin/env python3
"""
Classify expression units for Uint32 (integer matrix) datasets.

Reads the audit TSV produced by auditUnits.py, scans methods + abstract text
for plate-based protocol keywords, and outputs a TSV ready for addTags.

Usage:
  python3 classifyUnitsUint.py units_audit.tsv -o uint32_units.tsv --dir /data/dir
  python3 classifyUnitsUint.py units_audit.tsv > uint32_units.tsv   # stdout still works
"""

import argparse, csv, json, os, re, sys

import unitPaths

PLATE_KEYWORDS = [
    r"smart-?seq",
    r"plate.?based",
    r"full.?length\s+transcript",   # "full-length cDNA" alone is too broad (matches 10x descriptions)
    r"cel-?seq",
    r"mars-?seq",
    r"tang protocol",
    r"picelli",      # author of Smart-seq2 paper, often cited instead of naming the protocol
]

PLATE_RE = re.compile("|".join(PLATE_KEYWORDS), re.IGNORECASE)


def strip_html(text):
    return re.sub(r"<[^>]+>", " ", text)


def classify(name, htdocs):
    desc_path = os.path.join(htdocs, name, "desc.json")
    if not os.path.exists(desc_path):
        return "UMI counts", "no methods"

    desc = json.load(open(desc_path))

    methods = desc.get("methods", "")
    if isinstance(methods, list):
        methods = " ".join(methods)
    methods = strip_html(methods)

    abstract = desc.get("abstract", "")
    if isinstance(abstract, list):
        abstract = " ".join(abstract)

    text = methods + " " + abstract

    if PLATE_RE.search(text):
        return "read counts", "keyword match"
    elif methods.strip():
        return "UMI counts", "methods present, no plate keyword"
    else:
        return "UMI counts", "no methods"


def main():
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audit", help="audit TSV from auditUnits.py")
    parser.add_argument("-o", "--output",
        help="write the TSV here (default: stdout)")
    unitPaths.add_common_args(parser)
    args = parser.parse_args()

    unitPaths.check_workdir(args.dir)
    with open(unitPaths.resolve(args.audit, args.dir)) as fh:
        rows = list(csv.DictReader(fh, delimiter='\t'))
    uint32_no_unit = [r for r in rows
                      if r['matrixArrType'] == 'Uint32' and r['current_unit'] == '']

    out = open(unitPaths.resolve(args.output, args.dir), "w", newline="") \
          if args.output else sys.stdout
    writer = csv.writer(out, delimiter='\t')
    writer.writerow(["dataset", "unit|str", "basis"])

    read_count = 0
    umi_count = 0

    for r in sorted(uint32_no_unit, key=lambda x: x['name']):
        unit, basis = classify(r['name'], args.htdocs)
        writer.writerow([r['name'], unit, basis])
        if unit == "read counts":
            read_count += 1
        else:
            umi_count += 1

    if out is not sys.stdout:
        out.close()

    print(f"\n# Summary: {read_count} read counts, {umi_count} UMI counts "
          f"({len(uint32_no_unit)} total)", file=sys.stderr)


if __name__ == "__main__":
    main()
