#!/usr/bin/env bash
# Turn the live-data check's result into something a person will see.
#
# A failing scheduled workflow is an email that gets read once and then filtered.
# An open issue stays until the data is fixed and closes itself when it is, so
# "the site is serving a stale analysis" cannot sit unnoticed for a week again.
#
# Reads: OUTCOME (success|failure) and the check's output file. Reused for more
# than one check, each with its own issue, so a broken map service and stale data
# are two problems a reader can tell apart, not one issue whose meaning flips:
#   TITLE    the issue title (one open issue per title)
#   REPORT   the check's output file
#   INTRO    the line above the output
#   REPRO    the command that reproduces it
#   HINT     what usually causes it (optional)
#   HEALTHY  the comment made when closing it
# In a shell script rather than inline YAML because the issue body is multi-line
# markdown, and dedenting that inside a YAML block scalar is how it breaks.
set -euo pipefail

TITLE="${TITLE:-Live data health check is failing}"
OUT="${OUTCOME:-unknown}"
REPORT="${REPORT:-/tmp/health.txt}"
# Defaults with an apostrophe live in their own variables: inside "${VAR:-…}",
# bash reads a ' as the start of a quoted string and never finds its end.
DEFAULT_INTRO="The deployed site's data does not match what the code claims:"
INTRO="${INTRO:-$DEFAULT_INTRO}"
REPRO="${REPRO:-python3 scripts/check-live-data.py}"
HEALTHY="${HEALTHY:-The live data checks out again.}"
DEFAULT_HINT="The usual cause is a data snapshot published from a stale local build over
the one CI made. \`scripts/publish-data.sh\` refuses that now, but a snapshot
published before that guard existed will still be live until the next
refresh replaces it."
HINT="${HINT-$DEFAULT_HINT}"

existing=$(gh issue list --state open --search "$TITLE in:title" \
             --json number -q '.[0].number' 2>/dev/null || true)

if [ "$OUT" != "failure" ]; then
  if [ -n "$existing" ]; then
    gh issue close "$existing" --comment "$HEALTHY"
    echo "closed #$existing — $TITLE: healthy again"
  else
    echo "all clear — no open \"$TITLE\" issue"
  fi
  exit 0
fi

body=$(mktemp)
{
  echo "$INTRO"
  echo
  echo '```'
  cat "$REPORT" 2>/dev/null || echo "(the check produced no output)"
  echo '```'
  echo
  echo "Reproduce with:"
  echo
  echo '```'
  echo "$REPRO"
  echo '```'
  if [ -n "$HINT" ]; then
    echo
    echo "$HINT"
  fi
} > "$body"

if [ -n "$existing" ]; then
  gh issue comment "$existing" --body-file "$body"
  echo "commented on #$existing"
else
  gh issue create -t "$TITLE" --body-file "$body"
fi
