#!/usr/bin/env bash
# Cut this region's basemap out of Protomaps' daily planet build and publish it
# as one file, basemap.pmtiles, on the `basemap` release. The site deploy copies
# it to the site root, and the map reads tiles out of it by byte range.
#
# Before this, the map came from Carto's servers: a third party that could
# rate-limit us, change its terms, or stamp "API key required" across every
# tile, which is what happened (found by users, not by monitoring). The file is
# the region's streets, water, parks and labels to zoom 14, the same zoom Carto
# served (MapLibre overzooms past it), about 45 MB.
#
# Run monthly by .github/workflows/basemap.yml; streets don't move faster than
# that. Locally: GH_TOKEN=... scripts/publish-basemap.sh (or DRY_RUN=1 to only
# build it into ./basemap.pmtiles).
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="basemap"
OUT="${OUT:-basemap.pmtiles}"
MAXZOOM=14
# The pmtiles tool, pinned by version and hash: this script can publish.
PMTILES_VERSION="1.31.2"
PMTILES_TGZ="go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz"
PMTILES_SHA256="3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f"

TOOLS=$(mktemp -d)
trap 'rm -rf "$TOOLS"' EXIT
curl -sSL --fail -o "$TOOLS/$PMTILES_TGZ" \
  "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${PMTILES_TGZ}"
echo "$PMTILES_SHA256  $TOOLS/$PMTILES_TGZ" | sha256sum -c --status || {
  echo "::error::the pmtiles tool doesn't match its pinned sha256"; exit 1; }
tar xzf "$TOOLS/$PMTILES_TGZ" -C "$TOOLS" pmtiles
PMTILES="$TOOLS/pmtiles"

# the newest daily build Protomaps lists
BUILD=$(curl -sSL --fail https://build-metadata.protomaps.dev/builds.json |
  python3 -I -S -c "import json,sys; print(sorted(b['key'] for b in json.load(sys.stdin))[-1])")
# the routing area, with a margin so the map doesn't end at the edge of the data
BBOX=$(python3 -I -S -c "
import sys; sys.path.insert(0, 'pipeline'); import config
m = 0.05
print(','.join(f'{v:.3f}' for v in (config.BBOX_WEST - m, config.BBOX_SOUTH - m, config.BBOX_EAST + m, config.BBOX_NORTH + m)))
")
echo "basemap: Protomaps $BUILD, bbox $BBOX, to zoom $MAXZOOM"
"$PMTILES" extract "https://build.protomaps.com/$BUILD" "$OUT" --bbox="$BBOX" --maxzoom=$MAXZOOM

# It is what it should be before anything serves it: vector tiles, the zooms
# asked for, and not implausibly small (a failed extract can still write a file).
SHOW=$("$PMTILES" show "$OUT")
echo "$SHOW" | grep -q "tile type: mvt" || { echo "::error::basemap is not vector tiles"; exit 1; }
echo "$SHOW" | grep -q "max zoom: $MAXZOOM" || { echo "::error::basemap doesn't reach zoom $MAXZOOM"; exit 1; }
BYTES=$(stat -c %s "$OUT")
[ "$BYTES" -gt 20000000 ] || { echo "::error::basemap is only $BYTES bytes"; exit 1; }
SHA=$(sha256sum "$OUT" | cut -c1-64)
printf '{"build":"%s","bbox":"%s","maxzoom":%d,"bytes":%d,"sha256":"%s"}\n' \
  "$BUILD" "$BBOX" "$MAXZOOM" "$BYTES" "$SHA" > "${OUT%.pmtiles}.json"
echo "basemap: $(du -h "$OUT" | cut -f1), sha256 $SHA"

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: not publishing"
  exit 0
fi
# a prerelease, never "latest": the app's updater reads releases/latest
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" \
  --latest=false --prerelease \
  -t "Basemap" \
  -n "This region's basemap (streets, water, parks, labels) cut from Protomaps' daily OpenStreetMap build, refreshed monthly by scripts/publish-basemap.sh. The site serves it as basemap.pmtiles."
gh release upload "$TAG" "$OUT" "${OUT%.pmtiles}.json" --clobber
echo "published basemap.pmtiles ($BUILD) to the $TAG release"
