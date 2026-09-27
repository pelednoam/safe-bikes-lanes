#!/usr/bin/env bash
# Fetch and unpack the pinned test snapshot (test-data.json) into
# test-data/data, which the browser suites serve as /data/ (testserver.py
# --data). Idempotent: does nothing when the pinned snapshot is already there.
#
# TEST_DATA_TARBALL=path/to.tar.gz uses a local file instead of downloading
# (it must still match the pinned sha256).
set -euo pipefail
cd "$(dirname "$0")/.."

field() { python3 -c "import json,sys; print(json.load(open('test-data.json'))[sys.argv[1]])" "$1"; }
RELEASE=$(field release)
ASSET=$(field asset)
SHA=$(field sha256)
REPO=${GITHUB_REPOSITORY:-pelednoam/safe-bikes-lanes}

mkdir -p test-data
if [ -f test-data/.unpacked ] && [ "$(cat test-data/.unpacked)" = "$SHA" ]; then
  echo "test data: $ASSET already unpacked"
  exit 0
fi

TARBALL="test-data/$ASSET"
if [ -n "${TEST_DATA_TARBALL:-}" ]; then
  cp "$TEST_DATA_TARBALL" "$TARBALL"
elif [ ! -f "$TARBALL" ] || ! echo "$SHA  $TARBALL" | sha256sum -c --status; then
  URL="https://github.com/$REPO/releases/download/$RELEASE/$ASSET"
  echo "test data: downloading $URL"
  for i in 1 2 3; do
    curl -sL --fail -o "$TARBALL" "$URL" && break
    echo "download failed (attempt $i), retrying in 10s"; sleep 10
  done
fi
# the pin is the hash, not the name: a re-uploaded asset under the same name
# would otherwise change what every test runs on without a commit saying so
if ! echo "$SHA  $TARBALL" | sha256sum -c --status; then
  echo "::error::test data $ASSET does not match the sha256 pinned in test-data.json"
  exit 1
fi
rm -rf test-data/data
tar xzf "$TARBALL" -C test-data
# hand-maintained config the tarball deliberately leaves out
cp data/keys.json test-data/data/keys.json
echo "$SHA" > test-data/.unpacked
echo "test data: unpacked $ASSET (built $(field built))"
