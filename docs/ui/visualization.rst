The Visualization
=================

.. image:: /images/main_viewer.png
   :alt: Annotated screenshot of the main Cell Browser view
   :width: 1000

Once you open a dataset, you will see the core visualization with
these main areas:

**Left sidebar**
   Contains the "Annotation" and "Gene" tabs for
   controlling how cells are colored or labeled.

**Center scatter plot**
   The primary 2D layout (typically tSNE or UMAP, though sometimes spatial images too).
   Cells appear as dots, colored by the currently selected annotation or
   gene. Clusters are labeled according to the currently selected field.

**Right legend**
    Shows the color key for the current field used for coloring. Color key can be sorted
    alphabetically or by frequency. Use the checkboxes to select large groups of cells.

**Top toolbar**
   Contains menus (Edit, View, Tools) and links to
   dataset information, layout switching, and external resources.

**Bottom heatmap area**
   When enabled, shows an expression heatmap
   of dataset genes across clusters (see :doc:`analysis` for details).

Navigating the Scatter Plot
---------------------------

You can interact with the scatter plot using the cursor mode buttons in
the lower-left corner of the plot area:

**Pan (hand icon)**
   Click and drag to move around the plot.

**Select (dashed rectangle)**
   Click and drag to draw a selection box around cells. Selected cells
   can be used for violin plots and histogram analysis (see
   :doc:`analysis`).

**Zoom (magnifying glass)**
   Click and drag to zoom into a region.

You can also zoom using your mouse scroll wheel. Press **Space** or
click the **100%** button to reset to the default zoom level.

Cluster Labels
--------------

Many datasets display cluster labels directly on the scatter plot. Hover
over a label to see additional details such as top marker genes or the
full name behind an acronym. Click a cluster label to bring up a pop-up
list of marker genes for that cluster (see `Marker Genes from Cluster
Labels`_ below). Use the "Label by Annotation" drop-down menu under
the "Annotation" tab to change the field used to generate the labels.

Switching Layouts
-----------------

If a dataset provides multiple dimensionality reduction results (e.g.
both tSNE and UMAP), you can switch between them using the layout
dropdown in the top toolbar. You can also change the size and
transparency of the dots.

Coloring by Metadata
--------------------

The **Annotation** tab in the left sidebar lists all available metadata
fields for the current dataset (e.g. cluster name, cell type, donor age,
sample origin). Click any field name to recolor the scatter plot by the
values in that field. The legend on the right will update to show the
color assignments.

.. tip::

   Use the **"Recolor checked fields"** button in the legend to highlight
   only specific values of interest. All other cells will be colored grey.

Coloring by Gene Expression
----------------------------

.. image:: /images/gene_coloring.png
   :alt: Cells colored by expression of a single gene, with a violin plot
   :width: 1000

To color cells by gene expression:

1. Click the **Gene** tab in the left sidebar.
2. Type a gene symbol into the search box.
3. Select the gene from the autocomplete list.

The scatter plot will recolor using a gradient from light (low expression)
to dark (high expression). The legend will show the expression bins and
their associated colors.

.. image:: /images/gene_search.gif
   :alt: Animation: clicking genes in the Dataset Genes table recolors the plot instantly
   :width: 1000

You can also recolor instantly by clicking a gene in the **Dataset Genes**
table on the **Gene** tab, as shown above — a quick way to page through a
set of markers without retyping each name.

Multi-gene Coloring
~~~~~~~~~~~~~~~~~~~

To color cells by the expression of multiple genes:

1. Click the "Multi Gene" button under the **Gene** tab.
2. Enter a list of genes, either as one per line or a space/comma separated list.
3. Click "Load the genes below".

The scatter plot is then colored based on the summed expression of those genes.

.. _quick-genes:

Quick Genes
~~~~~~~~~~~

Many datasets include a curated list of **quick genes**, which are genes the dataset
authors consider particularly important or informative. These appear as a
clickable table below the gene search box. Click any gene name to instantly
color the plot by its expression.

Marker Gene Database
~~~~~~~~~~~~~~~~~~~~~

.. image:: /images/marker_database.png
   :alt: Browsing curated marker gene databases for a cell type
   :width: 1000

The **Marker Genes** section at the bottom of the **Gene** tab lets you look up
known marker genes for a cell type from curated public databases (such as
CellMarker 2.0 and PanglaoDB) and color the plot by them — a quick way to see
which clusters express the canonical markers of a given cell type.

If marker databases are available for the dataset's species (currently human
and mouse), a **Browse** button appears. Click it to open the **Browse Marker
Gene Databases** window:

1. **Choose a database** from the dropdown. Only databases matching the
   dataset's species are listed, with links to the source database and its
   publication shown just below.
2. **Find a cell type** by typing in the filter box, or by expanding the tree
   of cell types (grouped by tissue where the database provides it). The number
   next to each cell type is how many of its marker genes are present in the
   current dataset's expression matrix.
3. **Click a cell type** to list its marker genes on the right (only genes
   found in this dataset are shown). Click any gene to color the plot by its
   expression, or click **Color by all** to color by the summed expression of
   the whole set.

.. note::

   This is different from `Marker Genes from Cluster Labels`_ below: that shows
   marker genes computed for *this dataset's own clusters*, whereas the Marker
   Gene Database looks up *known* markers for a named cell type from external,
   curated databases.

Marker Genes from Cluster Labels
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

If a dataset includes marker gene annotations, clicking a **cluster label**
on the scatter plot will open a pop-up table of marker genes for that
cluster, sorted by p-value by default. You can:

- Click a **gene symbol** in the first column to recolor the plot by
  that gene's expression.
- Click a **"genome"** link (if available) to open the UCSC Genome Browser
  centered on that gene.
- Sort by any column (p-value, enrichment, etc.) by clicking column headers.

Changing Color Palettes
~~~~~~~~~~~~~~~~~~~~~~~~

The Cell Browser includes several built-in color palettes. You can switch
palettes using the palette selector in the legend area. The URL will update
to reflect your choice, so palette selections can be shared via URL.

.. _gene-expression-plots:

Gene Expression Plots (Dot Plots)
---------------------------------

.. image:: /images/dot_plot.png
   :alt: Dot plot of gene expression across clusters
   :width: 1000

The **Gene Expression Plots** button in the top toolbar (or on the **Gene**
tab) opens a dedicated window for comparing expression across groups of cells.
When you open it, the dataset's :ref:`quick genes <quick-genes>` are loaded
automatically as a **dot plot**:

- Each **row** is a group of cells and each **column** is a gene.
- **Dot color** encodes the mean expression of that gene in that group.
- **Dot size** encodes the fraction of cells in the group that express the gene
  (the non-zero fraction). Hover over any dot for the exact values.

You can shape the plot with the controls along the top:

**Show expression of**
   Pick a single gene, or use **Add multiple genes** to enter a list.

**Split by cell annotation**
   Choose the categorical field that defines the rows (e.g. cluster, cell type,
   sample). Numerical fields cannot be used to split.

**Subsplit by**
   Optionally cross the split field with a second categorical field — for
   example, split by cell type *and* subsplit by disease status to compare the
   same cell types across conditions.

Each of the split and subsplit controls has an **All ▾** filter button next to
it, which lets you restrict the plot to a subset of that field's values instead
of showing every group.

Click **← Back to Cell Browser** or the close icon to return to the scatter plot.

Spatial Transcriptomics Data
----------------------------

The Cell Browser supports visualization of spatial transcriptomics data,
including Visium and MERFISH experiments.

When viewing a spatial dataset, cells are positioned according to their
physical tissue coordinates rather than a dimensionality reduction.
All standard features — coloring by gene, metadata, selection — work
the same way.

For datasets that include both spatial coordinates and a standard UMAP
or tSNE layout, you can use **split-screen mode** (see :doc:`analysis`)
to display both views simultaneously. The "Show on both sides" option
lets you color both panes by the same gene for direct comparison.

Example spatial datasets to explore:

- **Visium**: `ms-subcortical-lesions.cells.ucsc.edu
  <https://ms-subcortical-lesions.cells.ucsc.edu>`_
- **MERFISH**: `hoc.cells.ucsc.edu
  <https://hoc.cells.ucsc.edu>`_
- **Split-screen spatial + snRNA-seq**: `dup15q-cortex-organoids.cells.ucsc.edu
  <https://dup15q-cortex-organoids.cells.ucsc.edu>`_

Keyboard Shortcuts
------------------

**Viewer Navigation**

.. list-table::
   :header-rows: 1
   :widths: 20 80

   * - Shortcut
     - Action
   * - ``+``
     - Zoom in
   * - ``-``
     - Zoom out
   * - ``Space``
     - Reset zoom to default (100%)
   * - ``c`` then ``l``
     - Hide/show cluster labels
   * - ``t``
     - Toggle split-screen mode (see :doc:`analysis`)
   * - ``h``
     - Toggle heatmap (see :doc:`analysis`)
   * - ``o``
     - Open a new dataset

**Cell Selection**

.. list-table::
   :header-rows: 1
   :widths: 20 80

   * - Shortcut
     - Action
   * - ``s`` then ``a``
     - Select all visible cells
   * - ``s`` then ``n``
     - Unselect all cells
   * - ``s`` then ``i``
     - Invert current cell selection
   * - ``s`` then ``s``
     - Name current cell selection
   * - ``s`` then ``s``
     - Name current cell selection
   * - ``f`` then ``c``
     - Find and select cells based on metadata attributes or gene expression
   * - ``f`` then ``i``
     - Find and select cells based on cell ID
   * - ``b`` then ``s``
     - Set selected cells as background for violin plots
   * - ``b`` then ``r``
     - Reset background cells

Menu Reference
--------------

**Edit menu**

- **Find Cells** — Filter and select cells using metadata criteria or gene expression
- **Find by ID** — Filter and select cells using cell IDs
- **Export** — Export and download identifiers of currently selected cells

.. tip::
   Combine **Find Cells** with the **Export** option to get cell IDs to use with the
   **Find by ID** option.

**View menu**

- **Split screen** — Toggle the split-screen two-pane comparison view
- **Heatmap** — Toggle the expression heatmap below the scatter plot

**Tools menu**

- **Set as background cells** — Define selected cells as the comparison
  group for violin plots
- **Reset background cells** — Clear custom background, revert to
  comparing against all cells
