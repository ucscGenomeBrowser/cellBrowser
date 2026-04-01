Bulk downloads
--------------

The dataset hierarchy
^^^^^^^^^^^^^^^^^^^^^

There is no search API yet but a systematic way to download:

1. http://cells.ucsc.edu/dataset.json contains the list of top-level datasets in the "datasets" attribute.
2. every object in the "datasets" list is a child dataset, note the "name" attribute.
3. every dataset has a <datasetname>/dataset.json file again, e.g. http://cells.ucsc.edu/adultPancreas/dataset.json
4. datasets with a "datasets" attribute have children themselves, e.g. http://cells.ucsc.edu/xena/dataset.json
5. every dataset has a desc.json file with general meta data about the project

Rsync download
^^^^^^^^^^^^^^

If you want to download all or selected datasets, use our ``rsync`` server. To download single dataset, for example,
use this command, for ``ad-aging-brain``::

    rsync -avzp hgdownload.gi.ucsc.edu::cells/ad-aging-brain/ ./

And the list all datasets available::

    rsync hgdownload.gi.ucsc.edu::cells

When you download a dataset, you will find the dataset.json (as described above) and most datasets will have the expression matrix in .mtx.gz format. Some older ones will have it in .tsv.gz format. The .json file will show which format is used.

All datasets also have a meta.tsv file with the cell-level metadata.

The json file should be very self-explanatory.

Please let us know if you use this. We love hearing feedback and like to report re-use of the dataset collection to NIMH.
