#!/bin/bash
# Generates a content hash from web assets and injects it into sw.js.
# Run before deploying to GitHub Pages:
#   bash build-sw.sh
#
# The hash changes whenever app files change,
# which triggers a Service Worker update in the browser.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Hash aus den App-Dateien berechnen (ohne sw.js selbst)
HASH=$(cat index.html app.js chart.min.js | sha256sum | cut -c1-8)

# BUILD_HASH in sw.js ersetzen
sed -i "s/const BUILD_HASH = '.*'/const BUILD_HASH = '${HASH}'/" sw.js

echo "sw.js updated: BUILD_HASH = '${HASH}'"
