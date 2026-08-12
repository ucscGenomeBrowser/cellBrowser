#!/usr/bin/env python3
"""
Phase 1 of the Cell Browser all-tracks super hub (Redmine #37820).

Walks the Cell Browser dataset tree plus the served htdocs tree and emits:
  - manifest.tsv      one row per track-data file (ground truth for later phases)
  - inventory-report.md  human-readable summary

See plan: /hive/users/mspeir/claude/cell-browser/plans/tracks-super-hub.md
"""

import os
import re
import sys
import pickle
import subprocess
from collections import defaultdict, OrderedDict

import json
import glob

DATASETS = "/hive/data/inside/cells/datasets"
HTDOCS = "/usr/local/apache/htdocs-cells"
# htdocs-cells is itself a symlink (-> /data/apache/htdocs-cells), so realpath()
# of served files resolves there; use the resolved root for startswith checks.
HTDOCS_REAL = os.path.realpath(HTDOCS)
# Code and config live together in this directory, which is git-controlled in the
# cellBrowser repo (ucsc/allTracksHub). The build's OUTPUTS must not land here: a run
# writes manifest.tsv, discovery.pkl, stanzas/, meta/ and nine logs, about 5 MB that is
# regenerated every time. So the two are separate: CONFDIR for the tracked inputs, OUTDIR
# for everything the build produces. Point OUTDIR elsewhere with CBHUB_OUT.
CONFDIR = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.environ.get(
    "CBHUB_OUT", "/hive/users/mspeir/claude/cell-browser/all-tracks-hub-build")
if not os.path.isdir(OUTDIR):
    os.makedirs(OUTDIR, exist_ok=True)
BIGWIGINFO = "/cluster/bin/x86_64/bigWigInfo"

# Wrangler-editable curation config (modality maps, denylists, placeholder
# markers, new-assembly chr1 sizes, served host, ...). See hub_config.json.
with open(os.path.join(CONFDIR, "hub_config.json")) as _fh:
    CFG = json.load(_fh)

# Canonical served host written into manifest track URLs. (build_stanzas can
# rewrite the host at stanza-build time via HUB_BASE_URL, e.g. for cells-test.)
SERVED_BASE = CFG["served_base"]

WIP_SEGMENTS = set(CFG["exclude_dirs_wip"])
BAM_STORE_DIRS = set(CFG["exclude_dirs_bam"])
BAM_STORE_RE = re.compile(r"^batch\d+$", re.I)

BIGWIG_EXT = (".bw", ".bigwig")
BIGBED_EXT = (".bb", ".bigbed")

_bb_table_cache = {}
def bb_autosql_table(abspath):
    """Return the autoSql `table` name of a bigBed file (or '' on failure).
    Some source hubs declare non-plain-bed tracks as `type bigBed`: interaction
    tracks (e.g. cortex-atac/hub/interact.old/*_AllEnhancerPredictions.bb, table
    `interact`) and narrowPeak calls (e.g. neuro-degen-atac/peaks.bb, table
    `bigNarrowPeak`). Left as bigBed they route/render wrong, so we detect the
    real type from the file's own autoSql and reclassify."""
    if abspath in _bb_table_cache:
        return _bb_table_cache[abspath]
    tbl = ""
    try:
        import subprocess
        out = subprocess.run(["bigBedInfo", "-as", abspath], capture_output=True,
                             text=True, timeout=30).stdout
        for line in out.splitlines():
            if line.startswith("table "):
                tbl = line.split(None, 1)[1].strip()
                break
    except Exception:
        tbl = ""
    _bb_table_cache[abspath] = tbl
    return tbl

# Top-level dirs under DATASETS that hold extra_collections track dumps. These are
# handled explicitly (see extra_collections scan in main); skip them in the normal
# walk so their files are not also emitted under the wrong collection or gated out.
EXTRA_SRC_TOPDIRS = {r["path"].split("/")[0]
                     for e in CFG.get("extra_collections", [])
                     for r in e["roots"]}


def is_bam_store_dir(name):
    return name.lower() in BAM_STORE_DIRS or bool(BAM_STORE_RE.match(name))

# ---------------------------------------------------------------------------
# hub.txt / trackDb parsing
# ---------------------------------------------------------------------------

def read_stanzas(path):
    """Parse a trackDb-style file into a list of (indent, OrderedDict) stanzas,
    resolving `include` directives relative to the file's directory.
    Stanzas are separated by blank lines. Indentation of the first line is kept."""
    stanzas = []
    base = os.path.dirname(path)
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return stanzas

    cur = None
    cur_indent = 0
    for raw in lines:
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped:
            if cur:
                stanzas.append((cur_indent, cur))
                cur = None
            continue
        if stripped.startswith("#"):
            continue
        # include directive (only meaningful at column 0, outside a stanza)
        m = re.match(r"\s*include\s+(\S+)", line)
        if m and cur is None:
            inc = os.path.join(base, m.group(1))
            stanzas.extend(read_stanzas(inc))
            continue
        indent = len(line) - len(line.lstrip())
        key, _, val = stripped.partition(" ")
        val = val.strip()
        if key == "track":
            if cur:
                stanzas.append((cur_indent, cur))
            cur = OrderedDict()
            cur_indent = indent
            cur["track"] = val
        elif cur is not None:
            # first key-value of the very first stanza in a useOneFile hub
            # (hub/genome lines) land here too; that's fine, ignored later.
            cur.setdefault(key, val)
        else:
            # top-of-file directives before any track (hub, genome, useOneFile...)
            cur = OrderedDict()
            cur_indent = indent
            cur[key] = val
    if cur:
        stanzas.append((cur_indent, cur))
    return stanzas


def hub_trackdb_files(hubtxt):
    """Return list of (assembly, trackdb_path) for a hub.txt.
    Handles useOneFile (stanzas inline in hub.txt, genome lines inline) and
    multi-file (genomesFile -> genomes.txt -> per-genome trackDb)."""
    base = os.path.dirname(hubtxt)
    text = ""
    try:
        with open(hubtxt, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return []
    genomes_m = re.search(r"^\s*genomesFile\s+(\S+)", text, re.M)
    use_one = re.search(r"^\s*useOneFile\s+on", text, re.M)
    if genomes_m and not use_one:
        gpath = os.path.join(base, genomes_m.group(1))
        out = []
        try:
            with open(gpath, encoding="utf-8", errors="replace") as fh:
                gtext = fh.read()
        except OSError:
            return []
        cur_genome = None
        for line in gtext.splitlines():
            s = line.strip()
            if s.startswith("genome "):
                cur_genome = s.split(None, 1)[1].strip()
            elif s.startswith("trackDb ") and cur_genome:
                tdb = os.path.join(base, s.split(None, 1)[1].strip())
                out.append((cur_genome, tdb))
        return out
    # useOneFile or inline: the hub.txt itself carries genome + stanzas
    return [(None, hubtxt)]


def parse_hub(hubtxt):
    """Parse one hub into a list of leaf-track dicts.
    Each dict: name, type, bigDataUrl(abs path), assembly, hub_path, composite,
    metadata(dict). Also flags whether the hub is a decoy (bigBarChart-only)."""
    leaves = []
    all_types = set()
    for assembly_hint, tdb in hub_trackdb_files(hubtxt):
        tdb_dir = os.path.dirname(tdb)
        stanzas = read_stanzas(tdb)
        # Track current genome (for useOneFile, genome lines appear as stanzas
        # of their own or as keys). Build parent->type map for inheritance.
        cur_genome = assembly_hint
        type_by_track = {}
        type_full_by_track = {}
        parent_of = {}
        # First pass: record genome lines and composite/type structure
        for indent, st in stanzas:
            if "genome" in st and "track" not in st:
                cur_genome = st["genome"]
            name = st.get("track")
            if not name:
                continue
            st["_genome"] = cur_genome
            if st.get("type"):
                type_by_track[name] = st["type"].split()[0]
                type_full_by_track[name] = st["type"]
            parent = None
            if st.get("parent"):
                parent = st["parent"].split()[0]
            elif st.get("subTrack"):
                parent = st["subTrack"].split()[0]
            parent_of[name] = parent

        def resolve_type(name):
            seen = set()
            n = name
            while n and n not in seen:
                seen.add(n)
                if n in type_by_track:
                    return type_by_track[n]
                n = parent_of.get(n)
            return None

        def resolve_type_full(name):
            seen = set()
            n = name
            while n and n not in seen:
                seen.add(n)
                if n in type_full_by_track:
                    return type_full_by_track[n]
                n = parent_of.get(n)
            return None

        def top_composite(name):
            """Walk up the parent chain to the highest container."""
            n = name
            last = name
            seen = set()
            while n and n not in seen:
                seen.add(n)
                p = parent_of.get(n)
                if p is None:
                    break
                last = p
                n = p
            return last

        for indent, st in stanzas:
            name = st.get("track")
            if not name:
                continue
            bdu = st.get("bigDataUrl")
            if not bdu:
                continue
            ttype = resolve_type(name) or "unknown"
            all_types.add(ttype)
            abspath = os.path.normpath(os.path.join(tdb_dir, bdu))
            leaves.append({
                "name": name,
                "type": ttype,
                "type_full": resolve_type_full(name) or ttype,
                "abs": abspath,
                "assembly": st.get("_genome"),
                "hub": hubtxt,
                "composite": top_composite(name),
                "parent": parent_of.get(name),
                "color": st.get("color", ""),
                "shortLabel": st.get("shortLabel", ""),
                "longLabel": st.get("longLabel", ""),
                "maxHeightPixels": st.get("maxHeightPixels", ""),
                "autoScale": st.get("autoScale", ""),
                "subGroups": st.get("subGroups", ""),
                "stanza": dict(st),
            })
    real_types = {t for t in all_types if t in
                  ("bigWig", "bigNarrowPeak", "bigInteract", "bigBed", "bam")}
    is_decoy = (len(real_types) == 0) and ("bigBarChart" in all_types)
    return leaves, is_decoy


# ---------------------------------------------------------------------------
# cellbrowser.conf lookups (assembly + visibility)
# ---------------------------------------------------------------------------

_conf_cache = {}

def read_conf(confpath):
    if confpath in _conf_cache:
        return _conf_cache[confpath]
    d = {}
    try:
        with open(confpath, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                m = re.match(r'(\w+)\s*=\s*["\']?([^"\']*)', s)
                if m:
                    d.setdefault(m.group(1), m.group(2).strip())
    except OSError:
        pass
    _conf_cache[confpath] = d
    return d


_dslabel_cache = {}

def dataset_label(collection):
    """Human dataset short label for a collection, from cellbrowser.conf shortLabel
    (top-level, else nearest subdataset). Falls back to the collection slug. Used to
    tag track labels with their source dataset and on the description pages."""
    if collection in _dslabel_cache:
        return _dslabel_cache[collection]
    override = CFG.get("dataset_labels", {}).get(collection)
    if override:
        _dslabel_cache[collection] = override
        return override
    root = os.path.join(DATASETS, collection)
    val = collection
    for conf in [os.path.join(root, "cellbrowser.conf")] + \
            sorted(glob.glob(os.path.join(root, "*", "cellbrowser.conf"))):
        if os.path.isfile(conf):
            sl = read_conf(conf).get("shortLabel")
            if sl and sl.lower() not in ("cbhub", ""):
                val = sl
                break
    _dslabel_cache[collection] = val
    return val


def nearest_conf_value(start_dir, collection_root, key):
    """Walk up from start_dir to collection_root, return first conf value for key."""
    d = os.path.abspath(start_dir)
    root = os.path.abspath(collection_root)
    while True:
        conf = os.path.join(d, "cellbrowser.conf")
        if os.path.isfile(conf):
            v = read_conf(conf).get(key)
            if v:
                return v, conf
        if d == root or len(d) <= len(root):
            break
        d = os.path.dirname(d)
    return None, None


def is_hidden(start_dir, collection_root):
    """True if nearest cellbrowser.conf sets visibility=hide (active, not commented)."""
    d = os.path.abspath(start_dir)
    root = os.path.abspath(collection_root)
    while True:
        conf = os.path.join(d, "cellbrowser.conf")
        if os.path.isfile(conf):
            v = read_conf(conf).get("visibility")
            if v is not None:
                return v.strip().lower() == "hide", conf
        if d == root or len(d) <= len(root):
            break
        d = os.path.dirname(d)
    return False, None


# ---------------------------------------------------------------------------
# dataset readiness: gate out datasets whose desc is still the cbBuild template
# placeholder (or missing entirely) -- not ready for a public hub.
# ---------------------------------------------------------------------------

PLACEHOLDER_ABSTRACT = CFG["desc_placeholder_abstract"]
PLACEHOLDER_TITLE = CFG["desc_placeholder_title"]


def _desc_conf_ready(conf):
    """True if a desc.conf has a real (non-placeholder) abstract or title."""
    try:
        t = open(conf, encoding="utf-8", errors="replace").read()
    except OSError:
        return False
    m = (re.search(r'abstract\s*=\s*"""(.*?)"""', t, re.S)
         or re.search(r'abstract\s*=\s*"([^"]*)"', t))
    abstract = (m.group(1).strip() if m else "")
    ti = re.search(r'title\s*=\s*"([^"]*)"', t)
    title = (ti.group(1).strip() if ti else "")
    if abstract and PLACEHOLDER_ABSTRACT not in abstract.lower():
        return True
    if title and title.lower() != PLACEHOLDER_TITLE:
        return True
    return False


def _desc_json_ready(dj):
    try:
        obj = json.load(open(dj, encoding="utf-8", errors="replace"))
    except Exception:
        return False
    ab = (obj.get("abstract") or "").lower()
    tt = (obj.get("title") or "").lower()
    return bool(ab and PLACEHOLDER_ABSTRACT not in ab) or \
        bool(tt and tt != PLACEHOLDER_TITLE)


_coll_ready_cache = {}

def collection_ready(collection_root):
    """Collection-level readiness: True if ANY desc.conf / desc.json / abstract.html
    anywhere under the collection is non-placeholder. (Per-track nearest-ancestor
    fails for hub-aggregated tracks whose subdataset descs live in sibling subtrees,
    e.g. brainvar/gene-activity/prenatal/desc.conf vs .../gene-activity/hub/bw/*.)
    Uses shallow globs (depths 0-4) so it never descends bam dirs. Cached."""
    if collection_root in _coll_ready_cache:
        return _coll_ready_cache[collection_root]
    ready = False
    for depth in range(0, 5):
        base = os.path.join(collection_root, *(["*"] * depth)) if depth else collection_root
        if glob.glob(os.path.join(base, "abstract.html")):
            ready = True
            break
        if any(_desc_conf_ready(f) for f in glob.glob(os.path.join(base, "desc.conf"))):
            ready = True
            break
        if any(_desc_json_ready(f) for f in glob.glob(os.path.join(base, "desc.json"))):
            ready = True
            break
    _coll_ready_cache[collection_root] = ready
    return ready


# ---------------------------------------------------------------------------
# assembly heuristic via bigWigInfo (last resort)
# ---------------------------------------------------------------------------

def assembly_from_bigwig(path):
    # bigWigInfo -chroms emits "chr1<TAB>0<TAB>248956422" (name, index, size), so
    # match on the chr1 size, not a "chr1 <size>" string (that never matched).
    chr1 = {int(k): v for k, v in CFG["assembly_chr1_size"].items()}
    try:
        out = subprocess.run([BIGWIGINFO, "-chroms", path],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return None
    for line in out.splitlines():
        p = line.split()
        if len(p) >= 3 and p[0] == "chr1":
            return chr1.get(int(p[2]))
    return None


# ---------------------------------------------------------------------------
# slug / naming
# ---------------------------------------------------------------------------

def slug(s):
    s = re.sub(r"[^A-Za-z0-9_]", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s.lower()


def path_segments(abspath):
    rel = os.path.relpath(abspath, DATASETS)
    return rel.split(os.sep)


def is_wip(abspath):
    segs = [s.lower() for s in path_segments(abspath)]
    if any(s in WIP_SEGMENTS for s in segs):
        return True
    if any(s.endswith("~") for s in segs):
        return True
    return False


def _scan(start, hub_txts, track_files):
    """os.walk WITHOUT following symlinks (the safe default -- following links
    once dragged the walk through the entire UCSC hub tree). Appends found
    hub.txt and track files in place. `start` itself is walked even if it is a
    symlink (os.walk always descends the top arg)."""
    for dirpath, dirs, files in os.walk(start):
        dirs[:] = [d for d in dirs if not is_bam_store_dir(d)]
        if "hub.txt" in files:
            hub_txts.append(os.path.join(dirpath, "hub.txt"))
        for f in files:
            fl = f.lower()
            if fl.endswith(BIGWIG_EXT) or fl.endswith(BIGBED_EXT):
                track_files.append(os.path.join(dirpath, f))


def discover(root):
    """Walk the dataset tree (no symlink following), then surgically walk the
    targets of symlinked dirs that point into the served htdocs-cells tree --
    e.g. datasets/cortex-dev/hub -> htdocs-cells/hubs/cortex-dev. Keeping the
    datasets-side display path means those files still resolve to a real
    collection. Returns (hub_txt_paths, track_file_paths)."""
    hub_txts = []
    track_files = []
    served_links = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not is_bam_store_dir(d)]
        for d in list(dirs):
            full = os.path.join(dirpath, d)
            if os.path.islink(full):
                tgt = os.path.realpath(full)
                if tgt.startswith(HTDOCS_REAL + os.sep) and tgt != HTDOCS_REAL:
                    served_links.append(full)
                # never descend a symlink in the main walk
                dirs.remove(d)
        if "hub.txt" in files:
            hub_txts.append(os.path.join(dirpath, "hub.txt"))
        for f in files:
            fl = f.lower()
            if fl.endswith(BIGWIG_EXT) or fl.endswith(BIGBED_EXT):
                track_files.append(os.path.join(dirpath, f))
    # bounded second pass over served symlink targets (display path = link path)
    seen = set()
    for link in served_links:
        rp = os.path.realpath(link)
        if rp in seen:
            continue
        seen.add(rp)
        sys.stderr.write("  + served symlink: %s -> %s\n" % (link, rp))
        _scan(link, hub_txts, track_files)
    return hub_txts, track_files


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    # ---- discovery (expensive tree walk; cached for fast iteration) ----
    cache = os.path.join(OUTDIR, "discovery.pkl")
    if "--refresh" not in sys.argv and os.path.isfile(cache):
        sys.stderr.write("Loading discovery cache (%s)...\n" % cache)
        with open(cache, "rb") as fh:
            hubs, walked = pickle.load(fh)
    else:
        sys.stderr.write("Discovering hubs + track files (full walk)...\n")
        hubs, walked = discover(DATASETS)
        with open(cache, "wb") as fh:
            pickle.dump((hubs, walked), fh)
    sys.stderr.write("  %d hub.txt, %d on-disk track files\n"
                     % (len(hubs), len(walked)))

    # ---- parse hubs ----
    # Detect decoy hubs from ALL hubs (so their files get flagged), but only let
    # NON-WIP / NON-decoy hubs define canonical refs + assemblies.
    ref_by_abs = {}        # hub-relative path -> leaf
    ref_by_real = {}       # realpath -> leaf (collapses symlink aliases)
    decoy_reals = set()
    for hubtxt in hubs:
        try:
            leaves, is_decoy = parse_hub(hubtxt)
        except Exception as e:
            sys.stderr.write("  WARN parse %s: %s\n" % (hubtxt, e))
            continue
        wip = is_wip(hubtxt)
        for lf in leaves:
            rp = os.path.realpath(lf["abs"])
            if is_decoy:
                decoy_reals.add(rp)
            # bigBarChart-only ("decoy") hubs are kept now -- let them define
            # canonical refs too; only true WIP/test hubs are skipped.
            if wip:
                continue
            ref_by_abs.setdefault(lf["abs"], lf)
            ref_by_real.setdefault(rp, lf)
    sys.stderr.write("  %d canonical refs (%d decoy files)\n"
                     % (len(ref_by_real), len(decoy_reals)))

    # collections that have at least one real hub-referenced track
    collections_with_refs = {path_segments(lf["abs"])[0]
                             for lf in ref_by_real.values()}
    # directory -> assembly, from referenced tracks, so orphan tracks sitting in
    # the same dir as resolved hub tracks can inherit the assembly.
    dir_assembly = {}
    for lf in ref_by_real.values():
        if lf.get("assembly"):
            dir_assembly.setdefault(os.path.dirname(lf["abs"]), lf["assembly"])

    # ---- build universe keyed by physical file ----
    # Prefer the hub/served display path when referenced (that bigDataUrl is what
    # the master hub points at); else the walked path. Collapses symlink dupes.
    universe = {}          # realpath -> display abs_path
    broken_refs = 0
    for abs_, lf in ref_by_abs.items():
        if not os.path.exists(abs_):
            broken_refs += 1
            continue
        universe.setdefault(os.path.realpath(abs_), abs_)
    for f in walked:
        universe.setdefault(os.path.realpath(f), f)
    sys.stderr.write("  %d distinct physical track files (%d broken refs skipped)\n"
                     % (len(universe), broken_refs))

    rows = []
    unknown_count = 0
    for rp, abspath in sorted(universe.items(), key=lambda kv: kv[1]):
        if not abspath.startswith(DATASETS + os.sep):
            continue
        segs = path_segments(abspath)
        collection = segs[0]
        if collection in EXTRA_SRC_TOPDIRS:
            continue   # emitted explicitly by the extra_collections scan below
        subcollection = segs[1] if len(segs) > 2 else ""
        collection_root = os.path.join(DATASETS, collection)
        ext = os.path.splitext(abspath)[1].lower()
        ref = ref_by_real.get(rp)

        if ref:
            track_type = ref["type"]
        elif ext in BIGWIG_EXT:
            track_type = "bigWig"
        elif ext in BIGBED_EXT:
            track_type = "bigBed"
        else:
            track_type = "unknown"
        # a bigBed that is really interact- or narrowPeak-format (source hub
        # mislabeled it) is reclassified from its own autoSql so it routes and
        # renders correctly (interact -> interact composite; narrowPeak stays a
        # peak in the signal/peaks composite but with peak semantics)
        if track_type == "bigBed" and ext in BIGBED_EXT and os.path.exists(abspath):
            _tbl = bb_autosql_table(abspath)
            if _tbl == "interact":
                track_type = "bigInteract"
            elif _tbl == "bigNarrowPeak":
                track_type = "bigNarrowPeak"

        # Exclusions first, so we can skip the expensive bigWigInfo assembly
        # probe on files that won't ship anyway.
        excluded = 0
        reasons = []
        if is_wip(abspath):
            excluded = 1
            reasons.append("wip_test_path")
        # Unreferenced files in submitter "source" directories are not hub
        # candidates (pre-processing originals, usually duplicated by a curated
        # hub copy) -- BUT only drop them when the collection actually has a
        # curated hub. For hub-less collections (e.g. neuron-stimulation) the
        # orig/ files are the only data and must survive for phase 3.
        if (not ref and collection in collections_with_refs
                and any(s.lower() in CFG["orig_source_dirs"] for s in segs)):
            excluded = 1
            reasons.append("orig_source_file")
        hidden, _hconf = is_hidden(os.path.dirname(abspath), collection_root)
        cellbrowser_hidden = 1 if hidden else 0
        if hidden:
            excluded = 1
            reasons.append("hidden_from_cellbrowser")
        if track_type == "bam":
            excluded = 1
            reasons.append("bam_default_excluded")
        # Gate out datasets whose desc is still the cbBuild placeholder (or
        # missing) -- not ready for a public hub (e.g. neuron-stimulation has no
        # desc at all; opc-dev still has the "Sample Dataset description" stub).
        if not collection_ready(collection_root):
            excluded = 1
            reasons.append("desc_placeholder")

        assembly = None
        asm_source = ""
        if ref and ref.get("assembly"):
            assembly = ref["assembly"]
            asm_source = "hub"
        if not assembly:
            v, _ = nearest_conf_value(os.path.dirname(abspath), collection_root, "ucscDb")
            if v:
                assembly = v
                asm_source = "conf"
        if not assembly:
            v, _ = nearest_conf_value(os.path.dirname(abspath), collection_root, "atacSearch")
            if v:
                assembly = v.split(".")[0]
                asm_source = "atacSearch"
        if not assembly:
            # orphan track sitting in a dir alongside resolved hub tracks
            sib = dir_assembly.get(os.path.dirname(abspath))
            if sib:
                assembly = sib
                asm_source = "sibling"
        if not assembly and ext in BIGWIG_EXT and not excluded:
            a = assembly_from_bigwig(abspath)
            if a:
                assembly = a
                asm_source = "bigWigInfo"
        if not assembly:
            assembly = "UNKNOWN"
            asm_source = "unknown"
            if not excluded:
                unknown_count += 1

        # Served URL: htdocs-cells is the DocumentRoot. If the physical file
        # lives under htdocs (directly or via a hub-dir symlink, e.g. cortex-dev
        # -> htdocs-cells/hubs/cortex-dev), it is served at its htdocs-relative
        # URL. Otherwise use the datasets-relative path and check for an htdocs
        # mirror copy.
        if rp.startswith(HTDOCS_REAL + os.sep):
            track_url = "%s/%s" % (SERVED_BASE, os.path.relpath(rp, HTDOCS_REAL))
            is_published = True
        else:
            rel = os.path.relpath(abspath, DATASETS)
            track_url = "%s/%s" % (SERVED_BASE, rel)
            is_published = os.path.exists(os.path.join(HTDOCS, rel))
        is_htdocs_copy = "served" if is_published else "no"
        needs_review = 1 if (assembly == "UNKNOWN" and not excluded) else 0

        master_track = "%s__%s__%s" % (
            slug(collection), slug(subcollection) if subcollection else "x",
            slug(ref["name"]) if ref else slug(os.path.splitext(os.path.basename(abspath))[0]))
        master_track = master_track[:128]
        if track_type == "bigNarrowPeak":
            comp = "%s__peaks" % collection
        elif track_type == "bigInteract":
            comp = "%s__interactions" % collection
        elif track_type == "bigBed":
            comp = "%s__beds" % collection
        else:
            comp = collection

        rows.append(OrderedDict([
            ("abs_path", abspath),
            ("track_type", track_type),
            ("is_htdocs_copy", is_htdocs_copy),
            ("collection", collection),
            ("subcollection", subcollection),
            ("assembly", assembly),
            ("assembly_source", asm_source),
            ("existing_hub_path", ref["hub"] if ref else ""),
            ("original_track_name", ref["name"] if ref else ""),
            ("track_url", track_url),
            ("master_track_name", master_track),
            ("master_composite_name", comp),
            ("cellbrowser_hidden", cellbrowser_hidden),
            ("excluded", excluded),
            ("excluded_reason", ";".join(reasons)),
            ("needs_review", needs_review),
        ]))

    # ---- extra_collections: track-only sources not laid out as CB datasets ----
    # Scanned fresh (not via the discovery cache); emitted with the configured
    # collection/assembly and excluded=0 so they bypass the desc-readiness gate.
    extra_n = 0
    for e in CFG.get("extra_collections", []):
        coll, asm = e["collection"], e["assembly"]
        for root in e["roots"]:
            ttype = root["type"]
            base = os.path.join(DATASETS, root["path"])
            if not os.path.isdir(base):
                sys.stderr.write("  WARN extra_collections root missing: %s\n" % base)
                continue
            for dirpath, _dirs, files in os.walk(base):
                for f in sorted(files):
                    fl = f.lower()
                    if not (fl.endswith(BIGWIG_EXT) or fl.endswith(BIGBED_EXT)):
                        continue
                    abspath = os.path.join(dirpath, f)
                    stem = re.sub(r"\.inter$", "", os.path.splitext(f)[0])
                    rel = os.path.relpath(abspath, DATASETS)
                    # cCRE/peak bigBeds get a peak-ish label so build_stanzas
                    # classifies them as peaks (-> ATAC faceted composite) rather
                    # than annotations. Drop the collection-hint filename prefix.
                    # label: optional per-collection regex cleanup of the filename stem
                    sub = e.get("label_sub")
                    lbl = re.sub(sub[0], sub[1], stem) if sub else stem
                    otn = ""
                    if ttype == "bigBed":
                        if not sub:
                            lbl = lbl.split("_", 1)[1] if "_" in lbl else lbl
                        lbl = lbl.replace("_", " ").strip()
                        if root.get("datatype") == "cCRE":
                            otn = lbl + " cCREs"
                        else:
                            otn = lbl if "peak" in lbl.lower() else lbl + " peaks"
                    elif sub:
                        otn = lbl.strip()   # bigWig: keep underscores (cluster ids)
                    if ttype == "bigNarrowPeak":
                        comp = "%s__peaks" % coll
                    elif ttype == "bigInteract":
                        comp = "%s__interactions" % coll
                    elif ttype == "bigBed":
                        comp = "%s__beds" % coll
                    else:
                        comp = coll
                    rows.append(OrderedDict([
                        ("abs_path", abspath),
                        ("track_type", ttype),
                        ("is_htdocs_copy", "no"),
                        ("collection", coll),
                        ("subcollection", ""),
                        ("assembly", asm),
                        ("assembly_source", "config"),
                        ("existing_hub_path", ""),
                        ("original_track_name", otn),
                        ("track_url", "%s/%s" % (SERVED_BASE, rel)),
                        ("master_track_name", ("%s__x__%s" % (slug(coll), slug(stem)))[:128]),
                        ("master_composite_name", comp),
                        ("cellbrowser_hidden", 0),
                        ("excluded", 0),
                        ("excluded_reason", ""),
                        ("needs_review", 0),
                    ]))
                    extra_n += 1
    if extra_n:
        sys.stderr.write("Added %d extra_collections track rows\n" % extra_n)

    cols = list(rows[0].keys()) if rows else []
    mpath = os.path.join(OUTDIR, "manifest.tsv")
    with open(mpath, "w") as fh:
        fh.write("\t".join(cols) + "\n")
        for r in rows:
            fh.write("\t".join(str(r[c]) for c in cols) + "\n")
    sys.stderr.write("Wrote %s (%d rows)\n" % (mpath, len(rows)))

    write_report(rows, hubs, decoy_reals, unknown_count, broken_refs)


def write_report(rows, hubs, decoy_reals, unknown_count, broken_refs):
    out = []
    out.append("# Cell Browser all-tracks super hub - Phase 1 inventory report\n")
    out.append("Redmine #37820. Source: `%s` and `%s`.\n" % (DATASETS, HTDOCS))

    total = len(rows)
    incl = [r for r in rows if not r["excluded"]]
    excl = [r for r in rows if r["excluded"]]
    out.append("## Totals\n")
    out.append("- Track-data files scanned: **%d**" % total)
    out.append("- Included (not excluded): **%d**" % len(incl))
    out.append("- Excluded: **%d**" % len(excl))
    out.append("- hub.txt files parsed: %d" % len(hubs))
    out.append("- UNKNOWN-assembly files (included): %d" % unknown_count)
    orphans = [r for r in incl if not r["existing_hub_path"]]
    out.append("- Orphan tracks (included, in no curated hub): %d" % len(orphans))
    out.append("- Broken hub refs skipped (mostly WIP/decoy hubs): %d\n" % broken_refs)

    def tally(key, subset):
        c = defaultdict(int)
        for r in subset:
            c[r[key]] += 1
        return OrderedDict(sorted(c.items(), key=lambda kv: -kv[1]))

    out.append("## Included tracks by type\n")
    for k, v in tally("track_type", incl).items():
        out.append("- %s: %d" % (k, v))
    out.append("")

    out.append("## Included tracks by assembly\n")
    for k, v in tally("assembly", incl).items():
        out.append("- %s: %d" % (k, v))
    out.append("")

    out.append("## Included: assembly x type\n")
    grid = defaultdict(lambda: defaultdict(int))
    types = []
    for r in incl:
        grid[r["assembly"]][r["track_type"]] += 1
        if r["track_type"] not in types:
            types.append(r["track_type"])
    types = sorted(types)
    out.append("| assembly | " + " | ".join(types) + " | total |")
    out.append("|" + "---|" * (len(types) + 2))
    for asm in sorted(grid):
        cells = [str(grid[asm].get(t, 0)) for t in types]
        out.append("| %s | %s | %d |" % (asm, " | ".join(cells),
                                          sum(grid[asm].values())))
    out.append("")

    out.append("## Exclusions by reason\n")
    rc = defaultdict(int)
    for r in excl:
        for reason in r["excluded_reason"].split(";"):
            if reason:
                rc[reason] += 1
    for k, v in sorted(rc.items(), key=lambda kv: -kv[1]):
        out.append("- %s: %d" % (k, v))
    out.append("")

    out.append("## Datasets gated for placeholder/missing desc\n")
    out.append("Excluded because their desc.conf/desc.json is still the cbBuild "
               "template placeholder or absent (not ready for a public hub):\n")
    gated = defaultdict(int)
    for r in excl:
        if "desc_placeholder" in r["excluded_reason"]:
            gated[r["collection"]] += 1
    if not gated:
        out.append("None.\n")
    else:
        for coll in sorted(gated):
            out.append("- %s: %d tracks" % (coll, gated[coll]))
    out.append("")

    out.append("## Per-collection counts (included / total)\n")
    by_coll = defaultdict(lambda: [0, 0])
    for r in rows:
        by_coll[r["collection"]][1] += 1
        if not r["excluded"]:
            by_coll[r["collection"]][0] += 1
    out.append("| collection | included | total | assemblies |")
    out.append("|---|---|---|---|")
    for coll in sorted(by_coll):
        asms = sorted({r["assembly"] for r in rows
                       if r["collection"] == coll and not r["excluded"]})
        inc, tot = by_coll[coll]
        out.append("| %s | %d | %d | %s |" % (coll, inc, tot, ",".join(asms) or "-"))
    out.append("")

    out.append("## Published vs unpublished (included tracks)\n")
    pub = sum(1 for r in incl if r["is_htdocs_copy"] == "served")
    out.append("- Reachable via cells.ucsc.edu: %d" % pub)
    out.append("- Not yet served (needs publishing in phase 2): %d\n"
               % (len(incl) - pub))

    out.append("## Orphan tracks by collection (on disk, in no curated hub)\n")
    orph = defaultdict(lambda: defaultdict(int))
    for r in incl:
        if not r["existing_hub_path"]:
            orph[r["collection"]][r["track_type"]] += 1
    if not orph:
        out.append("None.\n")
    else:
        out.append("| collection | by type | total |")
        out.append("|---|---|---|")
        for coll in sorted(orph):
            parts = ", ".join("%s:%d" % (t, n) for t, n in sorted(orph[coll].items()))
            out.append("| %s | %s | %d |" % (coll, parts, sum(orph[coll].values())))
        out.append("")

    out.append("## UNKNOWN-assembly files (needs review)\n")
    unk = [r for r in incl if r["assembly"] == "UNKNOWN"]
    if not unk:
        out.append("None among included tracks.\n")
    else:
        for r in unk[:50]:
            out.append("- %s" % r["abs_path"])
        if len(unk) > 50:
            out.append("- ...and %d more" % (len(unk) - 50))
    out.append("")

    rpath = os.path.join(OUTDIR, "inventory-report.md")
    with open(rpath, "w") as fh:
        fh.write("\n".join(out) + "\n")
    sys.stderr.write("Wrote %s\n" % rpath)


if __name__ == "__main__":
    main()
