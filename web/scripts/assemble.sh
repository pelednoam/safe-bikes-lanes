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
# the where-to-build workspace: its own page, but the app links to it from the
# planner layers, so it has to be in the bundle or that link dead-ends offline
cp build.css dist/
cp -r build dist/build
cp -r fonts dist/fonts
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

# The same facts baked into the code, so the About box can say which build is
# running rather than which build the server has. A page can be a cached older
# copy, and that is exactly when the difference matters.
BUILD_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"version":"%s","built":"%s","commit":"%s"}\n' \
  "${APP_VERSION:-dev}" "$BUILD_TIME" "$BUILD_COMMIT" > dist/build.json
# Three plain tokens. Substituting JSON here escaped badly — sed reads \" in a
# replacement as an escape, so the backslashes disappeared and app.js became a
# syntax error that broke the whole app while every step reported success.
sed -i.bak \
  -e "s|__BUILD_VERSION__|${APP_VERSION:-dev}|" \
  -e "s|__BUILD_TIME__|$BUILD_TIME|" \
  -e "s|__BUILD_COMMIT__|$BUILD_COMMIT|" \
  dist/app.js
rm -f dist/app.js.bak
if grep -q "__BUILD_VERSION__\|__BUILD_COMMIT__" dist/app.js; then
  echo "build stamp not substituted"; exit 1
fi
# And the result is still JavaScript. The escaping bug above passed every check
# there was, because "the placeholder is gone" says nothing about what replaced it.
node --check dist/app.js || { echo "the stamp substitution broke app.js"; exit 1; }
echo "build stamp: ${APP_VERSION:-dev} $BUILD_TIME $BUILD_COMMIT"
echo "assembled dist/ ($(du -sh dist | cut -f1))"
