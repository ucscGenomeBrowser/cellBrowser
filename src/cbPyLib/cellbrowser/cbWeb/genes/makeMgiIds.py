# Build the mouse gene symbol -> MGI ID table that the marker table uses to link
# straight to a gene page instead of to a search hit list.
#
# Input is the MGI file we already ship for ortholog mapping, cellbrowserData/geneAnnot/
# mgi_HGNC_homologene_8Dec17.txt, which carries the accession, the symbol and the feature
# type. Nothing new has to be downloaded.
#
# Only protein coding genes are kept. That is 23k of the 70k markers in the file and covers
# 93% of the symbols in the marker tables we serve, where taking everything would cover 96%
# for nearly three times the transfer. A symbol that is not in the table falls back to the
# symbol search, so the genes left out still get a working link.
#
# Output is JSON rather than TSV because the server gzips application/json and does not gzip
# text/tab-separated-values, so the JSON is the smaller of the two over the wire. The "MGI:"
# prefix is dropped and put back by the browser.
#
#   python3 makeMgiIds.py ../../../../../cellbrowserData/geneAnnot/mgi_HGNC_homologene_8Dec17.txt
#
# Name the output after the version of the input, so it can be cached forever.

import json, sys, gzip
from os.path import basename

def main():
    if len(sys.argv) < 2:
        sys.exit("usage: makeMgiIds.py <mgi_HGNC_homologene file> [outFname]")
    inFname = sys.argv[1]

    if len(sys.argv) > 2:
        outFname = sys.argv[2]
    else:
        # mgi_HGNC_homologene_8Dec17.txt -> mgiIds-8Dec17.json
        stem = basename(inFname).rsplit(".", 1)[0]
        outFname = "mgiIds-%s.json" % stem.split("_")[-1]

    symToId = {}
    skipped = 0
    for i, line in enumerate(open(inFname, encoding="utf8", errors="replace")):
        if i == 0:
            continue
        row = line.rstrip("\n").split("\t")
        if len(row) < 4:
            continue
        mgiId, sym, _, featType = row[0], row[1], row[2], row[3]
        if not sym or not mgiId.startswith("MGI:"):
            continue
        if featType != "protein coding gene":
            skipped += 1
            continue
        symToId[sym] = int(mgiId[4:])

    blob = json.dumps(symToId, separators=(",", ":"), sort_keys=True)
    with open(outFname, "w") as ofh:
        ofh.write(blob)

    gzSize = len(gzip.compress(blob.encode(), 9))
    print("%s: %d protein coding symbols (%d other features skipped)" % (outFname, len(symToId), skipped))
    print("  %.1f KB, %.1f KB gzipped as the server will send it" % (len(blob)/1024.0, gzSize/1024.0))

main()
