# Audit Recipes

Quick shell one-liners for auditing dataset metadata across the Cell Browser
corpus. Most recipes combine `getTagVals --all` with standard Unix tools
(`awk`, `sort`, `uniq`, `wc`).

## Setup

`getTagVals --all` walks every leaf dataset under
`/usr/local/apache/htdocs-cells/` and emits a TSV with one row per dataset.
By default it reads the configured tag from `cellbrowser.conf` in
`/hive/data/inside/cells/datasets/<name>/`. Use:

- `-d` to read from `desc.conf`
- `-j` to read from `dataset.json` (in the htdocs tree)

The TSV has a header line starting with `#` followed by one row per dataset.
Column 1 is the dataset name; remaining columns are the requested tags.

## Find empty/missing values

Datasets missing `body_parts`:
```bash
getTagVals --all body_parts | awk -F'\t' 'NR>1 && $2==""{print $1}'
```

Datasets with no PMID in desc.conf:
```bash
getTagVals --all -d pmid | awk -F'\t' 'NR>1 && $2==""{print $1}'
```

Datasets missing both PMID and DOI (need both columns):
```bash
getTagVals --all -d pmid,doi | awk -F'\t' 'NR>1 && $2=="" && $3==""{print $1}'
```

Datasets with no preview image:
```bash
getTagVals --all -d image | awk -F'\t' 'NR>1 && $2==""{print $1}'
```

## Count fill rates

Quick fill-rate for a single field:
```bash
getTagVals --all assay | awk -F'\t' '
    NR>1 { total++; if ($2!="") filled++ }
    END  { printf "%d/%d (%.1f%%) have assay set\n", filled, total, 100*filled/total }
'
```

Fill rates for several fields at once:
```bash
for tag in body_parts organisms diseases assay life_stages; do
    getTagVals --all "$tag" | awk -F'\t' -v T="$tag" '
        NR>1 { total++; if ($2!="") filled++ }
        END  { printf "  %-15s %d/%d (%.1f%%)\n", T, filled, total, 100*filled/total }
    '
done
```

## Inspect value distributions

Most common assay values (catches typos and inconsistent capitalization):
```bash
getTagVals --all assay | awk -F'\t' 'NR>1 && $2!=""{print $2}' | sort | uniq -c | sort -rn
```

Distinct organisms across the corpus:
```bash
getTagVals --all organisms | awk -F'\t' 'NR>1 && $2!=""{print $2}' | sort -u
```

Check unit-field standardization (after the fill-unit project):
```bash
getTagVals --all -j unit | awk -F'\t' 'NR>1 && $2!=""{print $2}' | sort | uniq -c | sort -rn
```

## Cross-field audits

Datasets where the matrix is Uint32 but `unit` is empty (legacy unit gaps):
```bash
getTagVals --all -j matrixArrType,unit \
    | awk -F'\t' 'NR>1 && $2=="Uint32" && $3==""{print $1}'
```

Datasets with a `pmid` but no `paper_url` (could use enrichment):
```bash
getTagVals --all -d pmid,paper_url \
    | awk -F'\t' 'NR>1 && $2!="" && $3==""{print $1}'
```

## Compare source vs. built JSON

Spot datasets where `cellbrowser.conf` and `dataset.json` disagree on a tag
(usually means `cbBuild` was never re-run after a manual edit, though
`addTags` now keeps them in sync automatically):

```bash
diff \
    <(getTagVals --all unit | sort) \
    <(getTagVals --all -j unit | sort)
```

## Round-trip with addTags

Pull current values, edit in a spreadsheet, push the changes back:

```bash
# 1. Snapshot current values
getTagVals --all body_parts > body_parts_current.tsv

# 2. Edit body_parts_current.tsv in your editor / spreadsheet

# 3. Push the edited values back (overwrites tag, no rebuild needed)
addTags body_parts_current.tsv
```

The `--all` walk uses `dataset.json` files in htdocs, so the dataset list is
authoritative. `addTags` will print a warning for any datasets whose source
`cellbrowser.conf` is missing (e.g. published-only datasets you don't have
write access to).

## When to write a custom script instead

Reach for a one-off Python script (like `unitClassify/auditUnits.py`) when you need:

- **Multi-source per-row data**: combining fields from both `dataset.json` and
  `desc.json` in the same row. `getTagVals` reads one source at a time.
- **Computed/derived columns**: placeholder detection ("n/a", "see paper"),
  HTML-stripping abstracts, normalizing whitespace.
- **Existence checks beyond strings**: e.g. "does the preview image file
  actually exist on disk", not just "is the tag non-empty".
- **Slow / expensive lookups**: external API calls, full-text searches,
  cross-referencing with another database.

For everything else, `getTagVals --all` plus `awk` should be enough.

## See also

- `addTags` — bulk-edit tag values; updates `cellbrowser.conf` + `dataset.json` atomically
- `getTagVals` — extract tag values for a list of datasets (or all of them)
- `datasetDiffs` — compare datasets across cells-test / cells-beta / RR
- `tabUniq` — generic dedup/counting tool (handy for column distributions)
- `unitClassify/` — the expression-unit classification pipeline, and
  `auditUnits.py` there as an example of a custom audit script
