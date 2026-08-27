#!/usr/bin/env python3
"""
Phase 2 of the Cell Browser all-tracks super hub (Redmine #37820).

Reads manifest.tsv (Phase 1) + re-parses the curated hubs, and emits, per assembly:
  - stanzas/<assembly>.trackDb.txt   one `compositeTrack faceted` parent + a flat
                                     child stanza per curated track
  - meta/<assembly>.metadata.tsv     facet metadata, primaryKey = `track`

Plus: unpublished.tsv, name-collisions.log, facet-coverage.md.

Only CURATED tracks (manifest existing_hub_path set, excluded=0) are handled here;
orphans + hub-less collections are Phase 3.

See plan: /hive/users/mspeir/claude/cell-browser/plans/tracks-super-hub.md
"""

import os
import re
import json
import csv
import sys
import hashlib
import pickle
import subprocess
from collections import defaultdict, OrderedDict, Counter
from urllib.parse import urlparse

import build_manifest as bm   # reuse parser, discovery cache, slug, helpers, CFG

CFG = bm.CFG                  # wrangler-editable curation config (hub_config.json)
# Host the emitted URLs point at. Defaults to the canonical served_base; override
# with HUB_BASE_URL to stage on cells-test (no manifest rebuild -- the host of
# each manifest track_url is rewritten below).
TARGET_BASE = os.environ.get("HUB_BASE_URL", CFG["served_base"]).rstrip("/")
SOURCE_BASE = CFG["served_base"].rstrip("/")
BIGWIGINFO = bm.BIGWIGINFO
# chr1 size -> assembly, for resolving the hub-less bigWigs left UNKNOWN by Phase 1
CHR1_SIZE = {int(k): v for k, v in CFG["assembly_chr1_size"].items()}

OUTDIR = bm.OUTDIR
MANIFEST = os.path.join(OUTDIR, "manifest.tsv")
CACHE = os.path.join(OUTDIR, "discovery.pkl")
STANZADIR = os.path.join(OUTDIR, "stanzas")
METADIR = os.path.join(OUTDIR, "meta")

MAX_TRACKNAME = 128

DATATYPE = {
    "bigWig": "signal",
    "bigNarrowPeak": "peaks",
    "bigInteract": "interactions",
    "bigBed": "annotation",
    "bigBarChart": "expression",
}
# friendly display labels for the Data type facet values (internal signal/peaks kept for routing)
DATATYPE_LABELS = CFG.get("datatype_labels", {})

# modality detection + per-collection fallback, both from hub_config.json so a
# wrangler can extend them without editing code. Rules are ordered [regex, label]
# (case-insensitive); first match wins. Fallback applies only when no rule matches.
MODALITY_RULES = [(re.compile(p, re.I), lab) for p, lab in CFG["modality_rules"]]
COLLECTION_MODALITY = CFG["collection_modality"]
# multiome browser signal/peaks are the ATAC (accessibility) readout; the RNA half of a
# multiome assay isn't a genome-browser signal track. So resolve a 'multiome' modality
# (the faceted composite only holds signal/peaks) to the assay that produced the track.
MULTIOME_MODALITY = CFG.get("modality_multiome_is", "ATAC")

# stanza keys NOT copied to the faceted child (structural / container / inherited)
DROP_KEYS = {
    "track", "parent", "subtrack", "subgroups", "compositetrack", "supertrack",
    "view", "container", "priority", "visibility", "html", "_genome",
    "parentcontainer", "dragandrop", "centerlabelsdense", "configurable",
    "metadata", "subgroup1", "subgroup2", "subgroup3",
    # Scaling is set once on the faceted composite parent as `autoScale group`, so every
    # selected subtrack shares one scale and tracks at the same locus are directly
    # comparable. A per-subtrack autoScale would override that inherited setting, and
    # hubCheck errAborts outright on an individual bigWig that declares `autoScale group`
    # (hubCheck.c: it belongs "in the parent composite stanza instead") -- 637 subtracks
    # had inherited exactly that verbatim from their source hubs.
    "autoscale",
}

# stanza keys whose values are URLs relative to the hub dir and need absolutizing
URL_KEYS = {"bigdataurl", "barchartmatrixurl", "barchartsampleurl",
            "bigdataindex", "searchtrix"}


def composite_name(asm):
    return "cellBrowser" + asm[:1].upper() + asm[1:]


def modality_of(collection, *texts):
    """Keyword rules over track-specific text (path/composite/child labels), then a
    per-collection fallback for single-modality studies."""
    blob = " ".join(t for t in texts if t)
    for rx, label in MODALITY_RULES:
        if rx.search(blob):
            return label
    return COLLECTION_MODALITY.get(collection, "")


JUNK_RE = re.compile(CFG["celltype_junk_regex"], re.I)
GENERIC = set(CFG["celltype_generic_words"])
CELLTYPE_MAX_LEN = CFG["celltype_max_len"]
AGG_LABEL = CFG["aggregate_celltype_label"]
AGG_NAME_RE = re.compile(CFG["aggregate_name_regex"])
ORPHAN_DROP_RES = [re.compile(p) for p in CFG["orphan_drop_name_patterns"]]
# peak-method suffixes tacked onto cell-type labels (cortex-atac: "Microglia_MACSpeaks")
_strip_sfx = CFG.get("celltype_strip_suffix_regex")
CELLTYPE_STRIP_RE = re.compile(_strip_sfx, re.I) if _strip_sfx else None
# longLabels that mark a track as NOT per-cell-type (-> cellType unknown)
_ignore_lbl = CFG.get("celltype_ignore_label_regex")
CELLTYPE_IGNORE_RE = re.compile(_ignore_lbl, re.I) if _ignore_lbl else None


def clean_celltype(short, long_, composite):
    """Best-effort cell-type label from curated CHILD labels only (the composite
    name is a track identifier, not a label, so it is NOT used). Junk (giant
    filenames, cbHub boilerplate, product suffixes, generic words) -> empty."""
    for cand in (short, long_):
        if not cand:
            continue
        c = cand.strip()
        # GSM ChIP/CUT&Tag sample labels (e.g. mecp2 "GSM..._H3K27ac_PV_WTko_B1"):
        # the cell type is the PV / total token.
        if re.match(r"GSM\d+_", c):
            m = re.search(r"_(PV|total)_", c, re.I)
            if m:
                return m.group(1)
            continue
        # "Tissue - CellType" labels (human-enhancer-atlas, fetal-chromatin-atlas):
        # keep the cell-type half.
        if " - " in c:
            c = c.split(" - ", 1)[1].strip()
        c = re.sub(r"^(bw|bb|bigwig|bigbed|signal|cov|coverage)[_\- ]+", "", c, flags=re.I)
        c = re.sub(r"\s+(BAM|Cov|Junc|Peaks|Signal|Coverage|Reads)$", "", c, flags=re.I)
        if CELLTYPE_STRIP_RE:                 # drop peak-method suffixes (Microglia_MACSpeaks -> Microglia)
            c = CELLTYPE_STRIP_RE.sub("", c)
        c = c.strip(" _-")
        if not c or len(c) > CELLTYPE_MAX_LEN:
            continue
        if JUNK_RE.search(c) or c.lower() in GENERIC:
            continue
        return c
    return ""


def collapse_celltype(ct):
    """Collapse cell-type facet values (full labels stay in the Name column):
    A) strip uncleaned ArchR/TileSize filename tails ('C11-TileSize-...-ArchR' -> 'C11');
    B) strip trailing cluster/replicate numbers ('Fetal Excitatory Neuron 1' -> base).
    (C, plural/case merging, is a separate global canonical map built in main.)"""
    if not ct:
        return ct
    ct = re.sub(r"[-_ ]?tilesize[-_].*$", "", ct, flags=re.I)   # A
    ct = re.sub(r"\s+\d+$", "", ct).strip()                     # B
    return ct


def celltype_normkey(ct):
    """Grouping key for the plural/case merge (C): lower-cased, trailing 's' dropped."""
    return re.sub(r"s$", "", ct.lower())


_CELL_SFX_RE = re.compile(r"\s+cells?$", re.I)

def drop_cell_suffix(ct):
    """Drop a trailing ' cell'/' cells' from a cellType, unless that would leave a
    degenerate label -- a <=2-char remainder (T/B/NK Cell) or an 'All ...' aggregate."""
    base = _CELL_SFX_RE.sub("", ct).strip()
    if base == ct or not base or len(base) <= 2 or re.match(r"(?i)^all\b", base):
        return ct
    return base

def _sentence_case(ct):
    """Sentence case with acronym preservation: lower-case plain Capitalized words,
    keep the first word capitalized, and leave acronyms / gene names / mixed-case /
    symbol tokens untouched (MGE, AT2, GABAergic, CD8+, (AT1), S_Cone)."""
    out = []
    for tok in ct.split(" "):
        if tok.isupper() and len(tok) == 1:      # single-letter acronym (T, B)
            out.append(tok)
        elif tok == tok.capitalize():            # plain Capitalized / lower / non-alpha
            out.append(tok.lower())
        else:                                    # acronym / internal caps / symbols
            out.append(tok)
    s = " ".join(out)
    for i, ch in enumerate(s):                   # capitalize the first alphabetic char
        if ch.isalpha():
            return s[:i] + ch.upper() + s[i + 1:]
    return s

# Misspellings in the source cluster labels. Fixed before the plural/case merge so a
# typo'd variant lands in the same group as its correctly-spelled twin instead of
# becoming a second facet value ('Ventricular cardioyocyte' vs 'Ventricular
# cardiomyocyte' were two separate Cell_type values). Word-level and case-insensitive.
CELLTYPE_SPELLING = [
    (r"\bcardioyocytes?\b",     "cardiomyocyte"),
    (r"\bcardiomyocyes?\b",     "cardiomyocyte"),
    (r"\bhematopoeitic\b",      "hematopoietic"),
    (r"\bsyncitiotrophoblast",  "syncytiotrophoblast"),
    (r"\bbroncial\b",           "bronchial"),
    (r"\bbiploar\b",            "bipolar"),
    (r"\balverolar\b",          "alveolar"),
    # the dataset means the glutamate-releasing neuron class (glutamatergic);
    # 'glutaminergic' is not a cell class and splits the facet.
    (r"\bglutaminergic\b",      "glutamatergic"),
]


def fix_celltype_spelling(ct):
    """Correct known source misspellings in a cell-type label (case-preserving for the
    leading character, which _sentence_case fixes up afterwards anyway)."""
    for pat, repl in CELLTYPE_SPELLING:
        ct = re.sub(pat, repl, ct, flags=re.I)
    return ct


# Curated cell-type lookups are keyed on strings taken from the source data, and several
# carry the source's misspellings ("Broncial and alveolar epithelial", "Atrial
# cardiomyocyes", "Glutaminergic Neuron"). Correcting the spelling of the cell types has
# to correct these keys too, or the lookup silently misses and the track quietly loses
# its rollup/alias/tissue/class. Normalizing keys on load keeps every table working
# whichever spelling the config happens to use.
def _ct_lower_key(s):
    return fix_celltype_spelling(s or "").lower()


def normalize_celltype(ct):
    """Final Cell-type display normalization: underscores -> spaces, split camelCase
    compounds ('ExcitatoryNeurons' -> 'Excitatory Neurons'), fix known source
    misspellings, drop trailing 'cell(s)' (protected), then sentence-case. Keeps the
    facet reading consistently."""
    if not ct:
        return ct
    ct = ct.replace("_", " ")
    ct = re.sub(r"(?<=[a-z])(?=[A-Z][a-z])", " ", ct)   # camelCase boundary (safe: needs Aa)
    ct = re.sub(r"\s+", " ", ct).strip()
    ct = fix_celltype_spelling(ct)
    return _sentence_case(drop_cell_suffix(ct))

ROLLUP_ENABLED = CFG.get("celltype_rollup_enabled", False)
_rollup_protect = CFG.get("celltype_rollup_protect_regex", "")
ROLLUP_PROTECT_RE = re.compile(_rollup_protect) if _rollup_protect else None
ROLLUP_OVERRIDES = {_ct_lower_key(k): v
                    for k, v in CFG.get("celltype_rollup_overrides", {}).items()}
ROLLUP_REGEX = [(re.compile(p), v) for p, v in CFG.get("celltype_rollup_regex", [])]
_ROLLUP_PAREN_RE = re.compile(r"\s*\([^)]*\)")
_ROLLUP_SUBNUM_RE = re.compile(r"\s+\d+([/-]\d+)?[a-z]?$")

def rollup_celltype(ct):
    """Collapse a fine Cell type to a higher level in place: strip a trailing parenthetical
    qualifier and a trailing subtype number (unless protected), apply overrides, then the
    catch-all regex rules. The full fine label is preserved in the track Name/_name column."""
    if not ROLLUP_ENABLED or not ct:
        return ct
    c = _ROLLUP_PAREN_RE.sub("", ct).strip()
    if not (ROLLUP_PROTECT_RE and ROLLUP_PROTECT_RE.search(c)):
        c = _ROLLUP_SUBNUM_RE.sub("", c).strip()
    c = ROLLUP_OVERRIDES.get(c.lower(), c)
    for pat, repl in ROLLUP_REGEX:
        if pat.search(c):
            return repl
    return c or ct

def _ct_matchkey(s):
    """Match key for CELLTYPE_TISSUE: robust to the cell/cells drop + case/plural +
    the known source misspellings."""
    return celltype_normkey(drop_cell_suffix(fix_celltype_spelling(s or "")))

SPECIES_WORDS = {w.lower() for w in CFG.get("celltype_species_words", [])}


def expand_acronym_from_label(ct, longlabel):
    """If the curated longLabel spells out the acronym as '<ACR> - <expansion>'
    (retina 'DB1 - diffuse bipolar 1', mouse-kidney 'DCT - Distal Convoluted Tubes',
    olg-eae 'MiGl - Microglia'), return the expansion; else the acronym unchanged.
    Paper-sourced expansions (where the label has none) come from CFG celltype_expansions."""
    if not longlabel:
        return ct
    m = re.search(re.escape(ct) + r"\s*-\s*([A-Za-z][^(]*?)(?=\s*\(|\s+-\s+|$)", longlabel)
    if m:
        exp = re.sub(r"\s+", " ", m.group(1)).strip(" .-")
        if 3 <= len(exp) <= 60 and exp.lower() != ct.lower():
            return exp[:1].upper() + exp[1:]
    return ct


# per-dataset acronym -> expansion, keys lower-cased for case-insensitive match
CELLTYPE_EXPANSIONS = {ds: {_ct_lower_key(k): v for k, v in m.items()}
                       for ds, m in CFG.get("celltype_expansions", {}).items()}

# per-dataset cellType -> tissue override (keyed by the plural/case-normalized name),
# for tissue-restricted cell types in otherwise-'multiple' whole-body atlases.
CELLTYPE_TISSUE = {ds: {_ct_matchkey(k): v for k, v in m.items()}
                   for ds, m in CFG.get("celltype_tissue", {}).items()}

# universal (all-dataset) cellType acronym/variant -> canonical, case-insensitive full match
CELLTYPE_EXPANSIONS_GLOBAL = {_ct_lower_key(k): v
                              for k, v in CFG.get("celltype_expansions_global", {}).items()}

# leading life-stage word stripped from a cellType (so fetal/adult forms collapse)
_ls_pfx = CFG.get("celltype_lifestage_prefixes", [])
LIFESTAGE_PREFIX_RE = (re.compile(r"^(?:%s)\s+" % "|".join(re.escape(w) for w in _ls_pfx),
                                  re.I) if _ls_pfx else None)

# per-dataset [segment-regex, life-stage] rules for the Life stage facet
LIFESTAGE_FROM_PATH = {ds: [(re.compile(rx, re.I), lab) for rx, lab in rules]
                       for ds, rules in CFG.get("lifestage_from_path", {}).items()}
# per-dataset uniform life stage (whole collection is one stage; no path signal needed)
COLLECTION_LIFESTAGE = CFG.get("collection_lifestage", {})

def track_lifestage(row):
    """Life stage for a track: a path segment matched against the dataset's
    LIFESTAGE_FROM_PATH rules (first match wins), else the dataset's uniform
    COLLECTION_LIFESTAGE, else ''."""
    for seg in row["abs_path"].split("/"):
        for rx, lab in LIFESTAGE_FROM_PATH.get(row["collection"], []):
            if rx.match(seg):
                return lab
    return COLLECTION_LIFESTAGE.get(row["collection"], "")

# Condition facet, per collection: {default, map{token->Condition}}. Tokens match a coded
# shortLabel suffix (X_Ctr) or a word in short/long/filename, and are stripped from the cellType.
COLLECTION_CONDITION = CFG.get("collection_condition", {})
CONDITION_STRIP_RE = {}
for _coll, _cfg in COLLECTION_CONDITION.items():
    _keys = sorted(_cfg.get("map", {}), key=len, reverse=True)
    if _keys:
        _alt = "|".join(re.escape(k) for k in _keys)
        CONDITION_STRIP_RE[_coll] = re.compile(r"^(?:%s)\b\s*|[_ ](?:%s)$" % (_alt, _alt), re.I)

def track_condition(coll, short, long_, stem):
    """Condition for a track: a token from the collection's map matched as a coded
    shortLabel suffix (X_Ctr) or a word in short/long/filename -> that Condition;
    else the collection default; else '' (collection not configured)."""
    cfg = COLLECTION_CONDITION.get(coll)
    if not cfg:
        return ""
    mp = cfg.get("map", {})
    for part in (short or "", stem or ""):        # coded suffix X_Cond wins
        if "_" in part:
            m = re.match(r"[a-z]+", part.rsplit("_", 1)[-1].lower())
            if m and m.group(0) in mp:
                return mp[m.group(0)]
    low = " %s _ %s _ %s " % (short or "", long_ or "", stem or "")
    low = low.lower()
    for k in sorted(mp, key=len, reverse=True):   # else any condition word
        if re.search(r"(?<![a-z])%s(?![a-z])" % re.escape(k), low):
            return mp[k]
    return cfg.get("default", "")

def strip_condition(coll, ct):
    """Remove the condition token (leading word or trailing _code) from a cellType so
    condition variants of one cell type merge; '' guard keeps a bare condition intact."""
    rx = CONDITION_STRIP_RE.get(coll)
    if not rx:
        return ct
    out = rx.sub("", ct).strip(" _")
    return out or ct

# trailing junk stripped from a cellType before expansion (e.g. ' unsure' confidence marker)
_trail = CFG.get("celltype_trailing_strip_regex", "")
CELLTYPE_TRAIL_RE = re.compile(_trail, re.I) if _trail else None

# leading assay/histone-mark token stripped from a cellType (redundant with the modality facet)
_lead = CFG.get("celltype_leading_strip_regex", "")
CELLTYPE_LEAD_RE = re.compile(_lead, re.I) if _lead else None

# Collections whose source hub stanzas are NOT usable, so every track in them is built
# as if it had no curated stanza at all: cellType from the manifest original_track_name
# (the source FILENAME) and a generated stanza (bigWigInfo data range, autoScale on).
# See the _doc in hub_config.json. Two independent things go wrong when these hubs'
# stanzas are trusted: the labels are in a different naming scheme than the curation
# written for the collection (so label_sub, the leading-token strip and the per-collection
# crosswalk all miss, costing 72 hg38 + 89 mm10 tracks their cell class and colour), and
# the stanzas declare a bare `type bigWig` with no data range (so 184 hg38 + 89 mm10
# tracks lose the default viewLimits they would get from bigWigInfo).
IGNORE_HUB_STANZAS = set(CFG.get("collection_ignore_hub_stanzas", []))


def curated_ref(ref, row):
    """The curated hub leaf for a manifest row, or None when the row's collection is in
    IGNORE_HUB_STANZAS. Every lf lookup goes through this so a collection cannot be
    opted out of the hub labels but still pick up the hub's stanza settings."""
    if row["collection"] in IGNORE_HUB_STANZAS:
        return None
    return ref.get(os.path.realpath(row["abs_path"]))

# whole collections routed out of the faceted composite into their own composite
SEPARATE_COLLECTIONS = CFG.get("separate_collections", {})

# expression (RNA coverage) tracks routed to their own plain composite, out of the facets
EXPRESSION_COMPOSITE = CFG.get("expression_composite")
EXPRESSION_MODALITIES = set(EXPRESSION_COMPOSITE["modalities"]) if EXPRESSION_COMPOSITE else set()

# histone-mark tracks routed to a SECOND faceted composite (own metadata file)
HISTONE_COMPOSITE = CFG.get("histone_composite")
HISTONE_MODALITIES = set(HISTONE_COMPOSITE["modalities"]) if HISTONE_COMPOSITE else set()

# cCRE bigBeds routed to their own faceted composite (kept apart from raw peaks,
# the way ENCODE cCREs are a separate track). A bigBed is a cCRE if its label matches:
CCRE_COMPOSITE = CFG.get("ccre_composite")
CCRE_RE = re.compile(r"ccre", re.I)

# The Dataset facet cell is "<cells slug>|<label>", and subtrackUrls turns the slug into
# a https://cells.ucsc.edu/?ds=<slug> link. The collection name is usually also the Cell
# Browser slug, but not always -- the SEA-AD ATAC collection is served as the
# sea-ad-mtg collection's cohort dataset, so linking it by collection name 404s. Map the
# exceptions here (verified against <site>/<slug>/dataset.json on cells and cells-test).
CELLS_DATASET = CFG.get("collection_cells_dataset", {})

# Short name for each kind of track, for the case where a track holds data from only one
# dataset. Then the generic "Cell Browser <type>" label wastes the whole line saying what
# the hub already says, so the label becomes "<short name> - <dataset>"
# ("Cell Browser splice junctions" -> "Splice Junc - Cortex development") and the reader
# can tell the tracks apart in the browser's track list. Wrangler-editable in
# hub_config.json, keyed on the track-name suffix after cellBrowser<Asm>.
TYPE_SHORT = CFG.get("track_type_short", {})
_type_short_warned = set()


def harmonize_celltype(r, lf, canon):
    """(celltype, xw_tissue, xw_life, xw_cond) for a track, or (None, ...) if the cluster
    is a QC artefact the caller should drop.

    Factored out so the composites that are routed before the main cell-type resolution
    (interactions, split-out collections) can label themselves from the same harmonized
    name the faceted composite uses, instead of falling back to the raw filename. One
    implementation, so those labels cannot drift from the facet values."""
    base = raw_celltype(r, lf)
    ct = canon.get(base, base)
    ct = rollup_celltype(ct)
    xw_tissue = xw_life = xw_cond = ""
    cw = CELLTYPE_CROSSWALK.get(r["collection"])
    if cw and ct in cw:
        ct, _color, xw_tissue, xw_life, xw_cond = cw[ct]
    if ct:
        ct = normalize_celltype_final(ct)      # None => QC cluster
    return ct, xw_tissue, xw_life, xw_cond


def indent_stanza(stanza, width=4):
    """Indent a subtrack stanza to show the hierarchy, as the trackDb .ra files in the
    kent tree do (chainNet, encode3): a top-level track sits flush left and each level
    below it is indented one step, with every line of the stanza moving together."""
    lines = stanza.split("\n")
    depth = 1 if any(l.startswith("parent ") for l in lines) else 0
    if not depth:
        return stanza
    pad = " " * (width * depth)
    return "\n".join(pad + l if l.strip() else l for l in lines)


def dataset_scoped_labels(suffix, short, long_, colls):
    """(shortLabel, longLabel) for a top-level track, naming the dataset when the track
    draws on exactly one. Multi-dataset tracks keep the generic labels -- there the
    dataset belongs on each child, not on the container.

    `suffix` is the track name's suffix after cellBrowser<Asm>, which is what
    track_type_short is keyed on."""
    if len(colls) != 1:
        return short, long_
    ds = bm.dataset_label(next(iter(colls)))
    if not ds:
        return short, long_
    if suffix not in TYPE_SHORT and suffix not in _type_short_warned:
        _type_short_warned.add(suffix)
        sys.stderr.write("WARNING: no track_type_short entry for suffix %r (%s); "
                         "using the full label\n" % (suffix, short))
    # Never trim inside the dataset name -- that is the part the reader needs, and cutting
    # it produced labels that were actively wrong ("CATLAS Adult Mouse Brain" for the
    # Paired-Tag dataset, which is a different dataset of nearly the same name). If the
    # line is too long, shorten the type instead and let the dataset stand whole.
    # Neither half is safe to trim. Cutting the dataset name produced labels that were
    # wrong ("CATLAS Adult Mouse Brain" for the Paired-Tag dataset, a different dataset of
    # nearly the same name); cutting the type produced labels that were wrong the other way
    # ("Signal" for a track that also holds peaks, "Motor" for Motor Neuron ATAC). So the
    # label runs as long as it needs to. A handful reach the low 60s, which is unusual but
    # not unheard of in trackDb -- shorten the dataset shortLabel if one bothers you.
    short_new = "%s - %s" % (TYPE_SHORT.get(suffix, short), ds)
    # the generic longLabel says "from UCSC Cell Browser datasets"; name the dataset
    if "UCSC Cell Browser datasets" in long_:
        long_new = long_.replace("UCSC Cell Browser datasets", "the %s dataset" % ds)
    elif ds.lower() in long_.lower():
        long_new = long_
    else:
        # insert before a trailing "(assembly)" so the dataset does not dangle after it
        m = re.match(r"^(.*?)(\s*\([^()]*\))$", long_)
        long_new = ("%s from the %s dataset%s" % (m.group(1), ds, m.group(2))
                    if m else "%s from the %s dataset" % (long_, ds))
    return short_new, long_new

# Root for the curated cell-type crosswalks. The archive of record is the copy in the
# kent tree (src/hg/makeDb/scripts/singleCellSignalsPeaks/), which is also where
# build_celltype_crosswalks.py writes; read that copy directly so the two cannot drift.
# They did drift once: a stale local copy silently reverted a cell-class correction, and
# the build kept emitting the old class. Override with XWALK_ROOT.
_HERE = os.path.dirname(os.path.abspath(__file__))
_KENT_XWALK = os.path.expanduser(
    "~/kent/src/hg/makeDb/scripts/singleCellSignalsPeaks")
XWALK_ROOT = os.environ.get("XWALK_ROOT") or (
    _KENT_XWALK if os.path.isdir(os.path.join(_KENT_XWALK, "celltype-crosswalks"))
    else _HERE)
if XWALK_ROOT != _HERE:
    sys.stderr.write("celltype crosswalks: %s\n" % XWALK_ROOT)

# per-collection cell-type crosswalk: collection -> {hubCellType: (canonicalCellType, "R,G,B")}
# harmonizes split facet labels and colors tracks by cell type (e.g. SEA-AD subclass colors)
def xwalk_path(fn):
    """Resolve a crosswalk filename from hub_config. The kent archive keeps everything
    under celltype-crosswalks/ while the build dir has a couple at its top level, so try
    both shapes under XWALK_ROOT before falling back to the build dir."""
    for cand in (os.path.join(XWALK_ROOT, fn),
                 os.path.join(XWALK_ROOT, "celltype-crosswalks",
                              os.path.basename(fn)),
                 os.path.join(_HERE, fn)):
        if os.path.isfile(cand):
            return cand
    return os.path.join(XWALK_ROOT, fn)          # report the primary path in the warning


CELLTYPE_CROSSWALK = {}
for _coll, _fn in CFG.get("collection_celltype_colors", {}).items():
    _p = xwalk_path(_fn)
    _m = {}
    if os.path.isfile(_p):
        for _line in open(_p):
            _c = _line.rstrip("\n").split("\t")
            if len(_c) >= 3:
                # canonicalCellType, "R,G,B", [tissue, life_stage, condition]
                # the trailing three are optional per-track facet overrides (blank = keep computed)
                _m[_c[0]] = (_c[1], _c[2],
                             _c[3] if len(_c) > 3 else "",
                             _c[4] if len(_c) > 4 else "",
                             _c[5] if len(_c) > 5 else "")
    else:
        sys.stderr.write("WARN: celltype crosswalk not found: %s\n" % _p)
    CELLTYPE_CROSSWALK[_coll] = _m

# Global cell-type -> broad-class color, keyed on the FINAL (normalized) cell-type
# facet value. This colors every track on every assembly by one shared palette, so
# the same cell class is the same color on hg38 and mm10. Built by
# build_celltype_crosswalks.py from the paper-curated (mm10) + name-classified (hg38)
# cell types; see celltype-crosswalks/celltype-class.tsv.
CT_CLASS_COLOR = {}
CT_CLASS = {}


def class_key(ct):
    """Lookup key for the cell-class map: spelling-corrected, trailing 'cell(s)' dropped,
    lower-cased, plural collapsed. The map is keyed this way rather than on the literal
    TSV string so a typo, a plural, or a 'cell' suffix in the curated table cannot
    silently cost a track its class and color.

    Both of those have bitten. Correcting 'Broncial'/'Hematopoeitic'/'Syncitio' in the
    cell types, and canonicalizing Megakaryocytes to the singular, stopped 16 hg38 tracks
    matching their still-typo'd keys. And because normalize_celltype drops a trailing
    'cell(s)' from every cell type while this key did not, entries like 'Stromal cell',
    'Olfactory ensheathing cell' and 'Vascular leptomeningeal cell' sat in the table fully
    classed but unreachable. Keep this in step with _ct_matchkey, which already did it."""
    return celltype_normkey(drop_cell_suffix(fix_celltype_spelling(ct or "").strip()))


def lookup_class(ct):
    """(broad class, "R,G,B") for a cell type, or (None, None).

    Falls back to progressively shorter prefixes when the full name is not in the table.
    The atlases qualify a common cell type with the tissue it came from -- 'Fibroblast
    general', 'Fibroblast gastrointestinal', 'Smooth muscle colon', 'Endothelial cell
    myocardial', 'Pericyte general', 'T lymphocyte 1 CD4+' -- and the broad class of the
    qualified type is always the broad class of its head, so 'Fibroblast <anything>' is
    Stromal. Carrying an entry per tissue would mean ~100 near-duplicate rows that go
    stale the moment a new atlas lands, whereas the head word is what the class actually
    depends on. Only ever shortens, so a specific entry still wins over its own prefix."""
    if not ct:
        return None, None
    words = ct.split()
    for n in range(len(words), 0, -1):
        k = class_key(" ".join(words[:n]))
        if k in CT_CLASS:
            return CT_CLASS[k], CT_CLASS_COLOR.get(k)
    return None, None


_ctc = os.path.join(XWALK_ROOT, "celltype-crosswalks", "celltype-class.tsv")
if os.path.isfile(_ctc):
    for _line in open(_ctc):
        _p = _line.rstrip("\n").split("\t")
        if len(_p) >= 3:
            _k = class_key(_p[0])
            CT_CLASS[_k] = _p[1]                 # celltype -> broad class
            CT_CLASS_COLOR[_k] = _p[2]           # celltype -> "R,G,B"
else:
    sys.stderr.write("WARN: celltype-class map not found: %s\n" % _ctc)

# Final cell-type normalization, applied to every track's facet value regardless
# of source (crosswalk canonical or raw hub label), on both assemblies:
#  - QC clusters (doublet/low-quality/batch) are not real cell types -> drop the track
#  - a trailing acronym in parens, e.g. "... (OPC)"/"... (COP)", is redundant
#  - comma-bearing names split in the faceted UI (which tokenizes on ",") -> use ";"
#  - a few synonym pairs are merged so the same cell type is not listed twice
CT_QC_RE = re.compile(r"^(batch|doublets?|possible doublets?|low[ -]?quality)$", re.I)
CT_ALIAS = {
    "mature oligodendrocyte": "Oligodendrocyte",
    "oligodendrocyte precursor": "Oligodendrocyte precursor cell",
}
def normalize_celltype_final(ct):
    """Return the cleaned cell-type facet value, or None for a QC cluster (caller
    drops that track)."""
    if not ct:
        return ct
    ct = re.sub(r"\s*\([A-Z0-9]+\)\s*$", "", ct).strip()   # strip trailing (OPC)/(COP)
    if CT_QC_RE.match(ct):
        return None                                         # QC -> drop the track
    ct = CT_ALIAS.get(ct.lower(), ct)                       # merge redundant synonyms
    return ct.replace(", ", "; ").replace(",", ";")         # avoid faceted-UI comma split

# SEA-AD ATAC: brain region is a path segment (seaad_MTG / seaad_PFC) and the
# ADNC neuropathology level is an "ADNC<n>" prefix on the filename. Regions and
# ADNC categories per Gabitto 2024 (PMID 39402379) / Hawrylycz 2024 (PMID 39402332):
# donors aged 65-102, four ADNC levels (no AD / low / intermediate / high).
SEAAD_REGION = {"seaad_mtg": "middle temporal gyrus",
                "seaad_pfc": "dorsolateral prefrontal cortex"}
SEAAD_ADNC = {"0": "ADNC 0 (no AD)", "1": "ADNC 1 (low)",
              "2": "ADNC 2 (intermediate)", "3": "ADNC 3 (high)"}
def sea_ad_facets(r, stem):
    """(tissue, condition) for a SEA-AD ATAC track, from its path + ADNC prefix."""
    p = r["abs_path"].lower()
    tissue = next((v for k, v in SEAAD_REGION.items() if k in p), "")
    hay = (stem or "") + " " + (r.get("original_track_name") or "")
    m = re.search(r"adnc\s*([0-3])", hay, re.I)
    return tissue, (SEAAD_ADNC.get(m.group(1), "") if m else "")

# a long label built from the harmonized facets reads far better than the cryptic
# source shortLabel (e.g. "ADNC0 Astro" -> "Astrocyte, ADNC 0 (no AD), middle
# temporal gyrus (SEA-AD Brain ATAC)"). Generic/uninformative facet values are left out.
_GENERIC_TISSUE = {"", "unknown", "brain", "multiple", "whole body"}
_GENERIC_COND = {"", "unknown", "healthy"}
def build_long_label(celltype, cond, tissue, dataset, fallback, extra="", variant=""):
    """Readable longLabel from the facets; falls back to the source label when there
    is no usable cell type. `extra` is an optional dataset-specific descriptor added
    after the tissue (e.g. the CATLAS aging age-in-months, which is not a facet).
    `variant` is the track_variant descriptor -- the discriminator the cell-type
    harmonization dropped (peak method, cluster number, grouping level); without it
    genuinely different subtracks share one label."""
    if not celltype:
        return "%s, %s" % (fallback, variant) if (fallback and variant) else fallback
    parts = [celltype]
    if cond and cond.lower() not in _GENERIC_COND:
        parts.append(cond)
    if tissue and tissue.lower() not in _GENERIC_TISSUE:
        parts.append(tissue)
    if extra:
        parts.append(extra)
    if variant:
        parts.append(variant)
    lab = ", ".join(parts)
    if dataset and dataset.lower() not in lab.lower():
        lab = "%s (%s)" % (lab, dataset)
    return lab


##############################################################################
# Variant descriptors
##############################################################################
# The cell-type harmonization deliberately throws away detail so the Cell_class /
# Cell_type facets stay compact: collapse_celltype strips trailing cluster numbers,
# rollup_celltype strips parenthetical qualifiers, and celltype_strip_suffix_regex
# strips peak-method suffixes. That detail is real, though, and without it hundreds of
# genuinely different subtracks collapse onto one label -- cortex-atac's MACS, enhancer
# and cell-type-specific peak sets for one cell type all read
# "Astrocytes and oligodendrocytes (Cortex ATAC)". track_variant recovers each dropped
# discriminator from the source path/filename and returns a (long, short) descriptor
# pair that the label builders append, so every subtrack label is unique again.

# cortex-atac peak flavors (the suffix celltype_strip_suffix_regex removes)
PEAK_METHOD = [
    (r"AllEnhancerPredictions$", "all enhancer predictions",  "allEnhPred"),
    (r"EnhancerPredictions$",    "enhancer predictions",      "enhPred"),
    (r"Enhancerpeaks$",          "enhancer peaks",            "enhPk"),
    (r"MACSpeaks$",              "MACS peaks",                "MACS"),
    (r"Specificpeaks$",          "cell-type-specific peaks",  "specPk"),
]

# allen-brain-science basal ganglia: the same cluster bigWigs are served from four
# grouping directories. Where the underlying file differs the grouping is a real
# distinction and has to be in the label (identical copies are dropped, see
# allen_duplicate_skip).
ALLEN_GROUPING = {
    "bg_regrouping_cl":              ("cluster-level grouping",       "cl"),
    "bg_merge_D1_D2":                ("D1/D2 merge",                  "D1D2"),
    "bg_merge_dorsal_ventral":       ("dorsal/ventral merge",         "DV"),
    "bg_merge_D1_D2_dorsal_ventral": ("D1/D2 + dorsal/ventral merge", "D1D2DV"),
}

# Some collections serve a whole-dataset copy of each cell type AND per-cohort copies
# (multiomic-human-heart: hub/celltype/ vs hub/disease/{fetal,postnatal}/; brainvar:
# bw/ vs bw/{prenatal,postnatal}/). The cohort token is stripped from the cell type, so
# without a descriptor the copies collide on one label. Keyed by collection in
# hub_config.json as {segment: [longDescriptor, shortDescriptor]}; a segment matches
# either a path directory or a leading filename token (Prenatal_ExN).
COLLECTION_COHORTS = {coll: {k: tuple(v) for k, v in rules.items()}
                      for coll, rules in CFG.get("collection_cohorts", {}).items()}

# catlas mouse aging: a two-letter brain-region prefix on the filename (DH.Asc.03).
# This is a Tissue refinement rather than a label suffix -- feeding it to the facet
# both separates the tracks and makes Tissue more specific than the generic 'brain'.
CATLAS_REGION = {"DH": "dorsal hippocampus", "FC": "frontal cortex"}


def catlas_region(collection, stem):
    """Brain region for a catlas-mouse-aging track from its filename prefix, else ''."""
    if collection != "catlas-mouse-aging":
        return ""
    m = re.match(r"([A-Z]{2})\.", stem or "")
    return CATLAS_REGION.get(m.group(1), "") if m else ""


# retina HRCA serves a rolled-up major-class set and a fine subtype set
RETINA_GROUPING = {"majorclass": ("major class", "major"),
                   "bc_subtype": ("bipolar subtype", "BCsub"),
                   "ac_subtype": ("amacrine subtype", "ACsub"),
                   "rgc_subtype": ("RGC subtype", "RGCsub")}


def track_variant(r, lf, stem, dtype, modality=""):
    """(long, short) descriptors for what the cell-type harmonization dropped from this
    track, as two parallel strings ('' when nothing was dropped).

    These are the *meaningful* distinctions -- how the peaks were called, which grouping
    level the track belongs to, which cohort, signal vs peaks. They compose: a peak file
    from a specific cohort needs both markers, and carrying only one was letting the
    bw/bb pair of one cluster collide. The cluster identity itself is not handled here --
    that is left to disambiguate_labels, which uses the real source cluster code."""
    coll = r["collection"]
    path = r["abs_path"]
    src = (lf or {}).get("shortLabel", "") or r["original_track_name"] or stem or ""
    lng_parts, sht_parts = [], []

    def add(lng, sht):
        lng_parts.append(lng)
        sht_parts.append(sht)

    # peak method (cortex-atac): different peak calls, not different cells. The method is
    # a filename suffix on some files (AstroOligo_MACSpeaks.bb) and the containing
    # directory on others (MACSpeaks/AstroOligo.bb) -- both layouts exist side by side in
    # the same dataset, and the two files are genuinely different peak sets.
    method = None
    for pat, lng, sht in PEAK_METHOD:
        suffix = pat.rstrip("$")
        if (re.search(r"[ _]" + pat, src, re.I)
                or re.search(r"[ _]" + pat, stem or "", re.I)
                or re.search(r"/%s/" % suffix, path, re.I)):
            method = (lng, sht)
            break
    if method:
        add(*method)
    elif dtype == "cCRE":
        # A candidate cis-regulatory element set is not a peak call, and saying "peaks"
        # for both made a cCRE track and a narrowPeak track of the same cell type read
        # identically -- across two different composites, where the per-composite
        # disambiguation cannot see them.
        add("cCREs", "cCRE")
    elif dtype == "peaks":
        # signal vs peaks for the same cell type. Signal is the majority and stays
        # unmarked, so the pair still differs by this one token.
        add("peaks", "pk")

    # histone mark: one cluster profiled with several marks. The mark is stripped from
    # the cell type as redundant with the Modality facet, which is right for the facet and
    # wrong for the label -- mouse-brain-cutandtag serves the same cluster under
    # h3k27ac/h3k27me3/h3k36me3/h3k4me3, and without the mark all four read alike.
    if modality and modality in HISTONE_MODALITIES:
        add(modality, modality)

    # grouping level: the same cells aggregated at different resolutions
    if "allen-brain-science" in path:
        for seg, (lng, sht) in ALLEN_GROUPING.items():
            if "/%s/" % seg in path:
                add(lng, sht)
                break
    if coll == "retina":
        for seg, (lng, sht) in RETINA_GROUPING.items():
            if "/%s/" % seg in path:
                add(lng, sht)
                break

    # cohort split: whole-dataset copy vs per-cohort copies of the same cell type
    for key, (lng, sht) in COLLECTION_COHORTS.get(coll, {}).items():
        if "/%s/" % key in path or re.match(r"(?i)^%s[_.]" % key, stem or ""):
            add(lng, sht)
            break

    return ", ".join(lng_parts), " ".join(sht_parts)


# Cruft on the source filenames that is not part of the cluster identity: the ArchR
# tile/normalization tail, peak-file suffixes, and the sorted-narrowPeak tail.
_CODE_CRUFT = [
    r"-TileSize-.*$", r"[-_]normMethod[-_].*$", r"[-_]ArchR$",
    r"\.sorted\.narrowPeak$", r"_peaks_bed$", r"_peaks$", r"\.peaks$", r"\.filtered$",
    r"\.interact$", r"\.inter$",   # bigInteract filename tails, not the cluster name
]

# Pipeline bookkeeping tokens inside a code -- assay, species, normalization, binning,
# processing batch. They repeat across every file in a dataset, so they crowd out the
# part that actually identifies the cluster (olg-eae-ms codes are otherwise all
# "PD003 atac HS Ctr", hiding the ASTRO / EXCNEU / INHNEU distinction).
_CODE_NOISE = {"atac", "rna", "hs", "mm", "roche", "rnd", "rnd1", "rnd2", "celltypes",
               "10xeae", "ripnorm", "insertions", "sorted", "narrowpeak", "bed", "none",
               "readsintss", "archr", "byceltype", "bycelltype", "allprimary", "signal",
               "cov", "coverage", "merged", "final"}
_CODE_NOISE_RE = re.compile(r"^(bin\d+|tilesize\d*|v\d+)$", re.I)


def source_cluster_code(bigdataurl, stem=""):
    """The source cluster code for a track, from its filename -- the identity the
    rollup discarded (MSGA1, ITL4GL1, DB3a, Fibro_Muscle, X1061_MSN_D1_outer). Used
    only to disambiguate labels that would otherwise be identical, so it is kept close
    to the source name: that is what the paper and the Cell Browser dataset call it."""
    base = stem or os.path.basename(bigdataurl)
    base = re.sub(r"\.(bw|bigwig|bb|bigbed)$", "", base, flags=re.I)
    for rx in _CODE_CRUFT:
        base = re.sub(rx, "", base, flags=re.I)
    return base.strip(" ._-")


def compact_code(code):
    """Readable short form of a source cluster code: separators to spaces and pipeline
    bookkeeping tokens dropped. Never strips the code down to nothing -- if every token
    looks like noise the original is kept, since something has to distinguish the
    track. The exact code stays in the longLabel; this is only for the shortLabel."""
    toks = [t for t in re.split(r"[_.\s-]+", code) if t]
    keep = [t for t in toks
            if t.lower() not in _CODE_NOISE and not _CODE_NOISE_RE.match(t)]
    out = " ".join(keep or toks).strip()
    return out[:1].upper() + out[1:] if out else out


# Compact shortLabel tokens for facets that are spelled out in the longLabel. Without
# these, SEA-AD shows eight identical "Astrocyte" tracks (two regions x four ADNC
# levels) and CATLAS aging shows the same cell type once per age.
SEAAD_REGION_ABBR = {"middle temporal gyrus": "MTG",
                     "dorsolateral prefrontal cortex": "PFC"}


def short_facet_tokens(r, cond_v, tissue_v, extra_lbl):
    """Extra shortLabel tokens for facet values that distinguish otherwise-identical
    tracks within a dataset: the SEA-AD region + ADNC level, and the CATLAS aging age."""
    toks = []
    if r["collection"] == "sea-ad-brain-atac":
        reg = SEAAD_REGION_ABBR.get((tissue_v or "").lower())
        if reg:
            toks.append(reg)
        m = re.search(r"ADNC\s*(\d)", cond_v or "")
        if m:
            toks.append("A" + m.group(1))
    if r["collection"] == "catlas-mouse-aging":
        m = re.match(r"(\d+) months", extra_lbl or "")
        if m:
            toks.append(m.group(1) + "mo")
    return " ".join(toks)


# Connectors that read as noise once the words they joined have been dropped as
# redundant with the cluster code ("Astrocytes and oligodendrocytes" + code AstroOligo
# left a stray "and enhPk AstroOligo").
_JOINERS = {"and", "or", "of", "the", "in", "with", "&", "-", "+", "/"}

_SHORTLABEL_RE = re.compile(r"^shortLabel (.*)$", re.M)
_LONGLABEL_RE = re.compile(r"^longLabel (.*)$", re.M)
_BDU_RE = re.compile(r"^bigDataUrl (.*)$", re.M)


def disambiguate_labels(children, meta_rows):
    """Make every subtrack label in one composite unique, in place.

    The cell-type facets are rollups on purpose, so many subtracks legitimately share a
    harmonized cell type -- CATLAS mouse brain alone rolls MSGA1..MSGA13 into one
    "Medial septum GABAergic neuron", and ITL4GL1/ITL5GL2 into one "Cortical IT
    excitatory neuron" even though those encode different cortical layers. That is right
    for a facet but wrong for a label: the user sees a dozen identical track names and
    cannot tell which is which. Any label still shared after the variant descriptors is
    qualified with its source cluster code, which is both unique and what the source
    paper calls the cluster. Returns the number of subtracks qualified.

    `children` (stanza strings) and `meta_rows` are parallel, appended together per
    track, so index i refers to the same subtrack in both.
    """
    groups = defaultdict(list)
    for i, stanza in enumerate(children):
        m = _LONGLABEL_RE.search(stanza)
        groups[m.group(1) if m else ""].append(i)
    fixed = 0
    for label, idxs in groups.items():
        if len(idxs) < 2:
            continue
        # The cluster code alone is not always enough: the same cluster file name can
        # appear under several directories, e.g. one cluster profiled with different
        # histone marks (brain-spatial-omics h3k27ac/ vs h3k4me3/). Where the codes
        # repeat, add the directory segment that actually differs across the group, so
        # this function really does guarantee unique labels rather than merely usually.
        paths = {}
        for i in idxs:
            bdu = _BDU_RE.search(children[i])
            paths[i] = urlparse(bdu.group(1)).path if bdu else ""
        codes = {i: source_cluster_code(paths[i]) for i in idxs}
        extra = {i: "" for i in idxs}
        if len(set(codes.values())) < len(idxs):
            segs = {i: [s for s in paths[i].split("/")[:-1] if s] for i in idxs}
            depth = min((len(v) for v in segs.values()), default=0)
            for d in range(depth - 1, -1, -1):          # deepest differing dir first
                vals = {i: segs[i][d] for i in idxs}
                if len(set(vals.values())) > 1:
                    extra = vals
                    break
        for i in idxs:
            stanza = children[i]
            code = " ".join(x for x in (codes[i], extra[i]) if x)
            if not code:
                continue
            # longLabel: insert the code before the trailing "(dataset)"
            def _long(mo, code=code):
                text = mo.group(1)
                m2 = re.match(r"^(.*?)(\s*\([^()]*\))$", text)
                if m2:
                    return "longLabel %s (%s)%s" % (m2.group(1), code, m2.group(2))
                return "longLabel %s (%s)" % (text, code)
            stanza = _LONGLABEL_RE.sub(_long, stanza, count=1)
            # shortLabel: the code is the distinguishing part, so it gets the budget
            # first and the cell-type prefix takes whatever room is left. The exact code
            # stays in the longLabel; here it is prettified (underscores and dots to
            # spaces) since the raw form is what made the old labels look unfinished.
            def _short(mo, code=code):
                cur = mo.group(1)
                pretty = compact_code(code)
                if len(pretty) >= SHORT_BUDGET:
                    return "shortLabel " + (_fit(pretty, SHORT_BUDGET)
                                            or pretty[:SHORT_BUDGET])
                # Drop only the words the code already says ('Astrocytes AstroOligo',
                # 'Endo endothelial cells') and keep the rest. Dropping the whole prefix
                # also threw away the variant token, which is what tells the four Allen
                # grouping levels of one cluster apart -- they all rendered as an
                # identical "X3934 Astro 1" in the left label area.
                ctoks = [t.lower() for t in pretty.split()]
                def _dup(w):
                    return any(w.startswith(t[:4]) or t.startswith(w[:4]) for t in ctoks)
                # only strip a joiner written in lower case -- "IN" is Inhibitory Neuron in
                # cortex-atac (IN_CGE, IN_MGE), not the preposition
                keep = " ".join(w for w in cur.split()
                                if not _dup(w.lower())
                                and not (w.islower() and w in _JOINERS))
                room = SHORT_BUDGET - len(pretty) - 1
                head = _fit(keep, room) if (keep and room >= 2) else ""
                return "shortLabel " + (("%s %s" % (head, pretty)).strip()
                                        if head else pretty)
            stanza = _SHORTLABEL_RE.sub(_short, stanza, count=1)
            children[i] = stanza
            if i < len(meta_rows):
                m3 = _LONGLABEL_RE.search(stanza)
                if m3:
                    meta_rows[i]["_Name"] = m3.group(1)
            fixed += 1
    return fixed


def allen_duplicate_skip(rows):
    """Track_urls of the redundant allen-brain-science copies to leave out of the hub.

    The basal-ganglia dataset serves each unchanged per-cluster bigWig from all four
    grouping directories. For 14 basenames those four copies are byte-identical
    (md5-verified), so they would render as four indistinguishable subtracks and cost
    4.4 GB of duplicated storage. Keep the bg_regrouping_cl copy -- that is the
    cluster-level source the merges are built from -- and skip the rest. Where the four
    copies genuinely differ (different aggregations, different file sizes) all four are
    kept and told apart by ALLEN_GROUPING. Identity is decided on basename + byte size:
    these come from one ArchR run, so an equal size for an equal name is conclusive.
    """
    groups = defaultdict(list)
    for r in rows:
        p = r["abs_path"]
        if "allen-brain-science" not in p:
            continue
        try:
            size = os.path.getsize(p)
        except OSError:
            continue
        groups[(os.path.basename(p), size)].append(r)
    skip = set()
    for (_name, _size), rs in groups.items():
        if len(rs) < 2:
            continue
        keep = next((x for x in rs if "/bg_regrouping_cl/" in x["abs_path"]), None)
        if keep is None:                      # no canonical dir -> keep a stable one
            keep = sorted(rs, key=lambda x: x["abs_path"])[0]
        for x in rs:
            if x is not keep:
                skip.add(x["track_url"])
    return skip


##############################################################################
# shortLabel
##############################################################################
# Curated word-level abbreviations for building a shortLabel out of the harmonized cell
# type. Applied longest-phrase-first. Only used when the full label does not fit -- a
# cell type that already fits is left spelled out.
CT_ABBREV_RAW = [
    ("committed oligodendrocyte precursor", "COP"),
    ("oligodendrocyte precursor", "OPC"),
    ("medium spiny neuron", "MSN"),
    ("GABAergic interneuron", "GABA int"),
    ("GABAergic neuron", "GABA neu"),
    ("glutamatergic neuron", "glut neu"),
    ("dopaminergic neuron", "dopa neu"),
    ("excitatory neuron", "exc neu"),
    ("inhibitory neuron", "inh neu"),
    ("intratelencephalic", "IT"),
    ("subventricular zone", "SVZ"),
    ("radial glia-like", "RGL"),
    ("near-projecting", "NP"),
    ("corticothalamic", "CT"),
    ("pyramidal tract", "PT"),
    ("pyramidal-tract", "PT"),
    ("myelin-forming", "MF"),
    ("newly formed", "NF"),
    ("dentate gyrus", "DG"),
    ("choroid plexus", "ChP"),
    ("cerebral nuclei", "CNU"),
    ("olfactory bulb", "OB"),
    ("lateral septum", "LS"),
    ("medial septum", "MS"),
    ("piriform cortex", "PIR"),
    ("collecting duct", "CD"),
    ("convoluted tubule", "conv tub"),
    ("proximal tubule", "PT"),
    ("connecting tubule", "CNT"),
    ("loop of Henle", "LOH"),
    ("small intestinal", "SI"),
    ("transitional zone", "TZ"),
    ("zona fasciculata", "ZF"),
    ("zona glomerulosa", "ZG"),
    ("peripheral nerve", "periph nerve"),
    ("mesenchymal stem", "MSC"),
    ("muscle satellite", "musc sat"),
    ("smooth muscle", "SM"),
    ("muller glia", "Muller"),
    ("Cajal-Retzius", "CR"),
    ("leptomeningeal", "leptomen"),
    ("perivascular", "perivasc"),
    ("neuroendocrine", "neuroend"),
    ("hematopoietic", "hemato"),
    ("oligodendrocyte", "oligo"),
    ("proliferating", "prolif"),
    ("intermediate", "interm"),
    ("somatostatin", "Sst"),
    ("parvalbumin", "Pvalb"),
    ("photoreceptor", "photorec"),
    ("ensheathing", "ensheath"),
    ("hippocampal", "hipp"),
    ("endothelial", "endo"),
    ("epithelial", "epi"),
    ("mesenchymal", "mesen"),
    ("cardiomyocyte", "CM"),
    ("trophoblast", "troph"),
    ("extravillous", "EV"),
    ("progenitor", "prog"),
    ("precursor", "prec"),
    ("fibroblast", "fibro"),
    ("macrophage", "mac"),
    ("astrocyte", "astro"),
    ("interneuron", "int"),
    ("neuroblast", "neurobl"),
    ("chromaffin", "chromaff"),
    ("sympathoblast", "symphbl"),
    ("ventricular", "vent"),
    ("myonuclei", "myonuc"),
    ("follicular", "follic"),
    ("subiculum", "SUB"),
    ("entorhinal", "ENT"),
    ("claustrum", "CLA"),
    ("pancreatic", "panc"),
    ("epidermal", "epid"),
    ("capillary", "cap"),
    ("lymphatic", "lymph"),
    ("placental", "plac"),
    ("pulmonary", "pulm"),
    ("ependymal", "ependym"),
    ("myofiber", "myofib"),
    ("skeletal", "skel"),
    ("pyramidal", "pyr"),
    ("cortical", "ctx"),
    ("thalamic", "thal"),
    ("pallidal", "pall"),
    ("striatal", "striat"),
    ("vascular", "vasc"),
    ("arterial", "art"),
    ("nephron", "nephr"),
    ("granule", "gran"),
    ("granular", "gran"),
    ("myocyte", "myo"),
    ("junction", "junc"),
    ("satellite", "sat"),
    ("retinal", "ret"),
    ("neuronal", "neu"),
    ("olfactory", "olf"),
    ("adrenal", "adr"),
    ("thyroid", "thyr"),
    ("gastric", "gastr"),
    ("hepatic", "hep"),
    ("stromal", "strom"),
    ("ciliated", "cil"),
    ("cardiac", "card"),
    ("atrial", "atr"),
    ("venous", "ven"),
    ("muscle", "musc"),
    ("neuron", "neu"),
    ("fetal", "ftl"),
    ("glial", "glia"),
    ("stem cell", "SC"),
]
# Longest phrase first so 'oligodendrocyte precursor' wins over 'oligodendrocyte'. The
# optional trailing 's' matters: the table is written singular, so without it a plural
# cell type never abbreviated and fell through to blunt truncation instead
# ('Astrocytes and oligodendrocytes' -> 'Astrocytes and').
CT_ABBREV = [(re.compile(r"\b" + re.escape(p) + r"s?\b", re.I), v)
             for p, v in sorted(CT_ABBREV_RAW, key=lambda x: -len(x[0]))]

SHORT_BUDGET = 22    # chars. Not a hard limit in the tree (hg38's trackDb runs a
                     # median of 18 and 54% of tracks exceed the classic 17), but the
                     # left label area gets crowded past this, and it leaves room for
                     # the variant token.


def _fit(text, budget):
    """Trim to budget on a word boundary, without leaving a dangling separator or a
    trailing connector ('Astrocytes and oligodendrocytes' must not become
    'Astrocytes and')."""
    if len(text) <= budget:
        return text
    cut = text[:budget]
    if " " in cut:
        cut = cut[:cut.rfind(" ")]
    cut = cut.rstrip(" ,;-/")
    while True:
        toks = cut.split()
        if len(toks) > 1 and toks[-1].islower() and toks[-1] in _JOINERS:
            cut = " ".join(toks[:-1]).rstrip(" ,;-/")
        else:
            return cut


def build_short_label(celltype, variant_short, fallback):
    """shortLabel from the harmonized cell type plus the variant token, fitted to
    SHORT_BUDGET. Spelled out when it fits; abbreviated via CT_ABBREV when it does not;
    parenthetical qualifiers are unwrapped rather than dropped (they distinguish
    'D1 MSN (dorsal)' from 'D1 MSN (ventral)'). Falls back to the source label when the
    track has no usable cell type."""
    base = (celltype or fallback or "").strip()
    if not base:
        return ""
    sfx = (" " + variant_short) if variant_short else ""
    room = SHORT_BUDGET - len(sfx)

    def ok(s):
        return s and len(s) <= room

    # 1. as-is
    if ok(base):
        return base + sfx
    # 2. unwrap the parenthetical qualifier ('D1 MSN (dorsal)' -> 'D1 MSN dorsal')
    unwrapped = re.sub(r"\s*\(([^)]*)\)", r" \1", base).strip()
    unwrapped = re.sub(r"\s+", " ", unwrapped)
    if ok(unwrapped):
        return unwrapped + sfx
    # 3. abbreviate
    ab = unwrapped
    for pat, repl in CT_ABBREV:
        if len(ab) <= room:
            break
        ab = pat.sub(repl, ab)
    ab = re.sub(r"\s+", " ", ab).strip()
    # the abbreviation table is written in lower case, so restore the leading capital
    ab = ab[:1].upper() + ab[1:] if ab else ab
    if ok(ab):
        return ab + sfx
    # 4. still too long -> trim on a word boundary
    return (_fit(ab, room) or ab[:room]) + sfx

def raw_celltype(r, lf):
    """cellType for a track after cleaning + acronym expansion + collapse A/B (before
    the global C merge). '' when no usable label; aggregate tracks -> 'all clusters'."""
    stem = re.sub(r"\.(bw|bigwig|bb|bigbed)$", "", os.path.basename(r["abs_path"]),
                  flags=re.I)
    long_ = (lf or {}).get("longLabel", "")
    if CELLTYPE_IGNORE_RE and CELLTYPE_IGNORE_RE.search(long_):
        return ""                              # not a per-cell-type track (e.g. age/region)
    short = (lf or {}).get("shortLabel", "") or r["original_track_name"] or stem
    ct = clean_celltype(short, long_, (lf or {}).get("composite", ""))
    if ct and ct.lower() in SPECIES_WORDS:     # species leaked in ('AC Peaks - Both')
        toks = (long_ or short or stem or "").split()   # leading cell-class acronym (AC)
        if toks:
            ct = toks[0]
    if ct and CELLTYPE_LEAD_RE:                # drop leading assay/mark token (H3K27ac EXC1)
        ct = CELLTYPE_LEAD_RE.sub("", ct).strip() or ct
    if ct and CELLTYPE_TRAIL_RE:               # drop trailing ' unsure' confidence marker
        ct = CELLTYPE_TRAIL_RE.sub("", ct).strip() or ct
    if ct:
        if LIFESTAGE_PREFIX_RE:                             # drop leading Fetal/Adult/...
            ct = LIFESTAGE_PREFIX_RE.sub("", ct).strip() or ct
        ct = collapse_celltype(ct)          # strip tilesize/trailing-number BEFORE expansion
        expanded = expand_acronym_from_label(ct, long_)     # from the label
        if expanded != ct:
            ct = expanded
        else:                                               # paper-sourced (CFG)
            ct = CELLTYPE_EXPANSIONS.get(r["collection"], {}).get(ct.lower(), ct)
        ct = CELLTYPE_EXPANSIONS_GLOBAL.get(ct.lower(), ct)  # universal acronyms/variants
        # condition strip runs AFTER expansion (the 'CODE - desc' label expands post-collapse,
        # so the condition is a leading word of the expansion, e.g. 'Control mature oligo... 2')
        ct = strip_condition(r["collection"], ct)
        ct = CELLTYPE_EXPANSIONS.get(r["collection"], {}).get(ct.lower(), ct)  # e.g. COP->...
        ct = CELLTYPE_EXPANSIONS_GLOBAL.get(ct.lower(), ct)
        ct = normalize_celltype(ct)          # drop 'cell(s)' (protected) + sentence case
    if not ct and (r["track_type"] == "bigBarChart" or AGG_NAME_RE.match(stem)):
        ct = AGG_LABEL
    return ct


def served_base(track_url, bdu_rel):
    """The served hub-dir URL: track_url with its bigDataUrl suffix removed."""
    if bdu_rel and track_url.endswith(bdu_rel):
        return track_url[: -len(bdu_rel)].rstrip("/")
    return track_url.rsplit("/", 1)[0]


import glob as _glob
_tissue_cache = {}

def tissue_of(collection):
    """Primary tissue/organ for a collection, from cellbrowser.conf body_parts
    (a list). Commented (#body_parts) and the placeholder ['all'] -> 'unknown'.
    Dataset-level, so every track in the collection shares it."""
    if collection in _tissue_cache:
        return _tissue_cache[collection]
    val = "unknown"
    root = os.path.join(bm.DATASETS, collection)
    confs = [os.path.join(root, "cellbrowser.conf")] + \
        sorted(_glob.glob(os.path.join(root, "*", "cellbrowser.conf")))
    for conf in confs:
        if not os.path.isfile(conf):
            continue
        for line in open(conf, encoding="utf-8", errors="replace"):
            s = line.strip()
            if s.startswith("#"):
                continue
            # match both the bare `body_parts = [...]` form and the quoted/colon
            # dict form `"body_parts" : [...]` some confs use (e.g. cortex-dev).
            m = re.match(r'["\']?body_parts?["\']?\s*[:=]\s*\[(.*?)\]', s)
            if m:
                raw = [p.strip().strip("'\"") for p in m.group(1).split(",")]
                raw = [p for p in raw if p]
                specific = [p for p in raw if p.lower() != "all"]
                if specific:
                    val = specific[0]           # broadest specific organ
                    break
                if raw:                          # only 'all' -> spans many tissues
                    val = "multiple"
                    break
        if val != "unknown":
            break
    _tissue_cache[collection] = val
    return val


TISSUE_FROM_PATH = CFG.get("tissue_from_path", {})

def track_tissue(row):
    """Per-track tissue. For collections organized by tissue in the path
    (TISSUE_FROM_PATH: e.g. fetal-chromatin-atlas/.../bigWigs/<tissue>/<file>), use the
    path segment after the marker dir. Otherwise the collection-level body_parts tissue."""
    coll = row["collection"]
    marker = TISSUE_FROM_PATH.get(coll)
    if marker:
        segs = row["abs_path"].split("/")
        if marker in segs:
            i = segs.index(marker)
            if i + 1 < len(segs) - 1:      # segs[i+1] is a dir, not the filename
                return segs[i + 1]
    return tissue_of(coll)


# peak-like bigBed labels/names that are really peak calls stored as plain bigBed
PEAKISH_RE = re.compile(r"peak|enhancerprediction", re.I)

# bigWig tracks that aren't per-cell-type signal -> their own composite (out of the facets)
SEPARATE_SIGNAL = [(re.compile(c["match_regex"], re.I), c)
                   for c in CFG.get("separate_signal_composites", [])]
SEPARATE_SIGNAL_BY_SUFFIX = {c["suffix"]: c for _, c in SEPARATE_SIGNAL}

def match_separate_signal(short, long_, stem):
    """Return the separate-composite config for a track whose label/name matches one
    of the SEPARATE_SIGNAL rules, else None."""
    hay = "%s %s %s" % (short, long_, stem)
    for rx, cfg in SEPARATE_SIGNAL:
        if rx.search(hay):
            return cfg
    return None


def annotation_type(label):
    """Group genuine (non-peak) bigBed annotations by kind, so they go into their
    own composite. Returns (title, short-suffix-for-track-names)."""
    l = label.lower()
    if "junction" in l:
        return ("Splice junctions", "Sj")
    if "lncrna" in l or "gene" in l or "transcript" in l:
        return ("Gene annotations", "Gene")
    return ("Annotations", "Ann")


ID_NOISE_SUBS = set(CFG.get("id_noise_subcollections", []))
ID_STRIP_RES = [re.compile(p) for p in CFG.get("id_strip_suffix_regexes", [])]


def shorten_id(master_track_name):
    """Make the primaryKey id more readable: drop generic container subcollection
    segments (hub, all, ...) and strip verbose pipeline suffixes (ArchR tilesize,
    ...). Format in is <coll>__<sub|x>__<name>. Uniqueness is re-established by
    fit_id() (it de-dupes collisions caused by shortening)."""
    segs = master_track_name.split("__")
    if len(segs) >= 3:
        coll, sub, name = segs[0], segs[1], "__".join(segs[2:])
        for rx in ID_STRIP_RES:
            name = rx.sub("", name)
        name = name.strip("_") or "x"
        keep = [coll] + ([sub] if sub not in ID_NOISE_SUBS and sub != "x" else []) + [name]
        return "__".join(keep)
    return master_track_name


def fit_id(composite, idval, used):
    """Ensure composite_<id> <= 128 chars and unique. Returns the id to use."""
    prefix = composite + "_"
    maxid = MAX_TRACKNAME - len(prefix)
    base = idval if len(idval) <= maxid else \
        idval[: maxid - 7] + "_" + hashlib.md5(idval.encode()).hexdigest()[:6]
    cand = base
    n = 2
    while cand in used:
        suffix = "_%d" % n
        cand = (base[: maxid - len(suffix)] + suffix) if len(base) + len(suffix) > maxid \
            else base + suffix
        n += 1
    used.add(cand)
    return cand


def resolve_assembly_bw(path):
    """Assembly from a bigWig's chr1 size (for the hub-less UNKNOWNs)."""
    try:
        out = subprocess.run([BIGWIGINFO, "-chroms", path],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return None
    for line in out.splitlines():
        p = line.split()
        if len(p) >= 3 and p[0] == "chr1":
            return CHR1_SIZE.get(int(p[2]))
    return None


def bigwig_minmax(path):
    """'<min> <max>' from bigWigInfo, for a generated `type bigWig` line."""
    try:
        out = subprocess.run([BIGWIGINFO, path],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return None
    mn = re.search(r"min:\s*([-\d.eE]+)", out)
    mx = re.search(r"max:\s*([-\d.eE]+)", out)
    if mn and mx:
        return "%s %s" % (mn.group(1), mx.group(1))
    return None


def load_manifest():
    with open(MANIFEST) as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def load_curated_refs():
    """realpath -> richest curated leaf, from non-WIP hubs (reuse Phase 1 parser)."""
    with open(CACHE, "rb") as fh:
        hubs, _walked = pickle.load(fh)
    ref = {}
    warnings = []
    for hubtxt in hubs:
        if bm.is_wip(hubtxt):
            continue
        try:
            leaves, _decoy = bm.parse_hub(hubtxt)
        except Exception as e:
            warnings.append("%s: %s" % (hubtxt, e))
            continue
        for lf in leaves:
            ref.setdefault(os.path.realpath(lf["abs"]), lf)
    return ref, warnings


def track_labels(row, lf):
    """(shortLabel, longLabel) for a track. The source dataset's short label is
    appended to the longLabel so cross-dataset name collisions (e.g. two
    'Cluster expression', many 'Astrocyte') disambiguate and the source dataset
    is visible on the track itself."""
    stem = re.sub(r"\.(bw|bigwig|bb|bigbed)$", "", os.path.basename(row["abs_path"]),
                  flags=re.I)
    short = (lf or {}).get("shortLabel", "") or row["original_track_name"] or stem
    long_ = (lf or {}).get("longLabel", "") or short or stem
    ds = bm.dataset_label(row["collection"])
    if ds and ds.lower() not in long_.lower():
        long_ = "%s (%s)" % (long_, ds)
    return short, long_


def render_child(child_name, composite, row, lf, color=None, long_override=None,
                 short_override=None, default_off=False):
    """Build the faceted child stanza. Curated tracks (lf set) copy their curated
    settings verbatim; orphan/hub-less tracks (lf None) get a generated stanza
    (bigWigInfo min/max + pragmatic defaults). shortLabel/longLabel are set from
    track_labels() (longLabel carries the source dataset), not copied verbatim; the
    faceted cell-type tracks pass both labels in as overrides built from the harmonized
    facets (see build_short_label / build_long_label)."""
    # "off" leaves the subtrack unchecked, so showing a faceted composite does not turn on
    # every child at once (925 for hg38); the user selects tracks in the faceted selector.
    # composite=None emits a top-level track with no parent line (the bar charts, which
    # used to hang off the per-assembly superTrack).
    lines = ["track " + child_name]
    if composite:
        lines.append("parent " + composite + (" off" if default_off else ""))
    stanza = (lf or {}).get("stanza", {})
    # rewrite the served host (e.g. cells.ucsc.edu -> cells-test) for staging
    track_url = row["track_url"]
    if track_url.startswith(SOURCE_BASE):
        track_url = TARGET_BASE + track_url[len(SOURCE_BASE):]
    base = served_base(track_url, stanza.get("bigDataUrl", ""))
    stem = re.sub(r"\.(bw|bigwig|bb|bigbed)$", "", os.path.basename(row["abs_path"]),
                  flags=re.I)
    label = row["original_track_name"] or stem

    emitted = set(["track", "parent"])
    type_full = (lf or {}).get("type_full") or row["track_type"]
    # A bigWig whose `type` line carries no data range leaves hgTracks with no default
    # viewLimits, so it draws against the built-in 0:127. BrainVar's gene-activity tiles
    # top out near 6 and rendered as a flat line that way. Fill the range in from
    # bigWigInfo. This bites curated tracks too, not just orphans: a source hub commonly
    # sets autoScale on the COMPOSITE PARENT, and this build flattens every subtrack into
    # one native composite without copying the parent, so the child arrives with no
    # scaling at all (232 subtracks corpus-wide have no range, no autoScale and no
    # viewLimits). Only the default is supplied -- an explicit viewLimits still wins.
    if type_full == "bigWig":
        mm = bigwig_minmax(row["abs_path"])
        if mm:
            type_full = "bigWig " + mm
    lines.append("type " + type_full)
    lines.append("bigDataUrl " + track_url)
    emitted.update(["type", "bigdataurl"])

    if lf:
        # copy remaining curated keys verbatim (absolutizing URL-valued ones).
        # shortLabel/longLabel are NOT copied -- we set them from track_labels().
        for k, v in stanza.items():
            kl = k.lower()
            if (kl in DROP_KEYS or kl in emitted or k.startswith("_")
                    or kl in ("shortlabel", "longlabel")
                    or (kl == "color" and color)):   # crosswalk color overrides the source color
                continue
            if kl in URL_KEYS and v and not re.match(r"https?://", v):
                v = base + "/" + v.lstrip("./")
            lines.append("%s %s" % (k, v))
            emitted.add(kl)
        # Give a curated bigWig the same height default the generated path uses when its
        # stanza sets none. Scaling is NOT set here -- it is inherited from the parent
        # composite's `autoScale group` (see DROP_KEYS).
        if row["track_type"] == "bigWig" and "maxheightpixels" not in emitted:
            lines.append("maxHeightPixels 100:30:8")
            emitted.add("maxheightpixels")
    else:
        # generated defaults for orphan / hub-less tracks
        if row["track_type"] == "bigWig":
            lines += ["maxHeightPixels 100:30:8"]   # scaling comes from the parent
            emitted.add("maxheightpixels")

    if color and "color" not in emitted:
        lines.append("color " + color)
        emitted.add("color")

    short, long_ = track_labels(row, lf)
    lines.append("shortLabel " + (short_override or short)[:50])
    lines.append("longLabel " + (long_override or long_))
    return "\n".join(lines)


def main():
    os.makedirs(STANZADIR, exist_ok=True)
    os.makedirs(METADIR, exist_ok=True)
    rows = load_manifest()
    ref, warnings = load_curated_refs()

    # Classify every included track. Curated = in a hub stanza; orphan = on disk but
    # not in any hub. Drop .introns.bb orphans (intermediates; the hubs publish the
    # matching .junctions.bb instead). Resolve UNKNOWN assemblies (hub-less bigWigs).
    dropped_introns = []
    unresolved = []
    by_asm = defaultdict(list)
    for r in rows:
        if r["excluded"] != "0":
            continue
        is_orphan = not r["existing_hub_path"]
        base = os.path.basename(r["abs_path"])
        if is_orphan and any(rx.search(base) for rx in ORPHAN_DROP_RES):
            dropped_introns.append(r["abs_path"])
            continue
        asm = r["assembly"]
        if asm in ("UNKNOWN", ""):
            asm = resolve_assembly_bw(r["abs_path"]) if r["track_type"] == "bigWig" else None
            if not asm:
                unresolved.append("%s\t%s" % (r["assembly"], r["abs_path"]))
                continue
        r["_orphan"] = is_orphan
        by_asm[asm].append(r)

    collisions = []
    qc_dropped = []
    unpublished = []
    allen_dupes = []
    orphan_ann = []                                    # annotation bigBeds with no stanza
    label_qualified = defaultdict(int)                # asm -> subtracks given a code
    unclassed = Counter()                             # celltype -> tracks with no class
    coverage = defaultdict(lambda: defaultdict(int))  # asm -> facet -> known count

    # byte-identical allen-brain-science copies served from several grouping dirs
    allen_skip = allen_duplicate_skip([r for rs in by_asm.values() for r in rs])

    # header names: "Cell_type" -> "Cell type" (toTitleStyle only turns _ into space).
    # "_Cell_type": the leading underscore drops the (159-value) cell-type facet but
    # keeps it as a searchable table column; the compact "Cell_class" facet is the
    # primary cell facet instead.
    meta_cols = ["_Name", "Dataset", "Cell_class", "_Cell_type", "Tissue", "Data_type",
                 "Modality", "Life_stage", "Condition", "Track"]

    # Collapse C (plural/case): build a global canonical map over all cellType values
    # (after A/B), mapping each variant to the most-frequent form in its group. Full
    # labels remain in the Name column; this only tidies the Cell type facet.
    _key_forms = defaultdict(Counter)
    for rows_ in by_asm.values():
        for r in rows_:
            base = raw_celltype(r, curated_ref(ref, r))
            if base:
                _key_forms[celltype_normkey(base)][base] += 1
    celltype_canon = {}
    celltype_merges = []
    for k, forms in _key_forms.items():
        if len(forms) > 1:
            # Prefer the singular form, then the most frequent. Frequency alone made the
            # facet inconsistent: it picked the singular for 15 of 17 merged groups but
            # the plural for Megakaryocytes/Oligodendrocytes, purely because the plural
            # happened to be more common there.
            canon = sorted(forms,
                           key=lambda f: (f.lower().endswith("s"), -forms[f], f))[0]
            for f in forms:
                if f != canon:
                    celltype_canon[f] = canon
            celltype_merges.append("%s\t<- %s" % (
                canon, ", ".join(f for f in forms if f != canon)))

    for asm in sorted(by_asm):
        comp = composite_name(asm)        # faceted composite (signal + peaks)
        used = set()
        faceted_children = []
        meta_rows = []
        histone_children = []             # histone marks -> own faceted composite
        histone_meta_rows = []
        ccre_children = []                # cCRE bigBeds -> own faceted composite
        ccre_meta_rows = []
        interact_children = []            # bigInteract -> one composite
        barchart_tracks = []              # bigBarChart -> standalone tracks
        ann_buckets = OrderedDict()       # annotation type -> (suffix, [child stanzas])
        sep_buckets = OrderedDict()       # separate non-cell-type signal -> [children]
        sepcoll_buckets = OrderedDict()   # whole split-out collection -> [children]
        expr_children = []                # RNA expression coverage -> own composite
        # composite/track name -> set of source collections, so a track fed by exactly
        # one dataset can name it in its labels (dataset_scoped_labels)
        comp_colls = defaultdict(set)
        for r in sorted(by_asm[asm], key=lambda x: (x["collection"], x["master_track_name"])):
            if r["track_url"] in allen_skip:   # redundant byte-identical allen copy
                allen_dupes.append("%s\t%s" % (asm, r["abs_path"]))
                continue
            lf = curated_ref(ref, r)
            idbase = shorten_id(r["master_track_name"])
            ttype = r["track_type"]
            stem = re.sub(r"\.(bw|bigwig|bb|bigbed)$", "",
                          os.path.basename(r["abs_path"]), flags=re.I)
            short = (lf or {}).get("shortLabel", "") or r["original_track_name"] or stem
            long_ = (lf or {}).get("longLabel", "")
            srccomp = (lf or {}).get("composite", "")
            dtype = DATATYPE.get(ttype, ttype)
            # bigBeds: cCREs get their own composite; otherwise peak-like labels are peaks
            if ttype == "bigBed":
                _blob = "%s %s %s" % (short, long_, stem)
                if CCRE_COMPOSITE and CCRE_RE.search(_blob):
                    dtype = "cCRE"
                elif PEAKISH_RE.search(_blob):
                    dtype = "peaks"
            if r["is_htdocs_copy"] != "served":
                unpublished.append("%s\t%s\t%s" % (asm, r["track_url"], r["abs_path"]))

            # route each track to its section
            # whole-collection split-outs (bulk / sample / cluster, not per-cell-type)
            sepcoll = SEPARATE_COLLECTIONS.get(r["collection"])
            if sepcoll:
                sfx = sepcoll["suffix"]
                idval = fit_id(comp + sfx, idbase, used)
                # The source label here is the bare ArchR output filename
                # ("C10-TileSize-100-normMethod-ReadsInTSS-ArchR"), so strip that tail and
                # say what the track is. These clusters have no published cell-type name,
                # so the cluster code is the identity; the histone mark distinguishes the
                # copies of one cluster profiled with different marks.
                _code = compact_code(source_cluster_code("", stem))
                _mod = modality_of(r["collection"], r["subcollection"], srccomp,
                                   r["abs_path"], short, long_, stem, r["collection"])
                _mark = _mod if _mod in HISTONE_MODALITIES else ""
                _ds = bm.dataset_label(r["collection"])
                _slong = _sshort = None
                if _code:
                    _slong = "Cluster %s%s%s" % (
                        _code, ", " + _mark if _mark else "",
                        " (%s)" % _ds if _ds else "")
                    _sshort = _fit(("%s %s" % (_code, _mark)).strip(), SHORT_BUDGET)
                sepcoll_buckets.setdefault(r["collection"], []).append(
                    render_child(comp + sfx + "_" + idval, comp + sfx, r, lf,
                                 long_override=_slong, short_override=_sshort))
                comp_colls[comp + sfx].add(r["collection"])
                continue
            if ttype == "bigBarChart":
                idval = fit_id(comp + "Bar", idbase, used)
                _bn = comp + "Bar_" + idval
                _bs, _bl = dataset_scoped_labels(
                    "Bar", "Cell Browser expression",
                    track_labels(r, lf)[1], {r["collection"]})
                barchart_tracks.append(
                    render_child(_bn, None, r, lf, short_override=_bs,
                                 long_override=_bl) + "\nhtml %s.html" % _bn)
                comp_colls[_bn].add(r["collection"])
                continue
            if ttype == "bigInteract":
                idval = fit_id(comp + "Interact", idbase, used)
                # These carried the raw filename as both labels ("AstroOligo_AllEnhancer
                # Predictions"), which is where nearly every remaining underscore came
                # from. Build them from the same harmonized cell type the faceted
                # composite uses, plus the prediction method when the filename names one.
                _ict, _, _, _ = harmonize_celltype(r, lf, celltype_canon)
                _imeth = _imeth_short = ""
                for _pat, _lng, _sht in PEAK_METHOD:
                    _sfxp = _pat.rstrip("$")
                    if re.search(r"[ _]" + _pat, stem or "", re.I) or \
                       re.search(r"/%s/" % _sfxp, r["abs_path"], re.I):
                        _imeth, _imeth_short = _lng, _sht
                        break
                _ilong = _ishort = None
                if _ict:
                    _ds = bm.dataset_label(r["collection"])
                    _ilong = "Predicted interactions, %s%s%s" % (
                        _ict[0].lower() + _ict[1:],
                        ", " + _imeth if _imeth else "",
                        " (%s)" % _ds if _ds else "")
                    _ishort = build_short_label(
                        _ict, _imeth_short or "int", track_labels(r, lf)[0])
                interact_children.append(
                    render_child(comp + "Interact_" + idval, comp + "Interact", r, lf,
                                 long_override=_ilong, short_override=_ishort))
                comp_colls[comp + "Interact"].add(r["collection"])
                continue
            if ttype == "bigBed" and dtype == "annotation":   # genuine annotation
                # An annotation bigBed with no hub stanza is dropped. Everything about
                # these tracks is a guess from the filename -- which composite they belong
                # in, and their label -- because there is no curated stanza to read, so
                # there is no way to write an accurate description for them. The one this
                # rule removes today, mouse-epi-juv-brain/h3k27me3/
                # GeneCaRNA_lncRNA_genes.bb, was a stray empty bigBed (0 items) left in a
                # Cell Browser dataset build directory, surfacing as a track labelled
                # "GeneCaRNA_lncRNA_genes". Curated annotations are unaffected: every
                # other one, including all 41 cortex-dev splice-junction tracks and the
                # 20 miRNA tracks, is hub-backed.
                if r.get("_orphan"):
                    orphan_ann.append("%s\t%s" % (asm, r["abs_path"]))
                    continue
                title, sfx = annotation_type("%s %s" % (short, long_))
                bucket = ann_buckets.setdefault(title, (sfx, []))
                idval = fit_id(comp + sfx, idbase, used)
                bucket[1].append(render_child(comp + sfx + "_" + idval,
                                              comp + sfx, r, lf))
                comp_colls[comp + sfx].add(r["collection"])
                continue
            sep = match_separate_signal(short, long_, stem)   # not cell-type signal
            if sep:                                           # (e.g. miRNA by age/region)
                sfx = sep["suffix"]
                idval = fit_id(comp + sfx, idbase, used)
                sep_buckets.setdefault(sfx, []).append(
                    render_child(comp + sfx + "_" + idval, comp + sfx, r, lf))
                comp_colls[comp + sfx].add(r["collection"])
                continue

            modality = modality_of(r["collection"], r["subcollection"], srccomp,
                                   r["abs_path"], short, long_, stem, r["collection"])
            if modality == "multiome":          # signal/peaks from multiome = ATAC readout
                modality = MULTIOME_MODALITY
            # RNA expression coverage -> its own plain composite (not chromatin signal/peaks)
            if EXPRESSION_COMPOSITE and modality in EXPRESSION_MODALITIES:
                sfx = EXPRESSION_COMPOSITE["suffix"]
                idval = fit_id(comp + sfx, idbase, used)
                expr_children.append(render_child(comp + sfx + "_" + idval, comp + sfx, r, lf))
                comp_colls[comp + sfx].add(r["collection"])
                continue

            # cCREs and histone marks each get their own faceted composite;
            # everything else (ATAC signal + peaks) goes to the main one.
            if CCRE_COMPOSITE and dtype == "cCRE":
                tcomp = comp + CCRE_COMPOSITE["suffix"]
                tchildren, tmeta = ccre_children, ccre_meta_rows
            elif HISTONE_COMPOSITE and modality in HISTONE_MODALITIES:
                tcomp = comp + HISTONE_COMPOSITE["suffix"]
                tchildren, tmeta = histone_children, histone_meta_rows
            else:
                tcomp = comp
                tchildren, tmeta = faceted_children, meta_rows
            idval = fit_id(tcomp, idbase, used)
            if tcomp == comp and idval != idbase:
                collisions.append("%s\t%s\t-> %s" % (asm, idbase, idval))
            # cellType: clean + collapse A/B, then the global C canonical merge.
            # tissue: per-track (path/body_parts), but a tissue-restricted cell type in a
            # whole-body atlas overrides the collection's 'multiple' with its one organ.
            # Computed off the pre-rollup name, as before.
            _pre = celltype_canon.get(raw_celltype(r, lf), raw_celltype(r, lf))
            tissue = track_tissue(r)
            ct_tissue = CELLTYPE_TISSUE.get(r["collection"], {}).get(
                _ct_matchkey(_pre)) if _pre else None
            if ct_tissue:
                tissue = ct_tissue
            celltype, xw_tissue, xw_life, xw_cond = harmonize_celltype(r, lf, celltype_canon)
            # QC clusters (doublet / low-quality / batch) are not cell types
            if celltype is None and _pre:
                qc_dropped.append("%s\t%s" % (asm, idbase))
                continue
            # resolve the final facet values (SEA-AD gets its region + ADNC level
            # from the path/filename since the generic parsers do not fit it)
            tissue_v = xw_tissue or tissue
            life_v = xw_life or track_lifestage(r) or ""
            cond_v = xw_cond or track_condition(r["collection"], short, long_, stem) or ""
            if r["collection"] == "sea-ad-brain-atac":
                _sa_t, _sa_c = sea_ad_facets(r, stem)
                tissue_v = _sa_t or tissue_v
                cond_v = _sa_c or cond_v
            # CATLAS aging encodes the brain region as a two-letter filename prefix
            # (DH./FC.); promote it to Tissue, which is otherwise a generic 'brain'.
            _cr = catlas_region(r["collection"], stem)
            if _cr:
                tissue_v = _cr
            # a readable longLabel built from the harmonized cell type + facets,
            # replacing the cryptic source shortLabel-derived one. The CATLAS aging
            # age (months, the .NN filename suffix) is added to the label rather than
            # the Life_stage facet, so that facet stays coarse (Adult/Aged) and
            # consistent across datasets.
            extra_lbl = ""
            if r["collection"] == "catlas-mouse-aging":
                _am = re.search(r"\.(\d{1,2})$", stem or "")
                if _am:
                    extra_lbl = "%d months" % int(_am.group(1))
            ds_label = bm.dataset_label(r["collection"])
            # the discriminator the harmonization dropped (peak method, grouping level,
            # cluster number, cohort); without it many subtracks share one label
            var_long, var_short = track_variant(r, lf, stem, dtype, modality)
            long_label = build_long_label(celltype, cond_v, tissue_v, ds_label,
                                          track_labels(r, lf)[1], extra_lbl, var_long)
            # facet values that only the longLabel spells out, compacted for the
            # shortLabel (SEA-AD region + ADNC, CATLAS aging age)
            _sft = short_facet_tokens(r, cond_v, tissue_v, extra_lbl)
            short_label = build_short_label(celltype,
                                           " ".join(x for x in (var_short, _sft) if x),
                                           track_labels(r, lf)[0])
            # color every track by the broad class of its final cell type, so the
            # same class is the same color on both assemblies
            _cls, child_color = lookup_class(celltype)
            if celltype and _cls is None:
                unclassed[celltype] += 1       # no broad class -> no facet value, no color
            tchildren.append(render_child(tcomp + "_" + idval, tcomp, r, lf,
                                          color=child_color, long_override=long_label,
                                          short_override=short_label, default_off=True))
            comp_colls[tcomp].add(r["collection"])
            # Dataset column: id|label form -> displays the human short label and
            # links to ?ds=<slug> (subtrackUrls render splits on '|', uses the id/slug
            # for the URL, shows the label). Commas in the label are swapped to ';'
            # because that render splits cells on commas.
            ds_cell = "%s|%s" % (CELLS_DATASET.get(r["collection"], r["collection"]),
                                 ds_label.replace(",", ";"))
            tmeta.append(OrderedDict([
                # Name shows the same readable longLabel the track displays.
                ("_Name", long_label),
                ("Dataset", ds_cell),
                ("Tissue", tissue_v or "unknown"),
                ("Life_stage", life_v or "unknown"),
                ("Condition", cond_v or "unknown"),
                ("Data_type", DATATYPE_LABELS.get(dtype, dtype)),
                ("Modality", modality or "unknown"),
                ("Cell_class", _cls or "unknown"),
                ("_Cell_type", celltype or "unknown"),
                ("Track", idval),
            ]))
            coverage[asm]["total"] += 1
            if r.get("_orphan"):
                coverage[asm]["orphan"] += 1
            if modality:
                coverage[asm]["modality"] += 1
            if celltype:
                coverage[asm]["cellType"] += 1

        # Qualify any label still shared by several subtracks with its source cluster
        # code -- the rollup facets merge distinct clusters on purpose, but the label
        # has to stay unique or the user cannot tell the tracks apart. Every composite
        # gets this, not just the faceted ones: the expression, brain-spatial and
        # interact composites were left out at first and kept 24 duplicate mm10 labels.
        # The bucket composites hold no facet metadata, hence the empty meta list.
        _groups = [(faceted_children, meta_rows),
                   (histone_children, histone_meta_rows),
                   (ccre_children, ccre_meta_rows),
                   (interact_children, []),
                   (expr_children, []),
                   (barchart_tracks, [])]
        _groups += [(kids, []) for _sfx, kids in ann_buckets.values()]
        _groups += [(kids, []) for kids in sep_buckets.values()]
        _groups += [(kids, []) for kids in sepcoll_buckets.values()]
        for _kids, _meta in _groups:
            n = disambiguate_labels(_kids, _meta)
            if n:
                label_qualified[asm] += n

        # ---- assemble the trackDb: superTrack (if extras) > faceted composite
        #      + interact composite + annotation composites + barChart tracks ----
        has_extra = bool(interact_children or barchart_tracks or ann_buckets
                         or sep_buckets or sepcoll_buckets or expr_children
                         or histone_children or ccre_children)
        _sl0, _ll0 = dataset_scoped_labels(
            "",
            "Cell Browser signal & peaks",
            "Signal and peak tracks from UCSC Cell Browser datasets (%s)" % asm,
            comp_colls.get(comp, set()))
        faceted_parent = [
            "track " + comp,
            "compositeTrack faceted",
            # Hidden by default, and every child is "off" (see render_child): the user
            # picks tracks from the faceted selector. Without this, showing the composite
            # turned on all 925 hg38 subtracks at once -- the native singleCellSignalsPeaks
            # track has always done both, the hub was missing them.
            "visibility hide",
            # generic container type; children declare their own real type. Required
            # by hubCheck; matches production faceted composites (ENCODE4 uses bed 3).
            "type bigBed 3",
            "shortLabel %s" % _sl0,
            "longLabel %s" % _ll0,
            "metaDataUrl %s/all-tracks-hub/%s/metadata.tsv" % (TARGET_BASE, asm),
            "primaryKey Track",
            "subtrackUrls Dataset=%s/?ds=$$" % TARGET_BASE,
            "defaultSortField Dataset",
            # NB: code (hgTrackUi.c) reads lowercase "maxCheckboxes"; doc's is a typo.
            "maxCheckboxes 200",
            # One scale for every subtrack the user has selected, so two tracks drawn at
            # the same locus are directly comparable -- with per-track autoScale, tracks
            # whose values differ by orders of magnitude looked equally tall. Set HERE and
            # not on the children: hgTracks groups by tdb->parent (wigTrack.c setMinMax),
            # and hubCheck rejects `autoScale group` on an individual bigWig. Limits come
            # from the data in the CURRENT WINDOW (preDrawAutoScale scans preDraw), not
            # genome-wide, so one outlying region elsewhere cannot flatten the view.
            "autoScale group",
            "html %s.html" % comp,
        ]

        # Every container is a top-level track. There used to be one superTrack per
        # assembly wrapping them all, but that buried the cCRE, expression, interaction
        # and splice-junction tracks a level down, where a user browsing the track list
        # would not find them; each now stands on its own and carries its own
        # description page.
        blocks = []
        # only emit the faceted composite if it actually has children -- a dataset that is
        # entirely split out (e.g. mm9 = mouse-brain-mecp2 only) would otherwise leave an
        # empty composite parent, which hubCheck rejects (missing bigDataUrl).
        if faceted_children:
            blocks.append("\n".join(faceted_parent))
            blocks += faceted_children

        # second faceted composite: histone marks (its own metaDataUrl / metadata file)
        if histone_children:
            hc = comp + HISTONE_COMPOSITE["suffix"]
            _hs, _hl = dataset_scoped_labels(
                HISTONE_COMPOSITE["suffix"], HISTONE_COMPOSITE["shortLabel"],
                "%s (%s)" % (HISTONE_COMPOSITE["longLabel"], asm),
                comp_colls.get(hc, set()))
            blocks.append("\n".join([
                "track " + hc,
                "compositeTrack faceted",
                "visibility hide",
                "type bigBed 3",
                "shortLabel %s" % _hs,
                "longLabel %s" % _hl,
                "metaDataUrl %s/all-tracks-hub/%s/histone.metadata.tsv" % (TARGET_BASE, asm),
                "primaryKey Track",
                "subtrackUrls Dataset=%s/?ds=$$" % TARGET_BASE,
                "defaultSortField Dataset",
                "maxCheckboxes 200",
                "autoScale group",       # see the main composite above
                "html %s.html" % (hc),
            ]))
            blocks += histone_children

        # faceted composite: cCREs (own metaDataUrl / metadata file)
        if ccre_children:
            cc = comp + CCRE_COMPOSITE["suffix"]
            _cs, _cl = dataset_scoped_labels(
                CCRE_COMPOSITE["suffix"], CCRE_COMPOSITE["shortLabel"],
                "%s (%s)" % (CCRE_COMPOSITE["longLabel"], asm),
                comp_colls.get(cc, set()))
            blocks.append("\n".join([
                "track " + cc,
                "compositeTrack faceted",
                "visibility hide",
                "type bigBed 3",
                "shortLabel %s" % _cs,
                "longLabel %s" % _cl,
                "metaDataUrl %s/all-tracks-hub/%s/ccre.metadata.tsv" % (TARGET_BASE, asm),
                "primaryKey Track",
                "subtrackUrls Dataset=%s/?ds=$$" % TARGET_BASE,
                "defaultSortField Dataset",
                "maxCheckboxes 200",
                "html %s.html" % (cc),
            ]))
            blocks += ccre_children

        # bigInteract composite
        if interact_children:
            _is_, _il = dataset_scoped_labels(
                "Interact", "Cell Browser interactions",
                "Interaction tracks from UCSC Cell Browser datasets (%s)" % asm,
                comp_colls.get(comp + "Interact", set()))
            blocks.append("\n".join([
                "track " + comp + "Interact",
                "compositeTrack on",
                "type bigInteract",
                "visibility hide",
                "shortLabel %s" % _is_,
                "longLabel %s" % _il,
                "html %s.html" % (comp + "Interact"),
            ]))
            blocks += interact_children

        # annotation composites, one per annotation type
        for title, (sfx, kids) in ann_buckets.items():
            _as_, _al = dataset_scoped_labels(
                sfx, "Cell Browser %s" % title.lower(),
                "%s from UCSC Cell Browser datasets (%s)" % (title, asm),
                comp_colls.get(comp + sfx, set()))
            blocks.append("\n".join([
                "track " + comp + sfx,
                "compositeTrack on",
                "type bigBed",
                "visibility hide",
                "shortLabel %s" % _as_,
                "longLabel %s" % _al,
                "html %s.html" % (comp + sfx),
            ]))
            blocks += kids

        # separated non-cell-type signal composites (e.g. miRNA binding by age/region)
        for sfx, kids in sep_buckets.items():
            scfg = SEPARATE_SIGNAL_BY_SUFFIX[sfx]
            _ss, _sl = dataset_scoped_labels(
                sfx, scfg["shortLabel"], "%s (%s)" % (scfg["longLabel"], asm),
                comp_colls.get(comp + sfx, set()))
            blocks.append("\n".join([
                "track " + comp + sfx,
                "compositeTrack on",
                "type bigWig",
                # group, not on: one scale across the composite so its tracks are
                # comparable at a locus. Same reasoning as the main faceted composite.
                "autoScale group",
                "maxHeightPixels 128:36:16",
                "visibility hide",
                "shortLabel %s" % _ss,
                "longLabel %s" % _sl,
                "html %s.html" % (comp + sfx),
            ]))
            blocks += kids

        # RNA expression coverage composite (plain, out of the chromatin facets)
        if expr_children:
            ecfg = EXPRESSION_COMPOSITE
            _es, _el = dataset_scoped_labels(
                ecfg["suffix"], ecfg["shortLabel"],
                "%s (%s)" % (ecfg["longLabel"], asm),
                comp_colls.get(comp + ecfg["suffix"], set()))
            blocks.append("\n".join([
                "track " + comp + ecfg["suffix"],
                "compositeTrack on",
                "type bigWig",
                # group, not on: one scale across the composite so its tracks are
                # comparable at a locus. Same reasoning as the main faceted composite.
                "autoScale group",
                "maxHeightPixels 128:36:16",
                "visibility hide",
                "shortLabel %s" % _es,
                "longLabel %s" % _el,
                "html %s.html" % (comp + ecfg["suffix"]),
            ]))
            blocks += expr_children

        # whole split-out collection composites (bulk/sample/cluster bigWig)
        for coll, kids in sepcoll_buckets.items():
            ccfg = SEPARATE_COLLECTIONS[coll]
            _ps, _pl = dataset_scoped_labels(
                ccfg["suffix"], ccfg["shortLabel"],
                "%s (%s)" % (ccfg["longLabel"], asm),
                comp_colls.get(comp + ccfg["suffix"], set()))
            blocks.append("\n".join([
                "track " + comp + ccfg["suffix"],
                "compositeTrack on",
                "type bigWig",
                # group, not on: one scale across the composite so its tracks are
                # comparable at a locus. Same reasoning as the main faceted composite.
                "autoScale group",
                "maxHeightPixels 128:36:16",
                "visibility hide",
                "shortLabel %s" % _ps,
                "longLabel %s" % _pl,
                "html %s.html" % (comp + ccfg["suffix"]),
            ]))
            blocks += kids

        # standalone bigBarChart tracks, now top level in their own right
        blocks += barchart_tracks

        # blank line between every stanza (required: trackDb records split on blanks)
        with open(os.path.join(STANZADIR, "%s.trackDb.txt" % asm), "w") as fh:
            fh.write("\n\n".join(indent_stanza(b) for b in blocks) + "\n")

        # Sidecar describing each top-level track, for build_hub's per-track description
        # pages. Written here because this is where the collection behind every child is
        # known; deriving it in build_hub from the served URLs got it wrong, since one
        # source directory (catlas-decoder) holds several unrelated datasets.
        tracks_meta = []
        for b in blocks:
            first = b.split("\n", 1)[0]
            if not first.startswith("track ") or re.search(r"^parent ", b, re.M):
                continue
            name = first.split(None, 1)[1]
            kind = ("faceted" if "compositeTrack faceted" in b
                    else "composite" if "compositeTrack" in b else "track")
            nkids = sum(1 for x in blocks
                        if re.search(r"^parent %s( |$)" % re.escape(name), x, re.M))
            colls = sorted(comp_colls.get(name, set()))
            tracks_meta.append(OrderedDict([
                ("track", name), ("kind", kind),
                ("shortLabel", (re.search(r"^shortLabel (.*)$", b, re.M) or
                                re.match("", "")).group(1)
                 if re.search(r"^shortLabel (.*)$", b, re.M) else name),
                ("longLabel", re.search(r"^longLabel (.*)$", b, re.M).group(1)
                 if re.search(r"^longLabel (.*)$", b, re.M) else ""),
                ("subtracks", nkids or 1),
                ("datasets", [[CELLS_DATASET.get(c, c), bm.dataset_label(c) or c]
                              for c in colls]),
            ]))
        with open(os.path.join(METADIR, "%s.tracks.json" % asm), "w") as fh:
            json.dump(tracks_meta, fh, indent=1)
        child_stanzas = faceted_children + histone_children + ccre_children   # for count msg
        # write metadata as plain LF-terminated TSV. NOT csv.writer: it emits
        # CRLF, leaving a trailing \r on the last column that the Genome Browser's
        # faceted metaDataUrl parser (plain TSV, no CSV quoting) mis-reads -- it
        # broke DataTables on rows with an empty last field. Sanitize every value
        # of tab/CR/newline for the same reason.
        # Every cell must be non-empty: the Genome Browser's facetedComposite.js
        # parses the TSV with tsvText.trim() (which eats the trailing TAB, not just
        # the newline), so an empty final field on the file's last line drops that
        # column for the last row -> DataTables "unknown parameter" error. Filling
        # empties (-> "-") guarantees the last field is never whitespace. (The GB JS
        # trim() is itself a bug; reported separately.)
        def _clean(v):
            return re.sub(r"[\t\r\n]+", " ", str(v)).strip() or "-"
        with open(os.path.join(METADIR, "%s.metadata.tsv" % asm), "w") as fh:
            fh.write("\t".join(meta_cols) + "\n")
            for row in meta_rows:
                fh.write("\t".join(_clean(row[c]) for c in meta_cols) + "\n")
        if histone_meta_rows:
            with open(os.path.join(METADIR, "%s.histone.metadata.tsv" % asm), "w") as fh:
                fh.write("\t".join(meta_cols) + "\n")
                for row in histone_meta_rows:
                    fh.write("\t".join(_clean(row[c]) for c in meta_cols) + "\n")
        if ccre_meta_rows:
            with open(os.path.join(METADIR, "%s.ccre.metadata.tsv" % asm), "w") as fh:
                fh.write("\t".join(meta_cols) + "\n")
                for row in ccre_meta_rows:
                    fh.write("\t".join(_clean(row[c]) for c in meta_cols) + "\n")
        sys.stderr.write("%-8s %4d children (%d histone, %d cCRE)\n"
                         % (asm, len(child_stanzas), len(histone_children), len(ccre_children)))

    # side outputs
    with open(os.path.join(OUTDIR, "unpublished.tsv"), "w") as fh:
        fh.write("assembly\ttrack_url\tabs_path\n")
        fh.write("\n".join(unpublished) + ("\n" if unpublished else ""))
    with open(os.path.join(OUTDIR, "name-collisions.log"), "w") as fh:
        fh.write("assembly\toriginal_id\tassigned\n")
        fh.write("\n".join(collisions) + ("\n" if collisions else ""))
    with open(os.path.join(OUTDIR, "parse-warnings.log"), "w") as fh:
        fh.write("\n".join(warnings) + ("\n" if warnings else ""))
    with open(os.path.join(OUTDIR, "dropped-introns.log"), "w") as fh:
        fh.write("\n".join(dropped_introns) + ("\n" if dropped_introns else ""))
    with open(os.path.join(OUTDIR, "unresolved-assembly.log"), "w") as fh:
        fh.write("manifest_assembly\tabs_path\n")
        fh.write("\n".join(unresolved) + ("\n" if unresolved else ""))
    with open(os.path.join(OUTDIR, "celltype-merges.log"), "w") as fh:
        fh.write("canonical\t<- merged variants (plural/case collapse C)\n")
        fh.write("\n".join(sorted(celltype_merges)) + ("\n" if celltype_merges else ""))
    with open(os.path.join(OUTDIR, "unclassified-celltypes.log"), "w") as fh:
        fh.write("# cell types with no celltype-class.tsv entry -> Cell_class 'unknown',\n"
                 "# no track color. Add them to paper-decodes/ and rebuild the crosswalks.\n"
                 "tracks\tcell_type\n")
        for _ct, _n in sorted(unclassed.items(), key=lambda x: (-x[1], x[0])):
            fh.write("%d\t%s\n" % (_n, _ct))
    with open(os.path.join(OUTDIR, "orphan-annotations.log"), "w") as fh:
        fh.write("# annotation bigBeds with no hub stanza -- dropped, since their\n"
                 "# composite and label would be guesses from the filename\nassembly\tabs_path\n")
        fh.write("\n".join(sorted(orphan_ann)) + ("\n" if orphan_ann else ""))
    with open(os.path.join(OUTDIR, "allen-duplicates.log"), "w") as fh:
        fh.write("# byte-identical allen-brain-science copies skipped "
                 "(bg_regrouping_cl copy kept)\nassembly\tabs_path\n")
        fh.write("\n".join(sorted(allen_dupes)) + ("\n" if allen_dupes else ""))

    # facet coverage report
    out = ["# Phase 2+3 facet coverage\n"]
    out.append("Curated + orphan/hub-less tracks emitted as faceted-composite "
               "children, per assembly.\n")
    out.append("| assembly | tracks | orphans | modality known | cellType known |")
    out.append("|---|---|---|---|---|")
    tot = defaultdict(int)
    for asm in sorted(coverage):
        c = coverage[asm]
        for k in ("total", "orphan", "modality", "cellType"):
            tot[k] += c[k]
        out.append("| %s | %d | %d | %d (%d%%) | %d (%d%%) |" % (
            asm, c["total"], c["orphan"],
            c["modality"], 100 * c["modality"] // max(c["total"], 1),
            c["cellType"], 100 * c["cellType"] // max(c["total"], 1)))
    out.append("| **total** | %d | %d | %d (%d%%) | %d (%d%%) |" % (
        tot["total"], tot["orphan"],
        tot["modality"], 100 * tot["modality"] // max(tot["total"], 1),
        tot["cellType"], 100 * tot["cellType"] // max(tot["total"], 1)))
    out.append("\nUnpublished (referenced but not served): %d" % len(unpublished))
    out.append("Dropped .introns.bb intermediates: %d" % len(dropped_introns))
    out.append("Unresolved-assembly tracks skipped: %d" % len(unresolved))
    out.append("Name collisions/truncations: %d" % len(collisions))
    out.append("QC clusters dropped (doublet/low-quality/batch): %d" % len(qc_dropped))
    out.append("Redundant allen-brain-science copies skipped: %d" % len(allen_dupes))
    out.append("Orphan annotation bigBeds dropped (no hub stanza): %d" % len(orphan_ann))
    out.append("Cell types with no broad class (Cell_class unknown): %d in %d tracks"
               % (len(unclassed), sum(unclassed.values())))
    out.append("Subtracks label-qualified with a source cluster code: %d"
               % sum(label_qualified.values()))
    out.append("Parse warnings: %d" % len(warnings))
    with open(os.path.join(OUTDIR, "facet-coverage.md"), "w") as fh:
        fh.write("\n".join(out) + "\n")
    sys.stderr.write("Wrote stanzas/, meta/, unpublished.tsv, facet-coverage.md\n")


if __name__ == "__main__":
    main()
