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
# Coerced to an int here, not in the shell: a meta.json carrying a string or a
# null made `[ "$HAVE" -lt ... ]` print "integer expression expected" and then
# fall through to success, passing a snapshot it had not actually checked.
HAVE=$(python3 -c "
import json, pathlib
p = pathlib.Path('web/data/meta.json')
try:
    print(int(json.loads(p.read_text()).get('format', 0)))
except Exception:
    print(0)
")

# The city pages carry the same stamp, because they are the files whose fields
# the number actually promises. A meta.json refreshed without regenerating them
# (or the reverse) is the skew this check exists to catch.
CITY=$(python3 -c "
import json, pathlib
d = pathlib.Path('web/data/cities')
if not d.is_dir():
    print(-1)
else:
    stamps = []
    for p in d.glob('*.json'):
        if p.name == 'index.json':
            continue
        try:
            stamps.append(int(json.loads(p.read_text()).get('format', 0)))
        except Exception:
            stamps.append(0)
    print(min(stamps) if stamps else -1)
")

if [ "$CITY" != "-1" ] && [ "$CITY" -lt "$NEED" ]; then
  echo "::error::a city page in this snapshot is format $CITY, but this commit" \
       "needs $NEED. Regenerate them: python pipeline/city_pages.py, then" \
       "scripts/publish-data.sh."
  exit 1
fi

if [ "$HAVE" -lt "$NEED" ]; then
  echo "::error::the published map data is format $HAVE, but this commit needs $NEED." \
       "The data snapshot predates the code being deployed. Rebuild web/data if" \
       "needed, then run scripts/publish-data.sh and re-run this workflow."
  exit 1
fi
echo "data snapshot format $HAVE, city pages $CITY (this commit needs $NEED)"
