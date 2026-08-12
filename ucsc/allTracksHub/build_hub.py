#!/usr/bin/env python3
"""
Phase 4 of the Cell Browser all-tracks super hub (Redmine #37820).

Assembles the served hub directory from the Phase 2/3 outputs (stanzas/ + meta/):

  <HUB_DIR>/
    hub.txt
    genomes.txt
    description.html
    <assembly>/trackDb.txt     (faceted composite + children)
    <assembly>/metadata.tsv    (facet metadata; metaDataUrl points here)

This only writes the source-of-truth hub dir. PUBLISHING (symlinking it + the
unpublished track files under htdocs-cells) is a separate, reviewed step --
see make_publish_plan.py / the printed instructions.

See plan: /hive/users/mspeir/claude/cell-browser/plans/tracks-super-hub.md
"""

import os
import csv
import json
import glob
import shutil
import sys

import build_manifest as bm

OUTDIR = bm.OUTDIR
STANZADIR = os.path.join(OUTDIR, "stanzas")
METADIR = os.path.join(OUTDIR, "meta")

# Curated cell-type crosswalks, for the cell-class colour legend. Same resolution as
# build_stanzas.XWALK_ROOT (kent archive of record, override with XWALK_ROOT) -- kept in
# step with it deliberately rather than importing build_stanzas, which would re-run that
# module's whole config load just to read one palette file.
_HERE = os.path.dirname(os.path.abspath(__file__))
_KENT_XWALK = os.path.expanduser("~/kent/src/hg/makeDb/scripts/singleCellSignalsPeaks")
XWALK_ROOT = os.environ.get("XWALK_ROOT") or (
    _KENT_XWALK if os.path.isdir(os.path.join(_KENT_XWALK, "celltype-crosswalks"))
    else _HERE)

HUB_DIR = "/hive/data/inside/cells/all-tracks-hub"
DISABLED_DIR = HUB_DIR + "-disabled"   # kept on hive, NOT under the served symlink
EXCLUDE_ASM = set(bm.CFG.get("exclude_assemblies", []))
# Same host logic as build_stanzas: override with HUB_BASE_URL to stage on cells-test.
_BASE = os.environ.get("HUB_BASE_URL", bm.CFG["served_base"]).rstrip("/")
SERVED_HUB_URL = _BASE + "/all-tracks-hub"

# Display name per assembly for genomes.txt comments / description.
ASM_LABEL = {"hg38": "Human (hg38)", "hg19": "Human (hg19)",
             "mm10": "Mouse (mm10)", "mm9": "Mouse (mm9)",
             "micMur3": "Mouse lemur (micMur3)", "dm6": "Fruit fly (dm6)"}

HUB_TXT = """hub cellBrowserAllTracks
shortLabel UCSC Cell Browser - All Tracks
longLabel Aggregated tracks (signal, peaks, interactions, annotations, expression) from every UCSC Cell Browser collection
genomesFile genomes.txt
email cells@ucsc.edu
descriptionUrl description.html
"""

DESCRIPTION_HTML = """<h2>UCSC Cell Browser: All Tracks</h2>
<p>
This hub gathers the genome-browser tracks generated for the datasets in the
<a href="https://cells.ucsc.edu/" target="_blank">UCSC Cell Browser</a>: per-cell-type
signal and peaks, candidate cis-regulatory elements, histone marks, interactions, splice
junctions, gene annotations and expression. Each kind of data is its own track, so the
browser's track list shows what is available without having to open a container first.
A track that draws on a single dataset names that dataset in its label.
</p>
<p>
The larger tracks are faceted: opening one brings up a table with a row per subtrack and
facets for dataset, cell class, cell type, tissue, life stage, condition, data type and
assay. Nothing is selected to begin with, so only the subtracks you pick get drawn. Every
subtrack links back to the Cell Browser dataset it came from.
</p>
<p>
Signal scales are <b>not</b> normalized across studies. Each track keeps the scale its
data wrangler set, or an automatic per-track scale. Tracks are coloured by broad cell
class from one palette shared across every assembly, so a class is the same colour
throughout; each track's own description page carries the colour key.
</p>
<p>
Built from <code>%s</code>. Questions: cells@ucsc.edu.
</p>
""" % HUB_DIR


# Per-assembly description page, following the canonical UCSC track-doc template
# (~/kent/src/hg/makeDb/trackDb/template.html): Description, Display Conventions and
# Configuration, Methods, Data Access, Credits, References.
TRACK_PAGE = """<h2>Description</h2>
<p>
%(intro)s
</p>
%(datasets)s
<h2>Display Conventions and Configuration</h2>
%(display)s
<h2>Methods</h2>
<p>
The tracks in this hub were collected from the per-collection track hubs and source files
of the UCSC Cell Browser datasets. The underlying data files are referenced in place, not
copied. Labels and facet values were derived from the curated track labels and dataset
metadata; the assembly and source dataset come from each dataset's configuration.
</p>
<p>
Signal scales are <b>not</b> normalized across studies. Each track keeps the scale its
data wrangler set, or an automatic per-track scale.
</p>

<h2>Data Access</h2>
<p>
The source datasets can be explored interactively at
<a href="https://cells.ucsc.edu/" target="_blank">cells.ucsc.edu</a>, and each subtrack
links back to the dataset it came from. This hub is served at
<a href="%(huburl)s/hub.txt">%(huburl)s/hub.txt</a>.
</p>

<h2>Credits</h2>
<p>
Assembled by the UCSC Cell Browser team from community-contributed single-cell datasets.
Questions: <a href="mailto:cells@ucsc.edu">cells@ucsc.edu</a>.
</p>

<h2>References</h2>
<p>
Speir ML, Bhaduri A, Markov NS, Moreno P, Nowakowski TJ, Papatheodorou I, Pollen AA,
Raney BJ, Seninge L, Kent WJ, Haeussler M.
UCSC Cell Browser: visualize your single-cell data.
<em>Bioinformatics</em>. 2021;37(23):4578-4580.
PMID: <a href="https://pubmed.ncbi.nlm.nih.gov/34244710/" target="_blank">34244710</a>
</p>
"""

FACETED_DISPLAY = """<p>
Opening the track brings up a faceted table with one row per subtrack. Use the facets and
the column search boxes to narrow the list, then click rows to turn subtracks on. The
track starts with nothing selected, so only the subtracks you pick are drawn. The
<b>Name</b> column shows each track's label and the <b>Track</b> column its identifier.
Once a subtrack is on, its colour, height and viewing range can be changed from the
right-click <b>Configure</b> menu in the main browser image.
</p>
<p>
Every subtrack label is unique. Where the cell-type facet deliberately rolls several
source clusters together, the label keeps the detail that separates them: how the peaks
were called, which histone mark was profiled, which grouping level or cohort the track
belongs to, and the cluster code the source study used.
</p>
<p>
Cell class is resolved for every track. A cell class of <b>Unknown</b> means the source
label is an aggregate or a bare cluster identifier rather than a cell type, for example a
pooled sample, a merged-peak set, or a numbered cluster with no published assignment.
</p>%(classLegend)s
"""

PLAIN_DISPLAY = """<p>
The subtracks are listed as checkboxes on this page. Turn on the ones you want, then use
the right-click <b>Configure</b> menu in the main browser image to change an individual
track's colour, height or viewing range. Each subtrack label ends with the dataset it
came from.
</p>
"""

SINGLE_DISPLAY = """<p>
This is a single track. Use the right-click <b>Configure</b> menu in the main browser
image to change its colour, height or viewing range.
</p>
"""



def class_legend_html():
    """Colour key for the Cell class facet, generated from celltype-palette.tsv.

    Every track in the hub is coloured by its broad cell class, and until now nothing on
    the page said what the colours meant. Generated rather than written out so it cannot
    drift from the palette the tracks are actually coloured with."""
    pal = os.path.join(XWALK_ROOT, "celltype-crosswalks", "celltype-palette.tsv")
    if not os.path.isfile(pal):
        return ""
    rows = []
    for line in open(pal):
        p = line.rstrip("\n").split("\t")
        if len(p) >= 2:
            rows.append('  <tr><th style="background-color:rgb(%s);width:2em">&nbsp;</th>\n'
                        '      <td>%s</td></tr>' % (p[1], p[0]))
    if not rows:
        return ""
    return ("\n<p>\nSubtracks are coloured by broad cell class, using one palette shared by\n"
            "every assembly in this hub, so a class is the same colour throughout (and\n"
            "matches the native <b>Single-cell ATAC-seq</b> tracks on hg38 and mm10):\n</p>\n"
            '<table class="stdTbl">\n' + "\n".join(rows) + "\n</table>\n")


def track_page_html(asm, t):
    """Description page for one top-level track, from the sidecar build_stanzas writes.

    Every track gets its own page now that they are all top level. They used to share one
    per-assembly page, which meant the cCRE, expression and splice-junction tracks were
    each described as though they were the signal-and-peaks composite."""
    label = ASM_LABEL.get(asm, asm)
    ds = t["datasets"]
    n = t["subtracks"]
    if len(ds) == 1:
        intro = ('This track shows %s on the <b>%s</b> assembly, from the '
                 '<a href="https://cells.ucsc.edu/?ds=%s" target="_blank">%s</a> dataset '
                 'in the <a href="https://cells.ucsc.edu/" target="_blank">UCSC Cell '
                 'Browser</a>. It holds %d track%s.'
                 % (t["longLabel"].split(" from ")[0].split(" (")[0].lower(), label,
                    ds[0][0], ds[0][1], n, "" if n == 1 else "s"))
    else:
        intro = ('This track shows %s on the <b>%s</b> assembly, drawn from %d '
                 '<a href="https://cells.ucsc.edu/" target="_blank">UCSC Cell Browser</a> '
                 'datasets. It holds %d subtracks.'
                 % (t["longLabel"].split(" from ")[0].split(" (")[0].lower(), label,
                    len(ds), n))
    if len(ds) > 1:
        items = "\n".join(
            '  <li><a href="https://cells.ucsc.edu/?ds=%s" target="_blank">%s</a></li>'
            % (slug, lbl) for slug, lbl in sorted(ds, key=lambda x: x[1].lower()))
        datasets = "<p>\nThe subtracks come from these datasets:\n</p>\n<ul>\n%s\n</ul>\n" % items
    else:
        datasets = ""
    if t["kind"] == "faceted":
        display = FACETED_DISPLAY % {"classLegend": class_legend_html()}
    elif t["kind"] == "composite":
        display = PLAIN_DISPLAY
    else:
        display = SINGLE_DISPLAY
    return TRACK_PAGE % {"intro": intro, "datasets": datasets,
                         "display": display, "huburl": SERVED_HUB_URL}


def write_asm(dest_root, asm):
    adir = os.path.join(dest_root, asm)
    os.makedirs(adir, exist_ok=True)
    shutil.copyfile(os.path.join(STANZADIR, "%s.trackDb.txt" % asm),
                    os.path.join(adir, "trackDb.txt"))
    shutil.copyfile(os.path.join(METADIR, "%s.metadata.tsv" % asm),
                    os.path.join(adir, "metadata.tsv"))
    hist = os.path.join(METADIR, "%s.histone.metadata.tsv" % asm)
    if os.path.isfile(hist):
        shutil.copyfile(hist, os.path.join(adir, "histone.metadata.tsv"))
    ccre = os.path.join(METADIR, "%s.ccre.metadata.tsv" % asm)
    if os.path.isfile(ccre):
        shutil.copyfile(ccre, os.path.join(adir, "ccre.metadata.tsv"))
    # count subtracks; .lstrip() because child stanzas are indented to show the hierarchy
    return sum(1 for line in open(os.path.join(adir, "trackDb.txt"))
               if line.lstrip().startswith("track cellBrowser")
               and "_" in line.split()[1])


def main():
    all_asm = sorted(
        os.path.basename(p).split(".")[0]
        for p in glob.glob(os.path.join(STANZADIR, "*.trackDb.txt")))
    if not all_asm:
        sys.exit("No stanzas found in %s -- run build_stanzas.py first." % STANZADIR)
    served = [a for a in all_asm if a not in EXCLUDE_ASM]
    disabled = [a for a in all_asm if a in EXCLUDE_ASM]

    os.makedirs(HUB_DIR, exist_ok=True)
    with open(os.path.join(HUB_DIR, "hub.txt"), "w") as fh:
        fh.write(HUB_TXT)
    with open(os.path.join(HUB_DIR, "description.html"), "w") as fh:
        fh.write(DESCRIPTION_HTML)

    # genomes.txt lists only served assemblies
    glines = []
    for asm in served:
        glines.append("genome %s" % asm)
        glines.append("trackDb %s/trackDb.txt" % asm)
        glines.append("")
    with open(os.path.join(HUB_DIR, "genomes.txt"), "w") as fh:
        fh.write("\n".join(glines))

    for asm in served:
        adir = os.path.join(HUB_DIR, asm)
        n = write_asm(HUB_DIR, asm)
        # One description page per top-level track, named after the track (its `html`
        # line). Driven by the sidecar build_stanzas writes, which knows the source
        # collection behind every child.
        sidecar = os.path.join(METADIR, "%s.tracks.json" % asm)
        tracks = json.load(open(sidecar)) if os.path.isfile(sidecar) else []
        if not tracks:
            sys.stderr.write("WARNING: no %s -- no description pages written for %s\n"
                             % (sidecar, asm))
        allds = set()
        keep = set()
        for t in tracks:
            with open(os.path.join(adir, t["track"] + ".html"), "w") as fh:
                fh.write(track_page_html(asm, t))
            keep.add(t["track"] + ".html")
            allds.update(d[1] for d in t["datasets"])
        # drop pages left behind by an earlier layout, e.g. the per-assembly page that
        # every composite used to share; a stale page is worse than none, since the
        # hub would keep serving text about tracks that no longer exist
        for old in glob.glob(os.path.join(adir, "*.html")):
            if os.path.basename(old) not in keep:
                os.remove(old)
                sys.stderr.write("     removed stale page %s\n" % os.path.basename(old))
        sys.stderr.write("  %-8s %s  (%d child tracks, %d top-level tracks, "
                         "%d datasets)\n"
                         % (asm, ASM_LABEL.get(asm, asm), n, len(tracks), len(allds)))

    # excluded assemblies: keep trackDb/metadata on hive but OUT of the served hub
    for asm in disabled:
        n = write_asm(DISABLED_DIR, asm)
        stale = os.path.join(HUB_DIR, asm)
        if os.path.isdir(stale):
            shutil.rmtree(stale)
        sys.stderr.write("  %-8s %s  EXCLUDED -> %s/%s (%d tracks, not served)\n"
                         % (asm, ASM_LABEL.get(asm, asm), DISABLED_DIR, asm, n))

    sys.stderr.write("Wrote hub to %s\n" % HUB_DIR)
    sys.stderr.write("Served (after publish): %s/hub.txt\n" % SERVED_HUB_URL)


if __name__ == "__main__":
    main()
