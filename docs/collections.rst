Dataset Hierarchies
-------------------

The Cell Browser allows you to group related datasets into a hierarchy, where
datasets are grouped into collections, like files are grouped into directories. 
When you open a collection, it will show you all of the datasets within it.

This requires your datasets to be arranged in directories on disk. Let's say
you have two directories with data files, one in directory ``data1`` and one in
directory ``data2``, each with their own cellbrowser.conf files, then these
two directories must be both subdirectories of a parent directoryn
named e.g. ``dataParent``. The names of all the datasets
are the names of their directories, not the names 
specified via the ``name`` statement in their ``cellbrowser.conf`` files anymore.
Specified names from cellbrowser.conf are ignored when dataset hierarchies are used
and are replaced with their directory names.

To enable dataset hierarchies, you only have to add a single line pointing to
the top-level parent directory where all of your single-cell data lives. 
Add a statement like the following to your ``~/.cellbrowser.conf``::

    dataRoot='/celldata/'

Alternatively, ``dataRoot`` can be set using the ``CBDATAROOT`` environment variable::

    export CBDATAROOT='/celldata/'

Then, create a "stub" cellbrowser.conf into this directory, it should only contain
a single line like ``shortLabel="some description"``. 
You can describe your collection as discussed under the **Describing
datasets** section. Put the ``desc.conf`` file into the same directory as the
``cellbrowser.conf`` you just created.
Define at least the statements ``title`` and ``description``.  They will be
shown at the top of your dataset list. This directory can be called the
top-level collection.

Arrange your dataset directories under this directory. You can add empty directories,
which will become collections, by creating dataset directories in them and put a
``cellbrowser.conf`` and ``desc.conf`` into it, e.g. like this::

   mkdir -p /celldata/organoids
   cd /celldata/organoids
   echo 'name="organoids"' > cellbrowser.conf
   echo 'shortLabel="Brain Organoids"' >> cellbrowser.conf
   echo 'tags=["10x"]' >> cellbrowser.conf

Now you can run ``cbBuild`` in each subdirectory of a collection.
in the collection.  Or you can rebuild in all subdirectories using ``cbBuild
-r``.

If you view the cell browser now using a web browser, you should see this new
collection present. When viewing a dataset in a collection, you
can move quickly to any other dataset in the same collection using the
"Collection" dropdown menu in the toolbar.


Showing one dataset in more than one collection
-----------------------------------------------

A dataset normally appears in exactly one collection, the directory it lives
in. Sometimes the same dataset genuinely belongs in two places: an atlas
organised by brain region where one of the regions was already published as its
own separate collection, or a single reference dataset that several collections
want to point at. Copying the input files a second time can mean tens or
hundreds of gigabytes on disk and a second import for no benefit.

The ``links`` statement in a collection's ``cellbrowser.conf`` lets a collection
show a dataset that lives elsewhere in the tree::

    shortLabel = "SEA-AD"
    links = ["sea-ad-mtg/cohort"]

Each entry is the dataset's name, which is its path relative to the top-level
collection, the same string that appears as ``name`` in that dataset's own
``dataset.json``. Nothing is copied and nothing is symlinked: the collection's
dataset list simply gains an extra entry that points at the real location.
Linked datasets are marked with a small arrow in the dataset list, so that
readers can tell they belong somewhere else as well.

You can link either a single dataset or a whole collection.

To give the dataset a different label in this collection, or to control where it
appears in the list, use a dictionary instead of a string::

    links = [
        {"name" : "sea-ad-mtg/cohort", "shortLabel" : "Middle temporal gyrus (MTG)", "priority" : 5},
    ]

A label that made sense in the dataset's own collection is often wrong in the
borrowing one, so ``shortLabel`` is usually worth setting. ``priority`` works
the same way as it does for a normal dataset: links and real subdirectories are
sorted together by priority, defaulting to 10, so a link can sit anywhere in the
list rather than being stuck at the end. Any other setting you put in the
dictionary overrides the linked dataset's own value.

Two things to keep in mind:

* **A link target must be built before the collection that links to it.** The
  link is resolved by reading the target's ``dataset.json``, so that file has to
  exist already. ``cbBuild`` stops with an error naming the missing file if it
  does not. With ``cbBuild -r`` over a whole tree, build the target's collection
  first.
* **A linked dataset still belongs to its own collection.** Its "Collection"
  dropdown and its back link lead to the collection it really lives in, not to
  the one you reached it through. If a linked dataset sets
  ``visibility = "hide"``, it stays hidden and ``cbBuild`` prints a warning
  saying so.

A collection cannot link to itself or to one of its own subdirectories, since
that would show the same dataset twice.
