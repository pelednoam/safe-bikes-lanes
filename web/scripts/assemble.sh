#!/usr/bin/env bash
# Assemble the app bundle for Capacitor (webDir=dist): compiled JS, data
# layers, and a LOCAL copy of MapLibre so the APK works without the CDN.
set -euo pipefail
cd "$(dirname "$0")/.."

npx tsc
rm -rf dist
mkdir -p dist
cp index.html app.js router.js types.js nav.js rides.js hazards.js sharecard.js dist/
cp sw.js manifest.json icon-192.png icon-512.png dist/
cp -r data dist/data
cp node_modules/maplibre-gl/dist/maplibre-gl.js dist/
cp node_modules/maplibre-gl/dist/maplibre-gl.css dist/
# point the app build at the bundled MapLibre instead of unpkg
sed -i.bak \
  -e 's|https://unpkg.com/maplibre-gl@[0-9.]*/dist/maplibre-gl.css|maplibre-gl.css|' \
  -e 's|https://unpkg.com/maplibre-gl@[0-9.]*/dist/maplibre-gl.js|maplibre-gl.js|' \
  dist/index.html
rm -f dist/index.html.bak
echo "assembled dist/ ($(du -sh dist | cut -f1))"
