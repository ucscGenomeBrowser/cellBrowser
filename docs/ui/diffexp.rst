Differential Expression
=======================

The **Differential expression** tool compares gene expression between two
populations of cells that you define — Group A versus Group B — and returns a
ranked table of the genes that differ, with a volcano plot and per-gene violin
plots. Unlike the quick violin plot for a selection, this runs a real statistical
test (Wilcoxon rank-sum) on the server and reports fold changes, effect sizes, and
adjusted p-values.

Opening the tool
----------------

.. image:: /images/diffexp_builder.png
   :alt: The Differential expression builder in the Tools tab
   :width: 1000

Open the tool in either of two places:

- The **Tools** menu at the top of the window has a **Differential expression…**
  item.
- The **Tools** tab in the left sidebar has a **Compare two populations…** button
  under its *Differential expression* heading.

Either one opens the builder, which replaces the Tools tab's normal contents while
it is open; close it with the **×** in its header to return to the other tools.

Choosing what to compare
------------------------

At the top of the builder, the **Compare by** menu picks the metadata field whose
values define your groups. Any categorical field can be used, including custom
annotations you have made yourself (see :doc:`accounts`). Switching the field
recolors the map by that field and clears any groups you had started.

Building the two groups
-----------------------

Below **Compare by** is a list of the chosen field's values, each with its cell
count. To assign a value to a group:

1. Choose the target group with the **Add to: Group A / Group B** toggle.
2. Click values in the list to add them to that group. Assigned values are tinted
   and marked ``A`` or ``B``; click again to remove.

The list is sorted by cell count (largest first) and has a filter box, which is
handy for fields with many values. Your current groups, with their cell counts,
are shown in the **Group A** and **Group B** cards below the list.

Group B has two modes:

- **All other cells** (the default) runs a one-vs-rest comparison: Group A against
  every other cell in the dataset. This is the classic "marker genes" test.
- **Pick cell types** lets you choose specific values for Group B, the same way as
  Group A.

Each group needs at least 25 cells for a stable test.

Restricting a group with a filter
---------------------------------

Each group can be narrowed by a second metadata field. For example, to compare
male versus female cells *within a single cell type*, set **Compare by** to sex,
put the sexes in Groups A and B, and set both groups' filter to that cell type.
The filter accepts more than one value, so you can also, say, restrict a
comparison to a chosen set of donors.

Test settings
-------------

Expand **Test settings** to adjust:

- **Min. log₂ fold change** and **Adjusted p cutoff** — the thresholds for calling
  a gene significant. They set which genes are counted in the results summary and
  listed in the table.
- **Min. fraction expressing** — ignore genes detected in only a tiny fraction of
  both groups.

Mitochondrial, ribosomal, and hemoglobin genes, and genes detected in very few
cells, are filtered out before the test, so the multiple-testing correction
reflects the genes actually reported.

Running a comparison
--------------------

Click **Run comparison**. A progress overlay shows the current step and, during
the test itself, how many genes have been processed. Use **Cancel** to stop a run;
this halts the job on the server, not just in your browser.

If no compute backend is configured for the site, the tool still runs with
placeholder statistics over the dataset's real genes, so the interface can be
demonstrated.

Reading the results
-------------------

.. image:: /images/diffexp_results.png
   :alt: The differential expression results pop-up
   :width: 1000

Results open in a pop-up over the plot with three parts:

- A **table** of genes, sortable by any column: log₂ fold change, **AUC** (an
  effect size from 0.5 for no difference to 1 for always higher in Group A),
  adjusted p-value, and the mean expression and fraction expressing in each group.
  A search box and the **All / Up in A / Up in B** buttons narrow the list.
- A **volcano plot** (fold change versus significance); the **Volcano / MA**
  toggle switches to an MA plot (fold change versus average expression).
- A **violin plot** of the selected gene's expression in Group A versus Group B.

Click any gene — in the table or on the plot — to highlight it and show its
violin. **Download CSV** saves the full table; the file begins with a short header
recording the groups, the filters applied, and the significance thresholds, so a
downloaded result is self-describing.

.. note::

   The test treats each cell as an independent observation. With thousands of
   cells this makes the p-values anti-conservative (an effect known as
   pseudoreplication), so nearly everything can look "significant." Read the
   adjusted p-value as a ranking rather than an exact cutoff, and lean on the fold
   change and AUC to judge which differences matter.

Saving and sharing
------------------

The results pop-up has a **Save to account** button; it is greyed out until you
sign in (see :doc:`accounts`). Saved comparisons appear in the builder and reopen instantly;
opening one shows the saved results and re-runs the comparison in the background
for the full interactive table. Each saved comparison can be **shared** as a link
that anyone can open to view your result.
