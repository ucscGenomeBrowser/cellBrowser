# Expression unit classification

Fills the `unit` field across the Cell Browser dataset corpus (Redmine #27555).
`unit` is the label on the violin-plot y-axis and in the genome browser, so an
empty one leaves a dataset showing expression values with no stated scale.

The job is mostly a text-mining problem: the unit is rarely recorded anywhere
machine-readable, so it has to be inferred from the matrix dtype plus whatever
the methods and abstract say about the protocol. These scripts do that in three
passes, cheapest first: matrix dtype, then keyword heuristics, then Claude.

Like everything under `ucsc/`, paths here are hardcoded to our internal systems.

## Scripts

| Script | Purpose |
|---|---|
| `auditUnits.py` | Inventory every dataset, recursing through collections. Writes `units_audit.tsv`: name, matrixArrType, current_unit, has_methods, abstract_snippet, pmid. |
| `classifyUnitsUint.py` | Uint32 (integer-count) matrices. Scans methods/abstract for plate-protocol keywords: match means `read counts`, otherwise `UMI counts`. |
| `classifyUnitsFloat.py` | Float32 matrices, where the dtype alone says nothing. Asks Claude via the `claude -p` CLI. Datasets with no methods text are assigned `unknown` without a call. `--limit`, `--dry-run`; resumes from its own output. |
| `reclassifyParentMethods.py` | Second pass for sub-datasets that have no methods text of their own but whose parent collection does. Updates `float32_units_classified.tsv` in place. |
| `applyAgentResults.py` | Applies DOI/URL/GEO lookups to rows still marked `unknown`, by dataset-name prefix. The lookup table is inline, so it doubles as the record of which paper settled which dataset. |
| `unitPaths.py` | Shared `--dir` / `--htdocs` handling. Not run directly. |

Nothing here writes to a dataset. `addTags` (in `ucsc/`) does that, taking a
two-column TSV and updating both `cellbrowser.conf` and `dataset.json` — no
`cbBuild` needed.

## Where the TSVs go

The working TSVs are regenerated data, not source, so they must not land in this
checkout. Every script takes `--dir`, the directory it reads and writes those
files in:

```
export CBUNITS_DIR=/hive/users/mspeir/claude/cell-browser
python3 auditUnits.py -o units_audit.tsv
```

Precedence is `--dir`, then `$CBUNITS_DIR`, then the current directory. An
absolute path given to `-o`/`--audit`/`--file` overrides all of it. Point `--dir`
inside this checkout and the scripts warn rather than silently filling git status
with TSVs.

`auditUnits.py` and `classifyUnitsUint.py` still write to stdout when given no
`-o`, so the older redirect form keeps working.

`--htdocs` overrides the Cell Browser tree the dataset metadata is read from,
which is the one thing worth changing if you are testing against a staging copy.

## Pipeline

```
auditUnits.py -o units_audit.tsv
  └─> units_audit.tsv                       (one row per dataset)
        ├─> classifyUnitsUint.py units_audit.tsv -o uint32_units.tsv
        │     └─> uint32_units.tsv                    (keyword heuristic)
        └─> classifyUnitsFloat.py --audit units_audit.tsv
              ├─> float32_units_classified.tsv        (Claude)
              └─> float32_units_unknown.tsv           (no methods text)
                    ├─> reclassifyParentMethods.py    (retry via parent methods)
                    └─> applyAgentResults.py          (retry via DOI/URL/GEO)

Merge the classified TSVs, review, then: addTags units_for_addTags_writable.tsv
```

The three Claude-driven steps all take `--dry-run`, which reports what they would
change without making a single API call. Worth using first: a full float run is
several hundred calls, and the two retry steps rewrite the classified TSV in
place.

## Controlled vocabulary

| Value | Use for |
|---|---|
| `UMI counts` | Raw integer counts, droplet protocols (10x, Drop-seq) |
| `read counts` | Raw integer counts, plate protocols (SMART-seq, CEL-seq) |
| `log-normalized counts` | Seurat `NormalizeData()`, or scanpy `normalize_total` + `log1p` |
| `TPM`, `log2(TPM+1)`, `CPM`, `log2(CPM+1)` | Self-explanatory |
| `scTransform residuals` | Seurat SCTransform v3+ |
| `unknown` | Cannot be determined |

`FPKM` turned up mid-project and is not in the original vocabulary; a couple of
datasets use it pending a decision. The vocabulary is RNA-only, which is the
main open question below.

## Known limitations

- **The vocabulary does not cover non-RNA data.** Roughly 20 unknowns are ATAC,
  CUT&TAG or methylation datasets, where none of the values above apply. Someone
  has to decide what a chromatin-accessibility unit should be called before those
  can be filled; see `atac-unit-notes.md`. The all-tracks hub work has since
  settled on `Gene activity` for ArchR gene-activity matrices, which is a
  candidate.
- **Some datasets cannot be resolved from text at all** — paywalled papers (the
  Hackney/Wong retina sets), and datasets with no DOI, URL or GEO accession to
  look up.
- **Write permissions block a batch of updates.** A set of datasets, mostly under
  `acute-myeloid-leuk`, `evocell`, `tabulamuris/10x` and `melanoma`, are not
  writable by the person running `addTags`, so their rows get filtered into a
  separate TSV and skipped. This is the main mechanical blocker.

## Re-running when new datasets land

The pipeline is re-runnable, not one-shot: `classifyUnitsFloat.py` skips rows
already in its output, and the classifiers only report datasets whose `unit` is
still empty. A re-run therefore costs roughly what the new datasets cost.

1. `auditUnits.py -o units_audit.tsv`
2. Diff against the previous audit to see what is new.
3. New Uint32: `classifyUnitsUint.py units_audit.tsv -o uint32_new.tsv`, review,
   then `addTags`.
4. New Float32: `classifyUnitsFloat.py --limit <N>`, review, then `addTags`.
5. Spot-check `unit=` in both `cellbrowser.conf` and `dataset.json`.

To survey what is currently set without running the pipeline, use
`getTagVals --all unit` (recipes in `ucsc/audit-recipes.md`).

## See also

- `ucsc/addTags` — applies a reviewed TSV to the datasets
- `ucsc/audit-recipes.md` — one-liners for auditing any dataset tag
- Working TSVs, the original plan, per-step progress and the ATAC vocabulary
  notes are in `/hive/users/mspeir/claude/cell-browser/`
- Redmine #27555
