UCSC Cell Browser
=================

The UCSC Cell Browser is a fast, lightweight viewer for single-cell data.
Cells are presented along with metadata and gene expression, with the ability
to color cells by both of these attributes. Additional information, such as
cluster marker genes and selected dataset-relevant genes, can also be displayed.

The main UCSC Cell Browser website runs at http://cells.ucsc.edu, showing more than
330 datasets, the majority submitted directly to us from labs for publications.
We are happy to host your datasets; to do so
upload your files via the website https://cells-submit.gi.ucsc.edu.
To not show data publicly, check the box "private dataset" in the upload interface.
Email us at cells@ucsc.edu if you have any questions. We can also add datasets that
are not yours, just email us a link to the publication.

If you use the UCSC Cell Browser in your research, please cite
`our Bioinformatics paper <https://dx.doi.org/10.1093/bioinformatics/btab503>`_.
If you are also using data from a specific dataset we host, please also cite
the original authors of that dataset (visible under 'Info & Download' while viewing that dataset).

The UCSC Cell Browser is funded by grants from the `California Institute for Regenerative Medicine <https://www.cirm.ca.gov/>`_ and the
`Chan-Zuckerberg Initiative <https://www.chanzuckerberg.com/>`_.

To report issues or view the source code, see `GitHub <https://github.com/maximilianh/cellBrowser>`_.

If you do run into any trouble, please open a
`Github issue <https://github.com/maximilianh/cellBrowser/issues/new>`_
or email us at cells@ucsc.edu, we can usually fix them quickly.


Exploring Data
--------------

Already have a dataset open at cells.ucsc.edu or your own Cell Browser
instance? Start here to learn how to navigate, search genes, select cells,
and use features like split-screen comparison and heatmaps.

.. toctree::
   :maxdepth: 2
   :caption: Using the Cell Browser

   ui/getting_started
   ui/datasets
   ui/visualization
   ui/analysis
   ui/downloading
   ui/faq

Submitting Data
--------------

Learn how to submit your dataset for display on the Cell Browser.

.. toctree::
   :maxdepth: 1
   :caption: Submitting to the Cell Browser

   submission

Building Your Own Cell Browser
------------------------------

Want to create a Cell Browser for your own single-cell dataset and
host it on your own web server? Follow the guides below.

.. toctree::
   :maxdepth: 2
   :caption: Building a Cell Browser

   installation
   quick_start
   basic_usage
   internet
   tabsep
   seurat
   scanpy
   cellranger
   howto
   advanced
   genes
   cbtool
   dataDesc
   collections
   cellbrowser_conf

.. toctree::
   :maxdepth: 1
   :caption: Other

   load
   downloads

.. toctree::
   :hidden:

   interface
