Configuring cellbrowser.conf
----------------------------

The file ``cellbrowser.conf`` is the main configuration file for a Cell Browser dataset.
It is a Python-format key-value file that tells ``cbBuild`` where to find your data files
and how to display them in the browser.

A sample file can be created with the command ``cbBuild --init`` or be copied from
`our Github repo <https://github.com/ucscGenomeBrowser/cellBrowser/blob/develop/src/cbPyLib/cellbrowser/sampleConfig/cellbrowser.conf>`_.
For the companion file that describes dataset metadata (title, abstract, methods, etc.),
see :doc:`dataDesc`.

.. contents:: Settings on this page
   :local:
   :depth: 1

Required Settings
~~~~~~~~~~~~~~~~~

These settings must be present in every ``cellbrowser.conf``.

``name``
   Internal short name for the dataset. This becomes the output directory name and appears
   in the URL. Use only lowercase letters, numbers, and hyphens — no special characters or
   whitespace. If you use dataset hierarchies/collections, this tag is ignored in favor of
   the directory structure.

   ::

      name = "my-dataset"

``shortLabel``
   Human-readable name of the dataset, shown in the dataset list and at the top of the
   browser view.

   ::

      shortLabel = "My Single-Cell Dataset"

``exprMatrix``
   Path to the expression matrix file. Genes should be rows and cells should be columns.
   Can be a tab-separated ``.tsv.gz`` file or in Matrix Market format (``.mtx.gz``, with
   accompanying ``.features.tsv.gz`` and ``.barcodes.tsv.gz`` files sharing the same base name).

   ::

      exprMatrix = "exprMatrix.tsv.gz"

``meta``
   Path to the cell annotation metadata table. One row per cell, tab- or comma-separated.
   The first column must contain cell identifiers matching those in the expression matrix.
   There should be at least two columns: the cell name and a cluster assignment. The file
   must include a header line. To speed up processing, the cells in this file should be in
   the same order as in the expression matrix.

   ::

      meta = "meta.tsv"

``coords``
   A list of coordinate files for dimensionality reduction layouts (e.g. t-SNE, UMAP).
   Each entry is a dictionary with at least ``file`` and ``shortLabel``. The coordinate
   files are three-column tab-separated files in the format ``cellName, x, y``. Cell names
   must match the expression matrix. The number of rows does not need to match the expression
   matrix, allowing you to specify a subset of cells.

   Each coordinate entry supports these keys:

   - ``file``: (required) path to the coordinate TSV file
   - ``shortLabel``: (required) human-readable label shown in the layout dropdown
   - ``flipY``: set to ``True`` if y-coordinates need to be flipped (common with R/Matplotlib output). Default: ``False``
   - ``colorOnMeta``: a metadata field name to automatically color on when this layout is activated
   - ``lineFile``: path to a TSV file with columns ``x1, x2, y1, y2`` to overlay lines (e.g. trajectory trees) on top of cells
   - ``lineFlipY``: set to ``True`` to flip the y-axis of the lines relative to the points. Default: ``False``
   - ``annots``: a list of ``[x, y, "text"]`` entries to manually add text annotations at specific positions

   ::

      coords = [
          {
              "file": "tsne.coords.tsv",
              "shortLabel": "t-SNE",
              "flipY": False
          },
          {
              "file": "umap.coords.tsv",
              "shortLabel": "UMAP"
          }
      ]

``clusterField``
   The name of the field in the metadata table that contains cluster assignments. This
   field is used as the default grouping for marker genes and other cluster-level features.

   ::

      clusterField = "WGCNAcluster"

``labelField``
   The name of the field in the metadata table whose values are displayed as cluster labels
   on the scatter plot. Often the same as ``clusterField``.

   ::

      labelField = "WGCNAcluster"

``geneIdType``
   Specifies how gene identifiers in the expression matrix should be interpreted. Accepted
   values:

   - ``"auto"``: automatically detects Ensembl human/mouse IDs and translates them to gene symbols
   - ``"gencode-human"``: GENCODE/Ensembl human gene IDs
   - ``"gencode-mouse"``: GENCODE/Ensembl mouse gene IDs
   - ``"symbol"``: gene symbols (optionally specify a database for symbol validation or genome mapping with cbHub)
   - ``"raw"``: disables symbol checking entirely; use this for non-human/mouse Ensembl IDs when symbols are already provided in the matrix (pipe-separated in TSV format or tab-separated in MTX format)

   ::

      geneIdType = "auto"


Optional Settings
~~~~~~~~~~~~~~~~~

Dataset Filters and Ordering
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

These settings control how the dataset appears in the dataset browser list and are most
useful when hosting multiple datasets on a single Cell Browser instance (e.g. cells.ucsc.edu).

``priority``
   A number that determines the order of datasets in the list. Smaller values appear first.

   ::

      priority = 10

``tags``
   A list of tags shown in the dataset browser, useful for categorizing datasets by technology.

   ::

      tags = ["smartseq2"]

``body_parts``
   Organ or body part labels used for dataset filtering. Only displayed as filter options if
   at least one dataset in the instance has this set. Can be a list.

   ::

      body_parts = ["brain", "cortex"]

``organisms``
   Organism labels for dataset filtering. Can be a list.

   ::

      organisms = ["Human (H. sapiens)"]

``diseases``
   Disease labels for dataset filtering. Can be a list.

   ::

      diseases = ["Healthy"]

``projects``
   Project labels for dataset filtering. Can be a list.

   ::

      projects = ["Human Cell Atlas"]

``life_stages``
   Life stage labels for dataset filtering. Can be a list.

   ::

      life_stages = ["embryo"]

``domains``
   Research domain labels for dataset filtering. Can be a list.

   ::

      domains = ["Neuroscience"]

``sources``
   Data source or repository labels (e.g. where the data was obtained from). Can be a list.

   ::

      sources = ["GEO"]

``visibility``
   Set to ``"hide"`` to exclude this dataset from the dataset list. Useful for
   pre-publication data that should not yet be publicly visible.

   ::

      visibility = "hide"


Gene and Expression Settings
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

``quickGenesFile``
   Path to a CSV file of genes to highlight in the "quick genes" table on the left sidebar.
   This is optional but highly recommended — even 2–3 quick genes makes the browser
   significantly more intuitive for users.

   ::

      quickGenesFile = "quickGenes.csv"

``markers``
   A list of marker gene files. Each entry is a dictionary with ``file`` and ``shortLabel``.
   Marker files are tab-separated with columns for cluster name, gene symbol, p-value, and
   enrichment, plus any additional columns you want to display. You can provide multiple
   marker files (e.g. from different algorithms or differential expression analyses).

   Each entry supports these additional keys:

   - ``sortColumn``: column index (as a number) to sort by, instead of the first column
   - ``sortOrder``: ``"asc"`` (default) or ``"desc"``

   ::

      markers = [
          {"file": "markers.tsv", "shortLabel": "Cluster-specific markers"}
      ]

``unit``
   A string describing the unit of values in the expression matrix. Shown on the genome
   browser and on the violin plot y-axis.

   ::

      unit = "TPM"

   Common values: ``"read count/UMI"``, ``"log of read count/UMI"``, ``"TPM"``,
   ``"log of TPM"``, ``"CPM"``, ``"FPKM"``, ``"RPKM"``

``matrixType``
   Format of the numbers in the expression matrix. In most cases ``"auto"`` works correctly.

   - ``"auto"``: auto-detect the number format (default)
   - ``"int"``: integers
   - ``"float"``: floating point numbers
   - ``"forceInt"``: force interpretation as integers when values are expressed in formats like ``3.123e10`` or ``100.000``

   ::

      matrixType = "auto"

``geneLabel``
   If your expression matrix contains something other than genes (e.g. lipids, peaks, or
   plankton), this setting replaces the word "gene" throughout the user interface.

   ::

      geneLabel = "Peak"

``atacSearch``
   For ATAC-seq datasets, specifies the gene model version to use for searching peaks
   around genes. The value should combine the UCSC assembly name with the gene model version.
   See :doc:`howto` for details on setting up ATAC-seq data.

   ::

      atacSearch = "hg38.gencode-34"


Metadata Display Settings
^^^^^^^^^^^^^^^^^^^^^^^^^^^

``enumFields``
   A list of metadata field names that should be treated as categorical (enumerated) values
   rather than being auto-detected as numeric and binned. Useful when a field like cluster ID
   or chip ID contains numbers but should be displayed as discrete categories.

   ::

      enumFields = ["c1_cell_id"]

``enumOrder``
   A dictionary mapping metadata field names to text files that specify a custom sort order
   for the values. Each text file should contain one value per line in the desired display order.

   ::

      enumOrder = {"WGCNAcluster": "clusterorder.txt"}

``metaDesc``
   Path to a two-column TSV or CSV file with longer descriptions for metadata fields. When
   present, a small info icon appears next to the field name and the description is shown
   on mouse-over.

   ::

      metaDesc = "metaDesc.tsv"

``metaOpt``
   A dictionary of display options for specific metadata fields. Currently supports ``fontSize``
   to reduce the font size for fields with very long value names.

   ::

      metaOpt = {"Cluster_field": {"fontSize": "10px"}}

``defColorField``
   The metadata field to use for coloring when the cell browser first opens. If set to
   ``"None"`` (the string, not Python's ``None``), no coloring is applied on startup.

   ::

      defColorField = "Pseudotime"

``acronymFile``
   Path to a two-column TSV or CSV file mapping short cluster names (as used in ``meta.tsv``)
   to longer, human-readable labels. The long labels are shown on mouse-over or when clicking
   a cluster name. Useful when metadata uses acronyms.

   ::

      acronymFile = "acronyms.tsv"


Visual Display Settings
^^^^^^^^^^^^^^^^^^^^^^^^

``showLabels``
   Whether cluster labels are shown on the scatter plot by default. Default: ``True``.

   ::

      showLabels = True

``radius``
   The radius of the cell circles on the scatter plot. If not specified, a reasonable
   default is calculated based on dataset size.

   ::

      radius = 5

``alpha``
   The transparency of the cell circles. If not specified, a reasonable default is used.
   Values range from 0 (fully transparent) to 1 (fully opaque).

   ::

      alpha = 0.3

``binStrategy``
   Controls how expression values are assigned to color bins. Default: ``"cells"``.

   - ``"cells"``: create bins where each bin contains a similar number of cells (but with potentially very different expression ranges)
   - ``"range"``: create bins that each span a similar expression range (but with potentially very different cell counts)

   ::

      binStrategy = "range"

``defQuantPal``
   Default color palette for quantitative (numeric) data such as gene expression.
   See `palette.js <http://google.github.io/palette.js/>`_ for available palettes,
   or change the palette in the UI and look at the URL to find the value.

   ::

      defQuantPal = "viridis"

``defCatPal``
   Default color palette for categorical data (e.g. cluster names).

   ::

      defCatPal = "rainbow"

``colors``
   Custom color assignments for metadata values. A dictionary mapping metadata field names
   to TSV or CSV files. Each color file has two columns (no header line): the metadata value
   and a color (as a six-digit hex code with or without ``#``, or a CSS/R color name). The
   special field name ``"__default__"`` applies colors across all fields.

   For backwards compatibility, a single filename string (instead of a dictionary) is also
   accepted and behaves the same as ``"__default__"``.

   Currently only ``cbImportScanpy`` generates these files automatically, as Seurat does
   not yet have a standard for storing colors.

   ::

      colors = {
          "cluster": "cluster_colors.tsv",
          "__default__": "allcolors.tsv"
      }

``clusterPngDir``
   Path to a directory of PNG images for clusters. When set, small images are shown in
   the tooltip when hovering over cluster labels.

   ::

      clusterPngDir = "clusterImgs"


Line Overlay Settings
^^^^^^^^^^^^^^^^^^^^^^

These settings adjust the appearance of trajectory or tree lines when using the ``lineFile``
option in a coordinate entry.

``lineColor``
   Color of the overlay lines, as a hex code. Default: dark grey.

   ::

      lineColor = "#112233"

``lineAlpha``
   Transparency of the overlay lines. Default: ``0.5``.

   ::

      lineAlpha = 0.3

``lineWidth``
   Width of the overlay lines in pixels. Default: ``3``.

   ::

      lineWidth = 5


Genome Browser Integration
^^^^^^^^^^^^^^^^^^^^^^^^^^^^

``hubUrl``
   URL to a UCSC track hub with BAM file reads and expression values, or a full link
   to a UCSC Genome Browser session. When set, "genome" links appear next to gene symbols
   in the marker gene pop-up and clicking them opens the Genome Browser centered on
   that gene.

   ::

      hubUrl = "http://cells.ucsc.edu/cortex-dev/hub/hub.txt"


Split-Screen Startup
^^^^^^^^^^^^^^^^^^^^^

``split``
   Start the browser in split-screen mode. The value is a dictionary that can specify
   a second coordinate set, a metadata field, or a gene for the second pane.

   ::

      # Show a different layout on the second pane, colored by a metadata field
      split = {"coords": "umap", "meta": "spatial"}

      # Color the second pane by a gene
      split = {"gene": "HOXA2"}
