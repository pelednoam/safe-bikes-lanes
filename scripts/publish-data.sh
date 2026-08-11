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

# This asset is the site's data, and uploading it is a clobber — so a local
# publish can discard what CI built hours earlier. That is exactly what happened
# on 2026-08-10: the weekly refresh built 6,066 candidates with real crash counts
# at 07:15 UTC, and a manual publish at 13:50 replaced it with a local build from
# a graph predating the crash-count write-back. The site then served an analysis
# whose crash criterion rested on a derived proxy, and nothing reported it.
#
# So: refuse to publish a snapshot the analysis itself would refuse to read, and
# say plainly when a local build is about to overwrite CI's.
if ! python3 - <<'CHECK'
import json, pathlib, sys
meta = pathlib.Path("web/data/priorities_meta.json")
if not meta.exists():
    print("  (no priorities_meta.json in web/data — skipping the ranking check)")
    sys.exit(0)
m = json.loads(meta.read_text())
provenance = m.get("provenance") or {}
problems = []
if provenance.get("graph_edge_schema") is None:
    problems.append(
        "priorities_meta.json carries no provenance.graph_edge_schema — built from"
        " an unstamped graph, i.e. by a build_graph.py older than this check"
    )
if provenance.get("crashes_joined") == 0:
    problems.append(
        "the graph this was built from joined 0 bike crashes, so the crash"
        " criterion would be published resting on nothing"
    )
for problem in problems:
    print(f"  {problem}")
sys.exit(1 if problems else 0)
CHECK
then
  if [ "${FORCE:-}" = "1" ]; then
    echo "publishing anyway (FORCE=1)"
  else
    echo "refusing to publish. Re-run the pipeline from build_graph.py, or set FORCE=1."
    exit 1
  fi
fi

if [ -z "${GITHUB_ACTIONS:-}" ]; then
  echo "note: publishing a LOCAL build. CI publishes this asset every Monday;"
  echo "      whatever it built will be replaced by what is in web/data now."
fi

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

# Redeploy against what was just uploaded. Publishing and pushing are separate
# steps, so whichever happens second has to be the one that triggers the build —
# otherwise a deploy started by the push races the upload and ships the old data.
if [ "${NO_DEPLOY:-}" = "1" ]; then
  echo "NO_DEPLOY=1 — not triggering a Pages deploy"
elif gh workflow run pages.yml; then
  echo "triggered a Pages deploy against the new snapshot"
else
  # Not a warning. The upload has already happened, so the published data and
  # the live site now disagree, and that is the state this script exists to
  # avoid. Say why (the error is no longer swallowed) and exit non-zero.
  echo "::error::uploaded the snapshot but could not trigger the deploy." \
       "The live site is now serving older data. Run: gh workflow run pages.yml"
  exit 1
fi
