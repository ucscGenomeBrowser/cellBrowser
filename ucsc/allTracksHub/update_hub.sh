#!/bin/bash
# Rebuild the Cell Browser all-tracks super hub end to end (Redmine #37820).
#
# Run this after new datasets land in /hive/data/inside/cells/datasets/, or after
# editing hub_config.json (modality/celltype maps, denylists, new assemblies).
#
# Steps:
#   1. build_manifest.py --refresh   re-walk datasets + htdocs -> manifest.tsv
#   2. build_stanzas.py              manifest -> per-assembly faceted trackDb + metadata
#   3. build_hub.py                  assemble the served hub dir (hub.txt, genomes, per-asm)
#   4. validate                      child<->metadata 1:1 check (hubCheck can't do facets yet)
#
# Code and config live here (git-controlled). Everything the build PRODUCES goes to the
# output dir instead, so a run never dirties the repo. Override it with CBHUB_OUT.
#
# Publishing (symlinking the hub + unpublished files under htdocs-cells) is a
# SEPARATE reviewed step: ./publish_hub.sh
#
# STAGING on cells-test (htdocs-cells on hgwdev is served as cells-test.gi.ucsc.edu):
# rebuild the stanzas + hub with the test host (manifest is unchanged, so no re-walk),
# then publish:
#   HUB_BASE_URL=https://cells-test.gi.ucsc.edu python3 build_stanzas.py
#   HUB_BASE_URL=https://cells-test.gi.ucsc.edu python3 build_hub.py
#   ./publish_hub.sh
# Promote to production by rebuilding with HUB_BASE_URL unset (-> served_base).
#
# Usage:
#   ./update_hub.sh           full rebuild (re-walks the tree; ~6 min)
#   ./update_hub.sh --fast    reuse the cached discovery walk (skip re-walk)
#
# New datasets are discovered automatically (the walk is not hardcoded). Datasets
# whose desc.conf/desc.json is still the cbBuild placeholder are gated out and
# listed in inventory-report.md ("Datasets gated for placeholder/missing desc").
set -euo pipefail
cd "$(dirname "$0")"

# same default as build_manifest.OUTDIR; keep the two in step
OUT="${CBHUB_OUT:-/hive/users/mspeir/claude/cell-browser/all-tracks-hub-build}"
echo "code:   $(pwd)"
echo "output: $OUT"
echo

REFRESH="--refresh"
[ "${1:-}" = "--fast" ] && REFRESH=""

echo "== [1/4] build_manifest.py $REFRESH =="
python3 build_manifest.py $REFRESH

echo "== [2/4] build_stanzas.py =="
python3 build_stanzas.py

echo "== [3/4] build_hub.py (assemble served hub dir) =="
python3 build_hub.py

echo "== [4/4] validate child<->metadata =="
OUT="$OUT" python3 - <<'PY'
import csv, glob, os
out = os.environ["OUT"]
ok = True
for tdb in sorted(glob.glob(os.path.join(out, "stanzas", "*.trackDb.txt"))):
    asm = os.path.basename(tdb).split(".")[0]
    comp = "cellBrowser" + asm[:1].upper() + asm[1:]
    # .lstrip(): subtrack stanzas are indented to show the hierarchy, so an anchored
    # startswith() finds nothing (it silently reported 0 children before this).
    cids = [l.lstrip().split(None, 1)[1][len(comp)+1:].strip()
            for l in open(tdb) if l.lstrip().startswith("track " + comp + "_")]
    meta = os.path.join(out, "meta", "%s.metadata.tsv" % asm)
    if not os.path.isfile(meta):
        print("  %-8s children=%d meta=MISSING SKIP" % (asm, len(cids)))
        continue
    keys = [r["Track"] for r in csv.DictReader(open(meta), delimiter="\t")]
    bad = (set(cids) != set(keys)) or (len(cids) != len(set(cids)))
    print("  %-8s children=%d meta=%d %s" %
          (asm, len(cids), len(keys), "FAIL" if bad else "OK"))
    ok = ok and not bad
print("validation:", "OK" if ok else "FAIL")
raise SystemExit(0 if ok else 1)
PY

echo
echo "Done. Review in $OUT:"
echo "  inventory-report.md          (counts, exclusions, gated datasets)"
echo "  facet-coverage.md            (coverage per assembly, dropped/qualified counts)"
echo "  unpublished.tsv              (referenced-but-not-served files to publish)"
echo "  unclassified-celltypes.log   (cell types with no broad class)"
echo "  orphan-annotations.log       (annotation bigBeds dropped for having no stanza)"
echo "Then publish with ./publish_hub.sh"
