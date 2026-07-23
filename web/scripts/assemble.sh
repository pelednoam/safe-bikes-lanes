#!/usr/bin/env bash
# Assemble the app bundle for Capacitor (webDir=dist): compiled JS, data
# layers, and a LOCAL copy of MapLibre so the APK works without the CDN.
set -euo pipefail
cd "$(dirname "$0")/.."

npx tsc
rm -rf dist
mkdir -p dist
cp index.html ./*.js dist/
cp manifest.json icon-192.png icon-512.png dist/
cp -r data dist/data
# routing is tiled now (data/tiles/*.json); the monolithic graph is unused
rm -f dist/data/graph.json
cp node_modules/maplibre-gl/dist/maplibre-gl.js dist/
cp node_modules/maplibre-gl/dist/maplibre-gl.css dist/
# point the app build at the bundled MapLibre instead of unpkg
sed -i.bak \
  -e 's|https://unpkg.com/maplibre-gl@[0-9.]*/dist/maplibre-gl.css|maplibre-gl.css|' \
  -e 's|https://unpkg.com/maplibre-gl@[0-9.]*/dist/maplibre-gl.js|maplibre-gl.js|' \
  dist/index.html
rm -f dist/index.html.bak
# app build version (git tag in CI; "dev" locally) for the in-app updater
printf '{"version": "%s"}\n' "${APP_VERSION:-dev}" > dist/version.json
echo "assembled dist/ ($(du -sh dist | cut -f1))"
