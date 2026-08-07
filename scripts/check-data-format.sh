#!/usr/bin/env bash
# Does the extracted data snapshot carry what this commit needs?
#
# web/data isn't in git; a deploy downloads it from the data-snapshot release.
# So a push can deploy code whose pages need fields the published snapshot
# doesn't have yet — which is exactly what happened on 2026-08-07, and which
# surfaced as an inscrutable Playwright failure eight minutes into the run.
# Run this straight after extracting, so the answer costs seconds and names the
# fix.
set -euo pipefail
cd "$(dirname "$0")/.."

NEED=$(python3 -c "import sys; sys.path.insert(0, 'pipeline'); import config; print(config.DATA_FORMAT)")
HAVE=$(python3 -c "
import json, pathlib
p = pathlib.Path('web/data/meta.json')
print(json.loads(p.read_text()).get('format', 0) if p.exists() else 0)
")

if [ "$HAVE" -lt "$NEED" ]; then
  echo "::error::the published map data is format $HAVE, but this commit needs $NEED." \
       "The data snapshot predates the code being deployed. Rebuild web/data if" \
       "needed, then run scripts/publish-data.sh and re-run this workflow."
  exit 1
fi
echo "data snapshot format $HAVE (this commit needs $NEED)"
