``cbTool``: combine and convert your data
=========================================

The ``cbTool`` script included in the Cell Browser package bundles a number of
small utilities for combining, reordering, and converting the input files used
to build a dataset. Run ``cbTool`` without arguments (or ``cbTool --help``) to
see the full list of commands.

Combining and reordering metadata
---------------------------------

``metaCat`` — merge metadata files
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Use ``cbTool metaCat`` to merge cell-level metadata files from different
sources or pipelines (e.g. ``cbScanpy`` or ``cbSeurat``) into one. The files
are joined on their first column, which must contain the same cell identifier
in every file::

    cbTool metaCat myMeta.tsv seuratOut/meta.tsv scanpyOut/meta.tsv ./newMeta.tsv --fixDots

The resulting file includes the columns from all input files. Add ``--order``
to control the column order and ``--del`` to drop columns (see
`Common options`_ below).

``reorder`` — reorder or drop metadata fields
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

``cbTool reorder`` rewrites a single metadata file with its fields in a new
order, optionally removing some. The cell-ID column is always kept first::

    cbTool reorder meta.tsv meta.newOrder.tsv --del sampleId --order=cluster,cellType,age

Combining expression matrices
-----------------------------

There are two ways to merge matrices, depending on whether you are adding more
**cells** or more **genes**. In both cases the matrices are the usual Cell
Browser format: one line per gene, one column per cell (``.tsv``/``.csv``,
optionally gzipped).

``matCatCells`` — add more cells
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

If you have matrices for different cells from the same assay with identical
genes (same genes, in the same order, same number of lines), ``matCatCells``
concatenates them side by side, adding the new cells on the right::

    cbTool matCatCells mat1.tsv.gz mat2.tsv.gz exprMatrix.tsv.gz

``matCatGenes`` — add more genes
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

If you have matrices for the *same* cells but different genes (e.g. multi-modal
assays), ``matCatGenes`` stacks them, adding the extra genes to the end. You can
prefix the genes from a file by appending ``=prefix`` to its name, which is
useful for keeping, for example, ATAC features distinct::

    cbTool matCatGenes mat1.csv.gz mat2.tsv.gz=atac- exprMatrix.tsv.gz

Here every gene from the second matrix is prefixed with ``atac-``.

Converting Matrix Market (.mtx) to .tsv
---------------------------------------

Use ``cbTool mtx2tsv`` to convert an expression matrix in `Matrix Market
<https://math.nist.gov/MatrixMarket/formats.html>`_ format to the tsv format
the Cell Browser expects (one gene per line, one cell per column)::

    cbTool mtx2tsv matrix.mtx genes.tsv barcodes.tsv exprMatrix.tsv.gz

Generating a quick-genes file
-----------------------------

``cbTool quickgenes`` builds a ``quickGenes.tsv`` file from a ``markers.tsv``
file in the current directory. The resulting file can be pointed to with the
``quickGenesFile`` option in ``cellbrowser.conf`` to populate the "quick genes"
table in the left sidebar::

    cbTool quickgenes

Common options
--------------

A few options apply to the ``metaCat`` and ``reorder`` commands:

- ``--fixDots`` — work around R's habit of replacing special characters in cell
  identifiers with ``.``. Directories created with R's ``ExportToCellbrowser()``
  usually do not need this, but metadata written by other tools may.
- ``--order=disease,age`` — the new comma-separated field order. Do not include
  the cell-ID column; it is always first. Fields present in the file but not
  listed here are appended as the last columns.
- ``--only`` — when used with ``--order``, keep *only* the listed fields instead
  of appending the rest.
- ``--del=field1,field2`` — names of fields to remove.
