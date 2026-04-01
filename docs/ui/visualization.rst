The Visualization
=================

.. image:: /images/cellbrowser-BasicUiFeatures.converted.jpg
   :alt: Annotated screenshot of the main Cell Browser view

Once you open a dataset, you will see the core visualization with
these main areas:

**Left sidebar** — Contains the "Annotation" and "Gene" tabs for
   controlling how cells are colored.

**Center scatter plot** — The primary 2D layout (typically tSNE or UMAP).
   Cells appear as dots, colored by the currently selected annotation or
   gene.

**Right legend** — Shows the color key for the current coloring.

**Top toolbar** — Contains menus (Edit, View, Tools) and links to
   dataset information, layout switching, and external resources.

**Bottom heatmap area** — When enabled, shows an expression heatmap
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
Labels`_ below).

Switching Layouts
-----------------

If a dataset provides multiple dimensionality reduction results (e.g.
both tSNE and UMAP), you can switch between them using the layout
dropdown in the top toolbar.

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

To color cells by gene expression:

1. Click the **Gene** tab in the left sidebar.
2. Type a gene symbol into the search box.
3. Select the gene from the autocomplete list.

The scatter plot will recolor using a gradient from light (low expression)
to dark (high expression). The legend will show the expression bins and
their associated colors.

Quick Genes
~~~~~~~~~~~

Many datasets include a curated list of **quick genes** — genes the dataset
authors consider particularly important or informative. These appear as a
clickable table below the gene search box. Click any gene name to instantly
color the plot by its expression.

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

.. list-table::
   :header-rows: 1
   :widths: 20 80

   * - Shortcut
     - Action
   * - ``Space``
     - Reset zoom to default (100%)
   * - ``t``
     - Toggle split-screen mode (see :doc:`analysis`)
   * - ``b`` then ``s``
     - Set selected cells as background for violin plots
   * - ``b`` then ``r``
     - Reset background cells

Menu Reference
--------------

**Edit menu**

- **Find Cells** — Filter and select cells using metadata criteria
- **Export** — Export identifiers of currently selected cells

**View menu**

- **Split screen** — Toggle the split-screen two-pane comparison view
- **Heatmap** — Toggle the expression heatmap below the scatter plot

**Tools menu**

- **Set as background cells** — Define selected cells as the comparison
  group for violin plots
- **Reset background cells** — Clear custom background, revert to
  comparing against all cells
