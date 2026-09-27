#!/usr/bin/env bash
# Assemble the app bundle for Capacitor (webDir=dist): the site's own build,
# plus the data layers the APK carries so a first launch works offline.
set -euo pipefail
cd "$(dirname "$0")/.."

# Which build this is, baked into the code (vite.config.ts `define`) so the
# About box can say which build is running rather than which the server has.
# A page can be a cached older copy, and that is exactly when the difference
# matters. They used to be substituted into app.js with sed afterwards, which
# once escaped badly and turned app.js into a syntax error that every step
# reported as a success.
BUILD_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export APP_VERSION="${APP_VERSION:-dev}" BUILD_COMMIT BUILD_TIME

# the same build the site deploys: every page, bundled, with MapLibre vendored
# and the service worker's precache list written and checked (npm run build)
npm run build

# DATA_DIR: the native test suite bundles the pinned test snapshot instead
cp -r "${DATA_DIR:-data}" dist/data
# routing is tiled now (data/tiles/*.json); the monolithic graph is unused
rm -f dist/data/graph.json

# app build version (git tag in CI; "dev" locally) for the in-app updater
printf '{"version": "%s"}\n' "$APP_VERSION" > dist/version.json
printf '{"version":"%s","built":"%s","commit":"%s"}\n' \
  "$APP_VERSION" "$BUILD_TIME" "$BUILD_COMMIT" > dist/build.json
echo "build stamp: $APP_VERSION $BUILD_TIME $BUILD_COMMIT"
echo "assembled dist/ ($(du -sh dist | cut -f1))"
