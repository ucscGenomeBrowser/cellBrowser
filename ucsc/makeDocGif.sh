#!/usr/bin/env bash
# Build an animated documentation GIF from a "scene" module.
#
#   ucsc/makeDocGif.sh <scene>            # scene name under ucsc/docGif/scenes/, or a path
#   ucsc/makeDocGif.sh --list            # list available scenes
#
# Records the scene with headless Chromium (ucsc/docGif/record.cjs), trims the
# page-load dead-time, and assembles an optimized GIF into docs/images/<name>.gif.
#
# This is a maintainer tool for regenerating the animated help figures. It reuses
# Playwright's browser cache (chromium + bundled ffmpeg) under ~/.cache/ms-playwright,
# which is present on hgwdev, and ImageMagick's `convert` from the PATH. See the
# cellbrowser-docs skill / docs contributor notes for the full pipeline rationale.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SCENE_DIR="$HERE/docGif/scenes"
IMG_DIR="$REPO/docs/images"
WORK="${TMPDIR:-/tmp}/cbgif.$$"
CACHE="$HOME/.cache/ms-playwright"

if [[ "${1:-}" == "--list" || -z "${1:-}" ]]; then
    echo "Available scenes (ucsc/docGif/scenes/):"
    ls "$SCENE_DIR"/*.cjs 2>/dev/null | xargs -n1 basename | sed 's/\.cjs$//' | sed 's/^/  /'
    [[ -z "${1:-}" ]] && { echo; echo "Usage: $0 <scene>"; exit 1; }
    exit 0
fi

# Resolve the scene module: a bare name maps into scenes/, otherwise treat as a path.
ARG="$1"
if [[ -f "$SCENE_DIR/$ARG.cjs" ]]; then
    SCENE="$SCENE_DIR/$ARG.cjs"
elif [[ -f "$ARG" ]]; then
    SCENE="$ARG"
else
    echo "error: no scene '$ARG' (looked in $SCENE_DIR/$ARG.cjs and as a path)" >&2
    exit 1
fi

# Locate the cached Chromium and the bundled (stripped) ffmpeg.
CHROME="$(ls "$CACHE"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1 || true)"
FF="$(ls "$CACHE"/ffmpeg-*/ffmpeg-linux 2>/dev/null | sort | tail -1 || true)"
if [[ -z "$CHROME" ]]; then
    echo "error: no cached Chromium under $CACHE. Install with: npx playwright install chromium" >&2
    exit 1
fi
if [[ -z "$FF" ]]; then
    echo "error: no bundled ffmpeg under $CACHE (comes with a Playwright browser install)" >&2
    exit 1
fi

# Ensure playwright-core is resolvable; bootstrap into a cache dir if not, without
# re-downloading browsers (we use the cached Chromium above).
PW_DIR="$CACHE/npm-playwright-core"
if ! NODE_PATH="$PW_DIR/node_modules" node -e "require.resolve('playwright-core')" >/dev/null 2>&1 \
     && ! node -e "require.resolve('playwright-core')" >/dev/null 2>&1; then
    echo "playwright-core not found; installing into $PW_DIR ..."
    mkdir -p "$PW_DIR"
    ( cd "$PW_DIR" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright-core >/dev/null )
fi
export NODE_PATH="$PW_DIR/node_modules:${NODE_PATH:-}"

mkdir -p "$WORK" "$IMG_DIR"
trap 'rm -rf "$WORK"' EXIT

# 1. Record the webm.
echo "Recording scene: $SCENE"
CHROME="$CHROME" OUT="$WORK" SCENE="$SCENE" node "$HERE/docGif/record.cjs"

NAME="$(node -e "console.log(require('$WORK/'+require('fs').readdirSync('$WORK').find(f=>f.endsWith('.meta.json'))).name)")"
read -r TRIM WIDTH FUZZ DELAY < <(node -e "
  const m=require('$WORK/$NAME.meta.json'); console.log(m.trim, m.width, m.fuzz, m.delay);")

# 2. Extract frames, dropping the leading render dead-time.
echo "Extracting frames (trim ${TRIM}s, ${WIDTH}px) ..."
mkdir -p "$WORK/frames"
"$FF" -y -ss "$TRIM" -i "$WORK/$NAME.webm" -r 12 -vf "scale=$WIDTH:-1" "$WORK/frames/f_%04d.png" 2>/dev/null

# 3. Assemble + optimize the GIF.
echo "Assembling GIF ..."
convert -delay "$DELAY" -loop 0 "$WORK/frames/f_"*.png -fuzz "${FUZZ}%" -layers Optimize +map "$IMG_DIR/$NAME.gif"

BYTES="$(stat -c%s "$IMG_DIR/$NAME.gif")"
SIZE="$(du -h "$IMG_DIR/$NAME.gif" | cut -f1)"
DIM="$(identify -format '%wx%h' "$IMG_DIR/$NAME.gif[0]")"
echo
echo "Wrote $IMG_DIR/$NAME.gif  ($DIM, $SIZE)"
# A blank recording (slow/failed page render) optimizes to a few hundred bytes.
if (( BYTES < 20000 )); then
    echo "WARNING: $NAME.gif is only $BYTES bytes — the recording was probably blank." >&2
    echo "         Re-run: $0 $ARG" >&2
    exit 1
fi
