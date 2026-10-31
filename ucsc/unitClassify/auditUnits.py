#!/usr/bin/env python3
"""
Inventory expression matrix units across all Cell Browser datasets.

Outputs a TSV with columns:
  name  matrixArrType  current_unit  has_methods  abstract_snippet  pmid

Usage:
  python3 auditUnits.py -o /data/dir/units_audit.tsv
  python3 auditUnits.py > units_audit.tsv          # stdout still works
"""

import argparse
import json
import os
import sys
import html
import re

import unitPaths

SNIPPET_LEN = 120
PLACEHOLDER_METHODS = {"none", "n/a", "see paper", "see publication", "not provided", ""}


def strip_html(text):
    return re.sub(r"<[^>]+>", " ", text).strip()


def is_placeholder_methods(text):
    return strip_html(text).lower().strip() in PLACEHOLDER_METHODS


def collect_datasets(conf, htdocs, results):
    for ds in conf.get("datasets", []):
        name = ds.get("name", "")
        ds_dir = os.path.join(htdocs, name)
        conf_path = os.path.join(ds_dir, "dataset.json")
        if not os.path.exists(conf_path):
            continue
        ds_conf = json.load(open(conf_path))
        if ds_conf.get("datasets"):
            collect_datasets(ds_conf, htdocs, results)
        else:
            results.append((name, ds_dir, ds_conf))


def main():
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-o", "--output",
        help="write the TSV here (default: stdout)")
    unitPaths.add_common_args(parser)
    args = parser.parse_args()

    htdocs = args.htdocs
    root_path = os.path.join(htdocs, "dataset.json")
    root_conf = json.load(open(root_path))

    datasets = []
    collect_datasets(root_conf, htdocs, datasets)

    if args.output:
        unitPaths.check_workdir(args.dir)
        out = open(unitPaths.resolve(args.output, args.dir), "w")
    else:
        out = sys.stdout

    fields = ["name", "matrixArrType", "current_unit", "has_methods", "abstract_snippet", "pmid"]
    print("\t".join(fields), file=out)

    for name, ds_dir, ds_conf in sorted(datasets, key=lambda x: x[0]):
        arr_type = ds_conf.get("matrixArrType", "")
        unit = ds_conf.get("unit", "")

        desc_path = os.path.join(ds_dir, "desc.json")
        desc = json.load(open(desc_path)) if os.path.exists(desc_path) else {}

        methods_raw = desc.get("methods", "")
        if isinstance(methods_raw, list):
            methods_raw = " ".join(methods_raw)
        has_methods = "yes" if methods_raw and not is_placeholder_methods(methods_raw) else "no"

        abstract = desc.get("abstract", "")
        if isinstance(abstract, list):
            abstract = " ".join(abstract)
        snippet = abstract.strip()[:SNIPPET_LEN].replace("\n", " ")

        pmid = desc.get("pmid", "")
        if isinstance(pmid, list):
            pmid = " ".join(str(p) for p in pmid)

        print("\t".join([name, arr_type, unit, has_methods, snippet, str(pmid)]), file=out)

    if out is not sys.stdout:
        out.close()
        print("Wrote %d datasets to %s" % (len(datasets), out.name), file=sys.stderr)


if __name__ == "__main__":
    main()
