#!/usr/bin/env bash
# Turn the live-data check's result into something a person will see.
#
# A failing scheduled workflow is an email that gets read once and then filtered.
# An open issue stays until the data is fixed and closes itself when it is, so
# "the site is serving a stale analysis" cannot sit unnoticed for a week again.
#
# Reads: OUTCOME (success|failure), /tmp/health.txt (the check's output).
# In a shell script rather than inline YAML because the issue body is multi-line
# markdown, and dedenting that inside a YAML block scalar is how it breaks.
set -euo pipefail

TITLE="Live data health check is failing"
OUT="${OUTCOME:-unknown}"
REPORT="/tmp/health.txt"

existing=$(gh issue list --state open --search "$TITLE in:title" \
             --json number -q '.[0].number' 2>/dev/null || true)

if [ "$OUT" != "failure" ]; then
  if [ -n "$existing" ]; then
    gh issue close "$existing" --comment "The live data checks out again."
    echo "closed #$existing — live data is healthy"
  else
    echo "live data is healthy"
  fi
  exit 0
fi

body=$(mktemp)
{
  echo "The deployed site's data does not match what the code claims:"
  echo
  echo '```'
  cat "$REPORT" 2>/dev/null || echo "(the check produced no output)"
  echo '```'
  echo
  echo "Reproduce with:"
  echo
  echo '```'
  echo "python3 scripts/check-live-data.py"
  echo '```'
  echo
  echo "The usual cause is a data snapshot published from a stale local build over"
  echo "the one CI made. \`scripts/publish-data.sh\` refuses that now, but a snapshot"
  echo "published before that guard existed will still be live until the next"
  echo "refresh replaces it."
} > "$body"

if [ -n "$existing" ]; then
  gh issue comment "$existing" --body-file "$body"
  echo "commented on #$existing"
else
  gh issue create -t "$TITLE" --body-file "$body"
fi
