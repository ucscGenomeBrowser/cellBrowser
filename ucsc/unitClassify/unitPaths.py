"""
Shared path handling for the unit-classification scripts.

The working TSVs (units_audit.tsv and the classifier outputs) are data, not
source, so they must not be written into this checkout. Every script therefore
takes a work directory and resolves its bare filenames inside it.

Precedence for the work directory: --dir, then $CBUNITS_DIR, then the current
directory. An absolute path passed to any individual file option always wins.
"""

import os
import sys

DEFAULT_HTDOCS = "/usr/local/apache/htdocs-cells"


def add_common_args(parser):
    "Add the --dir and --htdocs options shared by all the scripts."
    parser.add_argument("--dir", default=os.environ.get("CBUNITS_DIR", "."),
        help="directory holding the working TSVs, read and written "
             "(default: $CBUNITS_DIR, else the current directory)")
    parser.add_argument("--htdocs", default=DEFAULT_HTDOCS,
        help="Cell Browser htdocs tree to read dataset.json/desc.json from "
             "(default: %(default)s)")
    return parser


def resolve(path, workdir):
    "Absolute paths pass through unchanged; bare filenames land in workdir."
    if not path or os.path.isabs(path):
        return path
    return os.path.join(workdir, path)


def check_workdir(workdir):
    """Warn if the work directory is inside this checkout.

    Running a script from the repo would otherwise leave several MB of
    regenerated TSVs sitting in git status, which is how they get committed by
    accident."""
    repo = os.path.dirname(os.path.abspath(__file__))
    if os.path.abspath(workdir).startswith(repo):
        sys.stderr.write(
            "Warning: writing working TSVs into the source tree (%s).\n"
            "         Pass --dir or set CBUNITS_DIR to a data directory.\n"
            % os.path.abspath(workdir))
