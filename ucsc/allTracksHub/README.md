# all-tracks super hub

Builds the UCSC Cell Browser "all tracks" super hub: one genome-browser track hub that
gathers the tracks generated for every Cell Browser dataset (per-cell-type signal and
peaks, cCREs, histone marks, interactions, splice junctions, gene annotations, expression)
into one place, per assembly. Redmine #37820.

It also produces the stanzas that the native `singleCellSignalsPeaks` tracks on hg38 and
mm10 are generated from (Redmine #37914); see
`kent/src/hg/makeDb/scripts/singleCellSignalsPeaks/`.

Like everything under `ucsc/`, paths here are hardcoded to our internal systems.

## Files

| file | purpose |
|---|---|
| `build_manifest.py` | walks `/hive/data/inside/cells/datasets` + htdocs, writes `manifest.tsv` |
| `build_stanzas.py` | manifest -> per-assembly faceted trackDb stanzas + facet metadata |
| `build_hub.py` | assembles the served hub dir (hub.txt, genomes.txt, per-track description pages) |
| `hub_config.json` | all the wrangler-editable curation: modality maps, denylists, label rules, composite definitions |
| `update_hub.sh` | runs the three in order, then validates |
| `publish_hub.sh` | symlinks the hub and its data files under htdocs-cells (separate, reviewed step) |

## Running it

```
./update_hub.sh          # full rebuild, re-walks the dataset tree (~6 min)
./update_hub.sh --fast   # reuse the cached walk
./publish_hub.sh         # publish (review first)
```

## Code here, output elsewhere

This directory is git-controlled, so the build must not write into it. A run produces
about 5 MB that is regenerated every time: `manifest.tsv`, `discovery.pkl`, `stanzas/`,
`meta/`, and nine logs. Those go to the output directory instead:

```
CBHUB_OUT=/some/work/dir ./update_hub.sh
```

The default is `/hive/data/inside/cells/all-tracks-hub-build`. `hub_config.json`
is read from *this* directory, since it is tracked input rather than output.

## Staging vs production

`htdocs-cells` on hgwdev is served as `cells-test.gi.ucsc.edu`, so the hub is normally
staged there first. The host written into every `bigDataUrl` comes from `HUB_BASE_URL`,
defaulting to the production `served_base` in `hub_config.json`:

```
HUB_BASE_URL=https://cells-test.gi.ucsc.edu python3 build_stanzas.py
HUB_BASE_URL=https://cells-test.gi.ucsc.edu python3 build_hub.py
./publish_hub.sh
```

**Build with the host you are publishing to.** Many of the hub's data files exist only on
cells-test, so a production-host build published to cells-test gives tracks that fail to
load, with no error anywhere. Check with:

```
grep '^bigDataUrl' $CBHUB_OUT/stanzas/hg38.trackDb.txt \
  | sed 's|\(https\?://[^/]*\)/.*|\1|' | sort -u
```

Promote to production by rebuilding with `HUB_BASE_URL` unset.

## Cell-type curation

The cell-type crosswalks and the broad-class colour palette are *not* here. They are
archived with the native track scripts, in
`kent/src/hg/makeDb/scripts/singleCellSignalsPeaks/celltype-crosswalks/`, because the
native tracks and this hub share them and must colour a cell class identically.
`build_stanzas.py` finds them via `XWALK_ROOT` (default: that kent path, override with the
env var). `build_celltype_crosswalks.py`, which regenerates them from the paper-curated
decode tables, lives there too.

## Track labels

Every top-level track's label is `<type> - <dataset>` when the track holds data from a
single dataset, e.g. `Splice Junc - Cortex development`. The type half comes from
`track_type_short` in `hub_config.json`, keyed on the track-name **suffix** after
`cellBrowser<Asm>` (`""` is the main signal-and-peaks composite, `Bar` the standalone bar
charts). Retune any of them there; no code change needed. The dataset half is the
dataset's own `shortLabel` from its `cellbrowser.conf`, so changing it there updates the
hub, the native tracks and the Cell Browser together.

Multi-dataset tracks keep a generic label, since naming one dataset on a container that
holds several would be wrong.

## Things that have bitten

- **Do not hand-edit the generated trackDb.** `stanzas/<asm>.trackDb.txt` and the served
  `<hub>/<asm>/trackDb.txt` are both rewritten on every run. Change `hub_config.json` or
  the code instead.
- **Cross-reference the manifest by `abs_path`, never by basename.** Several datasets keep
  same-named copies in `hub/` and `hubTest/`, or `hub_out/` and `hub_out_max/`, where one
  is curated and the other is excluded.
- **Check exit codes; do not pipe a build through `grep`.** A crash mid-run leaves the
  first assembly's stanza file empty and the rest stale from the previous run, which then
  reads as a successful build with unchanged output.
- **Audit label uniqueness across a whole assembly, not per composite.** Two tracks in
  different composites can collide, and the per-composite disambiguation cannot see it.
