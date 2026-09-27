"""Stamp a data snapshot with what it contains and when it was made.

Adds two fields to DATA_DIR/meta.json:
  version   a hash of every data file's contents (not meta.json itself or the
            hand-maintained keys.json): the same data gets the same version
            however often it's rebuilt
  builtAt   when it was stamped, to the second (UTC)

The app used to tell data builds apart by meta.json's `built`, a calendar
date. Phones cache the site's data per build (web/src/data.ts), so a second
rebuild on the same day had the same name as the first and never reached a
phone that already held the first. The native app now uses the site's data
when its version differs from the bundle's and its builtAt is later, and caches
it per version. `built` stays, for people to read.

Run by scripts/publish-data.sh just before it packs web/data: the last of the
pipeline's steps (ranking, city pages) write after export_web.py, so only then
is the snapshot complete. Standard library only, like the checks around it.

Usage: python3 pipeline/stamp_version.py [DATA_DIR]   (default web/data)
"""

from __future__ import annotations

import datetime
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Final

# Not part of what the data says: the stamp itself, and hand-kept config the
# published tarball leaves out anyway.
UNHASHED: Final[frozenset[str]] = frozenset({"meta.json", "keys.json"})


def content_version(data_dir: Path) -> str:
    """16 hex characters that change when any data file's name or bytes do."""
    whole = hashlib.sha256()
    for path in sorted(p for p in data_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(data_dir).as_posix()
        if rel in UNHASHED:
            continue
        whole.update(rel.encode())
        whole.update(b"\0")
        whole.update(hashlib.sha256(path.read_bytes()).digest())
    return whole.hexdigest()[:16]


def stamp(data_dir: Path, now: datetime.datetime | None = None) -> dict[str, Any]:
    """Write version and builtAt into data_dir/meta.json and return the result."""
    meta_path = data_dir / "meta.json"
    meta: dict[str, Any] = json.loads(meta_path.read_text())
    meta["version"] = content_version(data_dir)
    meta["builtAt"] = (now or datetime.datetime.now(datetime.UTC)).isoformat(timespec="seconds")
    meta_path.write_text(json.dumps(meta, indent=1) + "\n")
    return meta


def main(argv: list[str]) -> int:
    data_dir = Path(argv[1]) if len(argv) > 1 else Path("web/data")
    meta = stamp(data_dir)
    print(f"stamped {data_dir}/meta.json: version {meta['version']}, builtAt {meta['builtAt']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
