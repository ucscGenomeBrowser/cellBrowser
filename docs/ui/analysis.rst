Cell Selection, Comparison, and Heatmaps
========================================

Selecting Cells
---------------

Switch to the **select cursor mode** (dashed rectangle icon in the
lower-left of the plot) and click-and-drag to draw a selection box
around a group of cells.

Once cells are selected:

- A **histogram** appears showing the distribution of metadata values
  within your selection.
- If a gene is currently coloring the plot, a **violin plot** shows
  gene expression in the selected cells versus all other cells.

You can also select cells by metadata criteria using **Edit > Find Cells**.

Exporting Selected Cells
-------------------------

After selecting cells, go to **Edit > Export** to download the cell
identifiers for use in your own analysis tools (e.g. Seurat or Scanpy).

Setting Background Cells
-------------------------

By default, violin plots compare your selected cells against *all other
cells* in the dataset. You can define a custom comparison group:

1. Select the cells you want as your background.
2. Go to **Tools > Set as background cells** (or press ``b`` then ``s``).
3. Select a new group of cells — the violin plot will now compare against
   your defined background instead of all cells.

To clear the custom background, go to **Tools > Reset background cells**
(or press ``b`` then ``r``).

Split-Screen Comparison
-----------------------

The Cell Browser can split the main view into two side-by-side panes,
allowing you to compare two different colorings simultaneously.

To enable split-screen:

- Go to **View > Split screen**, or
- Press ``t`` on your keyboard.

The currently active pane is outlined in black and its coloring is
reflected in the legend. To change a pane's coloring:

1. Click the pane you want to modify (it will get the black outline).
2. Change the annotation field or gene in the left sidebar.

.. tip::

   When in split-screen mode, a **"Show on both sides"** checkbox
   appears under the Gene tab. Enable it to automatically color both
   panes with the same gene — particularly useful when comparing a
   spatial layout with a UMAP layout.

Expression Heatmap
------------------

If a dataset includes curated "dataset genes," you can display an
expression heatmap below the scatter plot:

- Go to **View > Heatmap** to toggle it on.
- The heatmap shows the expression of the dataset genes across the
  cluster labels visible in the scatter plot.
- Click and drag the divider bar between the scatter plot and heatmap
  to resize.
