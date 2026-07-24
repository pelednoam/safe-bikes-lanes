#!/usr/bin/env bash
# Publish the generated map data (web/data: routing tiles, network tiles, and
# the overlay layers) as a GitHub release asset instead of committing it to
# git. Release assets live outside the git object store, so main stays
# code-only and clones don't carry hundreds of MB of regenerated JSON.
#
# keys.json is hand-maintained config (public Mapillary token), not generated
# data, so it's excluded here and stays tracked in git.
#
# Run this after a pipeline rebuild (fetch/build_graph/export_web). The Pages
# deploy (.github/workflows/pages.yml) downloads + extracts this tarball before
# building the site, and refresh-data.yml publishes it the same way from CI.
set -euo pipefail

cd "$(dirname "$0")/.."
TAG="data-snapshot"
TARBALL="/tmp/web-data.tar.gz"

[ -d web/data/tiles ] || { echo "web/data/tiles missing — run the pipeline first"; exit 1; }

tar czf "$TARBALL" -C web --exclude=data/keys.json data
SIZE=$(du -h "$TARBALL" | cut -f1)

# --latest=false --prerelease so this data release never becomes the repo's
# "latest" — the APK updater + Pages mirror key off releases/latest = app-v*.
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" \
  --latest=false --prerelease \
  -t "Map data snapshot" \
  -n "Generated web/data (routing + network tiles + map layers), published outside git history. Consumed by the Pages deploy."
gh release upload "$TAG" "$TARBALL" --clobber

echo "published web-data.tar.gz ($SIZE) to the '$TAG' release"
