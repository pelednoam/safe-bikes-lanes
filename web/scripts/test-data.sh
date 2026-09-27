#!/usr/bin/env bash
# Fetch the pinned test snapshot (test-data.json): the data build, unpacked
# into test-data/data, which the browser suites serve as /data/ (testserver.py
# --data), and the basemap, as test-data/basemap.pmtiles (testserver.py
# --basemap). Idempotent: does nothing for what is already there and matches.
#
# TEST_DATA_TARBALL=path/to.tar.gz and TEST_BASEMAP=path/to.pmtiles use local
# files instead of downloading (they must still match the pinned sha256s).
set -euo pipefail
cd "$(dirname "$0")/.."

field() { python3 -c "
import json, sys
v = json.load(open('test-data.json'))
for k in sys.argv[1:]: v = v[k]
print(v)" "$@"; }
RELEASE=$(field release)
REPO=${GITHUB_REPOSITORY:-pelednoam/safe-bikes-lanes}
mkdir -p test-data

# fetch ASSET SHA DEST [LOCAL]: DEST holds the pinned asset afterwards, or this fails
fetch() {
  local asset=$1 sha=$2 dest=$3 local_copy=${4:-}
  if [ -n "$local_copy" ]; then
    cp "$local_copy" "$dest"
  elif [ ! -f "$dest" ] || ! echo "$sha  $dest" | sha256sum -c --status; then
    local url="https://github.com/$REPO/releases/download/$RELEASE/$asset"
    echo "test data: downloading $url"
    for i in 1 2 3; do
      curl -sL --fail -o "$dest" "$url" && break
      echo "download failed (attempt $i), retrying in 10s"; sleep 10
    done
  fi
  # the pin is the hash, not the name: a re-uploaded asset under the same name
  # would otherwise change what every test runs on without a commit saying so
  if ! echo "$sha  $dest" | sha256sum -c --status; then
    echo "::error::test data $asset does not match the sha256 pinned in test-data.json"
    exit 1
  fi
}

# the basemap is served as is, so the file itself is the check
fetch "$(field basemap asset)" "$(field basemap sha256)" test-data/basemap.pmtiles "${TEST_BASEMAP:-}"
echo "test data: basemap $(field basemap asset)"

ASSET=$(field asset)
SHA=$(field sha256)
if [ -f test-data/.unpacked ] && [ "$(cat test-data/.unpacked)" = "$SHA" ]; then
  echo "test data: $ASSET already unpacked"
  exit 0
fi
fetch "$ASSET" "$SHA" "test-data/$ASSET" "${TEST_DATA_TARBALL:-}"
rm -rf test-data/data
tar xzf "test-data/$ASSET" -C test-data
# hand-maintained config the tarball deliberately leaves out
cp data/keys.json test-data/data/keys.json
echo "$SHA" > test-data/.unpacked
echo "test data: unpacked $ASSET (built $(field built))"
