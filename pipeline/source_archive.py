"""Keep the last few copies of every data source, and fall back to one when a
source is down.

One unreachable source used to fail the weekly refresh (fetch.py exits 1 on
any failure, and must: building without a layer publishes a map that is
quietly wrong). On 2026-09-26 Somerville's GIS server was down all day, and
the fix was a single hand-committed copy of one layer. This makes that the
rule for every source. Each weekly refresh archives what it fetched, and when a
fetch fails, the newest archived copy stands in, provided it is no older than
that source allows (config.SOURCE_MAX_STALE_DAYS). A time-sensitive source
like street permits allows days; a layer the city revises once a year allows
months. Past the limit, the refresh fails, as it should.

The archive is a GitHub release, `source-archive`, never "latest". Assets are
named <source>.<YYYY-MM-DD>.gz: the source's GeoJSON, gzipped, dated by when it
was fetched from its publisher. Reading needs no token (the repository is
public). Writing happens only in the refresh's publish step, which holds one,
through `gh`, and keeps KEEP copies per source.

Standard library only: it runs as `python3 -I -S` in the step that holds the
token, like the other publish-time checks.

Usage (refresh-data.yml, after publishing):
  python3 -I -S pipeline/source_archive.py upload [RAW_DIR]
"""

from __future__ import annotations

import datetime
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

REPO: Final[str] = os.environ.get("GITHUB_REPOSITORY", "pelednoam/safe-bikes-lanes")
TAG: Final[str] = "source-archive"
KEEP: Final[int] = 3
ASSET: Final[re.Pattern[str]] = re.compile(
    r"^(?P<name>[\w.-]+\.geojson)\.(?P<date>\d{4}-\d{2}-\d{2})\.gz$"
)
# A sidecar written for a copy taken from here says so, and is not archived again.
ARCHIVED_MARK: Final[str] = "archived copy of "


@dataclass(frozen=True)
class Copy:
    name: str
    retrieved: datetime.date
    url: str
    asset_id: int


def _get_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


class NoArchive(LookupError):
    """The archive release doesn't exist yet: a first run, not a failure."""


def _release(get_json: Callable[[str], Any]) -> Any:
    try:
        return get_json(f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise NoArchive(TAG) from e
        raise


def list_copies(get_json: Callable[[str], Any] = _get_json) -> list[Copy]:
    """Every archived copy, or none if the archive doesn't exist yet.

    Only a missing release is "none". Any other failure to ask (a rate limit, the
    network) is raised: read as "no archive", it made upload() create a release
    that already exists, which fails, and failed the refresh's archive step."""
    try:
        release = _release(get_json)
    except NoArchive:
        return []
    copies: list[Copy] = []
    page = 1
    while True:
        assets = get_json(
            f"https://api.github.com/repos/{REPO}/releases/{release['id']}/assets?per_page=100&page={page}"
        )
        for a in assets:
            m = ASSET.match(a["name"])
            if m is None:
                continue
            copies.append(
                Copy(
                    name=m["name"],
                    retrieved=datetime.date.fromisoformat(m["date"]),
                    url=a["browser_download_url"],
                    asset_id=int(a["id"]),
                )
            )
        if len(assets) < 100:
            return copies
        page += 1


def newest(copies: list[Copy], name: str) -> Copy | None:
    mine = [c for c in copies if c.name == name]
    return max(mine, key=lambda c: c.retrieved) if mine else None


def download(copy: Copy) -> dict[str, Any]:
    with urllib.request.urlopen(copy.url, timeout=300) as r:
        data: dict[str, Any] = json.loads(gzip.decompress(r.read()))
    return data


def fallback(
    name: str,
    max_age_days: int,
    today: datetime.date,
    copies: list[Copy] | None = None,
    fetch: Callable[[Copy], dict[str, Any]] = download,
) -> tuple[dict[str, Any], Copy] | None:
    """The newest archived copy of `name` no older than `max_age_days`, or None."""
    copy = newest(list_copies() if copies is None else copies, name)
    if copy is None or (today - copy.retrieved).days > max_age_days:
        return None
    data = fetch(copy)
    # an empty copy is no stand-in for a layer
    if not data.get("features"):
        return None
    return data, copy


def fresh_sources(raw_dir: Path) -> list[tuple[Path, datetime.date]]:
    """Sources fetched from their publishers (not from here), with the date."""
    fresh: list[tuple[Path, datetime.date]] = []
    for sidecar in sorted(raw_dir.glob("*.geojson.meta.json")):
        meta = json.loads(sidecar.read_text())
        if str(meta.get("source", "")).startswith(ARCHIVED_MARK):
            continue
        data = sidecar.with_name(sidecar.name.removesuffix(".meta.json"))
        if data.exists():
            fresh.append((data, datetime.date.fromisoformat(str(meta["retrieved"])[:10])))
    return fresh


def to_prune(copies: list[Copy], keep: int = KEEP) -> list[Copy]:
    """All but the newest `keep` copies of each source."""
    by_name: dict[str, list[Copy]] = {}
    for c in copies:
        by_name.setdefault(c.name, []).append(c)
    old: list[Copy] = []
    for mine in by_name.values():
        old += sorted(mine, key=lambda c: c.retrieved, reverse=True)[keep:]
    return old


def _gh(*args: str) -> None:
    subprocess.run(["gh", *args], check=True)


def upload(raw_dir: Path) -> None:
    """Archive what this refresh fetched, then keep only the newest KEEP of each."""
    try:
        _release(_get_json)
        exists = True
    except NoArchive:
        exists = False
    have = {(c.name, c.retrieved) for c in list_copies()} if exists else set()
    if not exists:
        _gh(
            "release", "create", TAG, "--repo", REPO, "--latest=false", "--prerelease",
            "--title", "Source archive",
            "--notes", "The last few copies of every data source, fetched by the weekly "
            "refresh. pipeline/source_archive.py stands one in when its source is down.",
        )  # fmt: skip
    with tempfile.TemporaryDirectory() as tmp:
        for data, day in fresh_sources(raw_dir):
            if (data.name, day) in have:
                continue
            gz = Path(tmp) / f"{data.name}.{day.isoformat()}.gz"
            gz.write_bytes(gzip.compress(data.read_bytes(), compresslevel=9))
            _gh("release", "upload", TAG, str(gz), "--repo", REPO, "--clobber")
            print(f"  archived {gz.name} ({gz.stat().st_size / 1e6:.1f} MB)")
    for old in to_prune(list_copies()):
        _gh("api", "-X", "DELETE", f"repos/{REPO}/releases/assets/{old.asset_id}")
        print(f"  pruned {old.name} of {old.retrieved}")


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] != "upload":
        raise SystemExit("usage: python3 pipeline/source_archive.py upload [RAW_DIR]")
    upload(Path(argv[2]) if len(argv) > 2 else Path("data/raw"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
