Submitting data to the UCSC Cell Browser
----

At this time, we are happy to host pretty much any single-cell dataset,
regardless of the library preparation (10x, Smart-seq2, etc), organism
(human, mouse, zebrafish, etc), or analysis method (Seurat, Scanpy,
Monocle, etc). We can even display spatial data.

A cell browser requires at minimum three things:

* Expression matrix
* Metadata with cell names and cluster field
* 2D Layout coordinates

Go to our `submission website <https://cells-submit.gi.ucsc.edu>` to begin.

Step 1: Describe and configure your dataset
^^^^

The first step in submission is
`describing your dataset <https://cells-submit.gi.ucsc.edu/cb-submission.py>`,
which includes
your dataset title, abstract, methods, GEO accession, paper URLs, and other
details. Additionally, you will need to create a dataset shortname. A shortname
must meet the following requirements:

* All lowercase
* Words separated by dashes ("-")
* Four words or less (don't be afraid to abbreviate words, e.g. development -> dev)
* Informative

A great example is cortex-dev - it's all lowercase, the two words are separated by 
dashes, it's short at only two words long, and informs you that the dataset is focused on 
cortex development. It fulfills all four points above. 

Dataset collections
""""
If you have multiple datasets to submit, you can group them as a collection. Check
the box "Submitting multiple datasets as a collection" to indicate this, and you will
be prompted for the details for each dataset in that collection.

"Quick Genes"
""""

The final step in the dataset description form allows you to upload (in csv or tsv format)
or paste in a list of "quick genes", a set of genes that you believe represent important
variables in your dataset(s). In addition to the list of gene symbols, you can include
a word or two about why it was included (e.g. "Fst, Paraxial Mesoderm"; "HES1, Fig1D").
For collections, you can have one set of genes for every dataset in the
collection, or a different set for each.

Step 2: Preparing and sharing your files
^^^^

Before we can make a cell browser for you, you have to share the data
with us. We accept the following file types:

* Seurat RDS, Rdata, or Robj files
* Scanpy h5ad or Loom files
* A collection of tsv or csv files

After you have your data in one of the formats above,
`upload it <https://cells-submit.gi.ucsc.edu/upload.py>`
to our servers.

Step 3: Associate files with datasets
^^^^

Once you've filled out the dataset description form and uploaded your files,
you will need to `associate <https://cells-submit.gi.ucsc.edu/associate.py>`
those files using the dataset shortname that you selected in step 1.


Getting your URL
^^^^

After submitting your dataset to us, we will import the data and make a preliminary
version available on our development server. We will work with you to iterate and
make improvements to this version first. Once you give your final approval, we will
push the data to our main site, https://cells.ucsc.edu. Once there, you will receive the
final URL, e.g. https://cortex-dev.cells.ucsc.edu. This is the URL you should place in your
paper, link to from your lab website, tweet about, etc. Please **do not** put the
URL to our development server in your paper, since it is under active development,
we occasionally break it.

FAQs
^^^^

Can I share the output of cbBuild with you?
""""

We prefer you share the original h5ad, RDS, or tsv files. This way we can offer them
as downloads alongside your data visualization. The output of
cbBuild is optimized for web access and display, which makes it difficult if 
not impossible to make changes to the cell browser at a later date (e.g. 
correcting spelling mistakes).

Can I keep my dataset private until a later date, but still accessible to reviewers?
""""
Yes, we offer limited methods for keeping datasets private. We can hide datasets from
being listed alongside the others we host. This means that someone would need to know
the URL or dataset name to be able to access your dataset. For example, this means
that someone would need the URL cells.ucsc.edu/?ds=cortex-dev or know the name
(cortex-dev) to access the dataset.
