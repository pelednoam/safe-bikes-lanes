"""Tests for source_archive: the last few copies of every source."""

import datetime
import gzip
import json
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path
from typing import Any

import pytest
import source_archive
from source_archive import Copy

D = datetime.date


def _copy(name: str, day: D, asset_id: int = 0) -> Copy:
    return Copy(
        name=name, retrieved=day, url=f"https://example.test/{name}.{day}.gz", asset_id=asset_id
    )


def test_assets_are_read_by_name_and_date_and_anything_else_is_ignored() -> None:
    release = {"id": 7}
    assets = [
        {"id": 1, "name": "massdot_lts.geojson.2026-09-26.gz", "browser_download_url": "u1"},
        {"id": 2, "name": "crashes_2026.geojson.2026-09-19.gz", "browser_download_url": "u2"},
        {"id": 3, "name": "README.txt", "browser_download_url": "u3"},
    ]

    def get_json(url: str) -> Any:
        return release if url.endswith("/tags/source-archive") else assets

    copies = source_archive.list_copies(get_json)
    assert [(c.name, c.retrieved, c.asset_id) for c in copies] == [
        ("massdot_lts.geojson", D(2026, 9, 26), 1),
        ("crashes_2026.geojson", D(2026, 9, 19), 2),
    ]


def test_no_archive_yet_is_no_copies_not_a_crash() -> None:
    def missing(url: str) -> Any:
        raise urllib.error.HTTPError(url, 404, "Not Found", Message(), None)

    assert source_archive.list_copies(missing) == []


def test_failing_to_ask_is_not_the_same_as_no_archive() -> None:
    # read as "no archive", a rate limit made upload() try to create a release
    # that exists, and the refresh's archive step failed every week
    def limited(url: str) -> Any:
        raise urllib.error.HTTPError(url, 403, "rate limit exceeded", Message(), None)

    def offline(url: str) -> Any:
        raise urllib.error.URLError("no route to host")

    for broken in (limited, offline):
        with pytest.raises(OSError):
            source_archive.list_copies(broken)


def test_the_newest_copy_stands_in_only_within_its_limit() -> None:
    copies = [
        _copy("pois.geojson", D(2026, 9, 1)),
        _copy("pois.geojson", D(2026, 9, 20)),
        _copy("towns.geojson", D(2026, 9, 25)),
    ]
    seen: list[Copy] = []

    def fetch(c: Copy) -> dict[str, Any]:
        seen.append(c)
        return {"type": "FeatureCollection", "features": [{}]}

    today = D(2026, 9, 27)
    got = source_archive.fallback("pois.geojson", 30, today, copies, fetch)
    assert got is not None and got[1].retrieved == D(2026, 9, 20)
    # 7 days old against a 5-day limit: no stand-in
    assert source_archive.fallback("pois.geojson", 5, today, copies, fetch) is None
    # a source never archived has none either
    assert source_archive.fallback("workzones.geojson", 7, today, copies, fetch) is None
    assert [c.retrieved for c in seen] == [D(2026, 9, 20)]


def test_an_empty_copy_is_no_stand_in() -> None:
    copies = [_copy("pois.geojson", D(2026, 9, 26))]
    empty = source_archive.fallback(
        "pois.geojson",
        30,
        D(2026, 9, 27),
        copies,
        lambda c: {"type": "FeatureCollection", "features": []},
    )
    assert empty is None


def test_only_the_newest_few_of_each_source_are_kept() -> None:
    copies = [_copy("pois.geojson", D(2026, 9, d), d) for d in (1, 8, 15, 22)] + [
        _copy("towns.geojson", D(2026, 9, 22), 99)
    ]
    pruned = source_archive.to_prune(copies, keep=3)
    assert [(c.name, c.retrieved) for c in pruned] == [("pois.geojson", D(2026, 9, 1))]


def test_only_what_came_from_the_publisher_is_archived(tmp_path: Path) -> None:
    """A copy that came from the archive must not go back in as if new: it
    would keep a stale layer alive forever under fresh dates."""
    (tmp_path / "pois.geojson").write_text("{}")
    (tmp_path / "pois.geojson.meta.json").write_text(
        json.dumps({"source": "pois.geojson", "retrieved": "2026-09-26T21:37:49+00:00"})
    )
    (tmp_path / "towns.geojson").write_text("{}")
    (tmp_path / "towns.geojson.meta.json").write_text(
        json.dumps(
            {
                "source": "archived copy of 2026-07-24 (live fetch failed: x)",
                "retrieved": "2026-07-24",
            }
        )
    )
    fresh = source_archive.fresh_sources(tmp_path)
    assert [(p.name, d) for p, d in fresh] == [("pois.geojson", D(2026, 9, 26))]


def test_a_downloaded_copy_is_the_gzipped_geojson(monkeypatch: Any) -> None:
    body = gzip.compress(json.dumps({"features": [1]}).encode())

    class Resp:
        def __enter__(self) -> "Resp":
            return self

        def __exit__(self, *_a: object) -> None:
            return None

        def read(self) -> bytes:
            return body

    monkeypatch.setattr(urllib.request, "urlopen", lambda *_a, **_k: Resp())
    assert source_archive.download(_copy("pois.geojson", D(2026, 9, 26))) == {"features": [1]}


def test_upload_asks_github_for_the_release_once_before_it_uploads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # it asked for the release to find out whether there was one, and again, in
    # list_copies(), for what was in it: two requests for one answer
    (tmp_path / "pois.geojson").write_text("{}")
    asked: list[str] = []
    ran: list[tuple[str, ...]] = []

    def get_json(url: str) -> Any:
        asked.append(url)
        return {"id": 7} if url.endswith("/tags/source-archive") else []

    monkeypatch.setattr(source_archive, "_gh", lambda *args: ran.append(args))
    fresh = [(tmp_path / "pois.geojson", D(2026, 9, 29))]
    monkeypatch.setattr(source_archive, "fresh_sources", lambda raw: fresh)
    source_archive.upload(tmp_path, get_json)
    releases = [u for u in asked if u.endswith("/tags/source-archive")]
    # once to look, and once more after uploading to see what is there to prune
    assert len(releases) == 2, asked
    assert ran[0][:2] == ("release", "upload")


def test_upload_makes_the_release_when_there_is_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ran: list[tuple[str, ...]] = []

    def get_json(url: str) -> Any:
        raise urllib.error.HTTPError(url, 404, "Not Found", Message(), None)

    monkeypatch.setattr(source_archive, "_gh", lambda *args: ran.append(args))
    monkeypatch.setattr(source_archive, "fresh_sources", lambda raw: [])
    source_archive.upload(tmp_path, get_json)
    assert ran[0][:3] == ("release", "create", source_archive.TAG)

