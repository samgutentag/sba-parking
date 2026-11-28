#!/usr/bin/env bash
# Renders the home-screen icons and link-preview card in public/ from tools/*.html with
# headless Chrome. Rerun after editing either source.
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
render() { # source, output, width, height
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="$3,$4" --screenshot="$2" "file://$PWD/$1" >/dev/null 2>&1
  echo "wrote $2"
}
render tools/icon.html public/icon-512.png 512 512
# Smaller sizes are scaled down from the 512 rather than rendered, so the P keeps its proportions.
sips -z 192 192 public/icon-512.png --out public/icon-192.png >/dev/null && echo "wrote public/icon-192.png"
sips -z 180 180 public/icon-512.png --out public/apple-touch-icon.png >/dev/null && echo "wrote public/apple-touch-icon.png"
render tools/og-card.html public/og.png 1200 630
