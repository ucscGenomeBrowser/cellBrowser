#!/usr/bin/env bash
#
# previewDocs.sh - build the UCSC Cell Browser Sphinx docs and deploy them to
# the current user's ~/public_html so they can be previewed at a personal
# hgwdev URL. Whoever runs it gets the build in *their* public_html and a URL
# pointing at their own username.
#
# Usage:
#   previewDocs.sh              build the docs and deploy to ~/public_html, print the URL
#   previewDocs.sh --clean      remove the deployed preview from ~/public_html
#   previewDocs.sh -h|--help    show this help
#
set -euo pipefail

# ---------------------------------------------------------------- configuration
SUBDIR="cellbrowser-docs"        # directory name created under ~/public_html
HOST="hgwdev.gi.ucsc.edu"        # host that serves ~USER/public_html

# docs source dir is a sibling of this script's dir (ucsc/ and docs/ share a parent)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$(cd "$SCRIPT_DIR/../docs" && pwd)"
DEST="$HOME/public_html/$SUBDIR"
URL="https://$HOST/~$USER/$SUBDIR/"

usage() { sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------- argument handling
case "${1:-}" in
    -h|--help)
        usage
        exit 0
        ;;
    --clean)
        if [[ -d "$DEST" ]]; then
            rm -rf "$DEST"
            echo "Removed preview build: $DEST"
        else
            echo "Nothing to clean: $DEST does not exist"
        fi
        exit 0
        ;;
    "")
        ;;  # normal build, fall through
    *)
        echo "Unknown option: $1" >&2
        usage
        exit 1
        ;;
esac

# ---------------------------------------------------------------- find/bootstrap sphinx
# Prefer a system sphinx-build (with the RTD theme), then "python3 -m sphinx",
# and finally bootstrap a private venv so the script works with no manual setup.
SPHINX=""
if command -v sphinx-build >/dev/null 2>&1 && python3 -c 'import sphinx_rtd_theme' 2>/dev/null; then
    SPHINX="sphinx-build"
elif python3 -c 'import sphinx, sphinx_rtd_theme' 2>/dev/null; then
    SPHINX="python3 -m sphinx"
else
    VENV="$HOME/.cache/cellbrowser-docs-venv"
    if [[ ! -x "$VENV/bin/sphinx-build" ]]; then
        echo "Sphinx (with sphinx_rtd_theme) not found; bootstrapping a build venv at:"
        echo "    $VENV"
        python3 -m venv "$VENV"
        "$VENV/bin/pip" install --quiet --upgrade pip
        "$VENV/bin/pip" install --quiet sphinx sphinx_rtd_theme
    fi
    SPHINX="$VENV/bin/sphinx-build"
fi

# ---------------------------------------------------------------- build + deploy
echo "Building docs from: $DOCS_DIR"
mkdir -p "$HOME/public_html"
rm -rf "$DEST"
# -E: don't use a cached environment (fresh build); -b html: HTML output
# shellcheck disable=SC2086  # $SPHINX may be "python3 -m sphinx" (intentional word split)
$SPHINX -b html -E "$DOCS_DIR" "$DEST"

# make sure Apache can read the build and traverse into it
chmod a+rx "$HOME/public_html" 2>/dev/null || true
chmod -R a+rX "$DEST"

echo
echo "Preview ready at:"
echo "    $URL"
echo
echo "(Static one-off build. Re-run previewDocs.sh after editing the docs; use --clean to remove it.)"
