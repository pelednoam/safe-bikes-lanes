"""Tests for the source fetchers' transforms.

Downloading isn't tested — that's the network's job — but everything these do to
what comes back is: which OSM tags become which kind of destination, which
fields survive, and whether paging stops. The module had no coverage at all,
and it is the front of every number the rest of the pipeline reports.
"""

import json
import urllib.request
from pathlib import Path
from typing import Any

import config
import fetch
import pytest


class _FakeResponse:
    """Just enough of an HTTP response for json.load() in a `with` block."""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None


def _overpass(elements: list[dict[str, Any]]) -> bytes:
    return json.dumps({"elements": elements}).encode()


def test_poi_kinds_map_from_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    elements: list[dict[str, Any]] = [
        {"lon": -71.1, "lat": 42.38, "tags": {"leisure": "playground", "name": "Park"}},
        {"lon": -71.1, "lat": 42.38, "tags": {"amenity": "school", "name": "School"}},
        {"lon": -71.1, "lat": 42.38, "tags": {"amenity": "kindergarten", "name": "Kinder"}},
        {"lon": -71.1, "lat": 42.38, "tags": {"amenity": "library"}},
        {"lon": -71.1, "lat": 42.38, "tags": {"amenity": "drinking_water"}},
        {"lon": -71.1, "lat": 42.38, "tags": {"amenity": "toilets"}},
        {"lon": -71.1, "lat": 42.38, "tags": {"cuisine": "ice_cream"}},
        # a way with only a centre, and something we don't care about
        {"center": {"lon": -71.2, "lat": 42.4}, "tags": {"leisure": "playground"}},
        {"lon": -71.1, "lat": 42.38, "tags": {"amenity": "bank"}},
        {"tags": {"amenity": "library"}},  # no position at all
    ]
    # fetch_pois posts to Overpass directly rather than through _get
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_a, **_k: _FakeResponse(_overpass(elements)),
    )
    fc = fetch.fetch_pois()
    kinds = [f["properties"]["kind"] for f in fc["features"]]
    # kindergartens are schools for this purpose; banks and unplaced nodes are out
    assert kinds.count("school") == 2
    assert kinds.count("playground") == 2
    assert set(kinds) == {"school", "playground", "library", "water", "restroom", "ice_cream"}
    assert len(fc["features"]) == 8


def test_towns_keep_only_their_name(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
                "properties": {"TOWN": "SOMERVILLE", "TOWN_ID": 274, "SHAPE_Area": 1.0},
            }
        ],
    }
    monkeypatch.setattr(fetch, "arcgis_query", lambda *_a, **_k: raw)
    fc = fetch.fetch_towns()
    props = fc["features"][0]["properties"]
    # title case, and none of the dozen administrative fields we'd never read
    assert props == {"town": "Somerville"}


def test_population_trims_to_people_and_outer_rings(monkeypatch: pytest.MonkeyPatch) -> None:
    ring = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]
    hole = [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3], [0.2, 0.2]]
    raw = {
        "type": "FeatureCollection",
        "features": [
            {
                "geometry": {"type": "Polygon", "coordinates": [ring, hole]},
                "properties": {"GEOID": "25017", "POP100": "1234", "AREALAND": 99},
            },
            {
                "geometry": {"type": "MultiPolygon", "coordinates": [[ring], [ring]]},
                "properties": {"GEOID": "25018", "POP100": None},
            },
            {"geometry": None, "properties": {"GEOID": "x", "POP100": 5}},
        ],
    }
    monkeypatch.setattr(fetch, "arcgis_query", lambda *_a, **_k: raw)
    fc = fetch.fetch_population()
    assert len(fc["features"]) == 2  # the geometry-less one is dropped
    first = fc["features"][0]
    assert first["properties"] == {"geoid": "25017", "pop": 1234}  # string population parsed
    # the hole is gone: a lake inside a block group doesn't change who lives there
    assert first["geometry"]["coordinates"] == [[[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]]]
    # a null population is zero, not a crash
    assert fc["features"][1]["properties"]["pop"] == 0


def test_arcgis_query_pages_until_short_and_raises_on_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pages = [
        {"features": [{"id": i} for i in range(1000)]},
        {"features": [{"id": 1000}]},
    ]
    calls: list[str] = []

    def fake_get(url: str, *_a: Any, **_k: Any) -> bytes:
        calls.append(url)
        return json.dumps(pages[len(calls) - 1]).encode()

    monkeypatch.setattr(fetch, "_get", fake_get)
    fc = fetch.arcgis_query("https://example.test/layer/0")
    assert len(fc["features"]) == 1001
    assert len(calls) == 2
    assert "resultOffset=1000" in calls[1]

    monkeypatch.setattr(
        fetch, "_get", lambda *_a, **_k: json.dumps({"error": {"message": "nope"}}).encode()
    )
    with pytest.raises(RuntimeError, match="nope"):
        fetch.arcgis_query("https://example.test/layer/0")


def test_save_writes_a_provenance_sidecar(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every source records where it came from and when — the About dialog and
    the where-to-build methodology both read these."""
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    fetch._save("thing.geojson", {"type": "FeatureCollection", "features": [{}, {}]}, "a source")
    meta = json.loads((tmp_path / "thing.geojson.meta.json").read_text())
    assert meta["source"] == "a source"
    assert meta["features"] == 2
    assert meta["retrieved"].startswith("20")


def test_overpass_tries_every_mirror_before_giving_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """Public Overpass instances 504 under load; one failure must not lose the
    POI layer, and total failure must be loud rather than an empty file."""
    attempts: list[str] = []

    def always_fail(*_a: Any, **_k: Any) -> bytes:
        attempts.append("x")
        raise OSError("504")

    monkeypatch.setattr(urllib.request, "urlopen", always_fail)
    with pytest.raises(RuntimeError, match="Overpass"):
        fetch.fetch_pois()
    assert len(attempts) >= 3  # every mirror, not just the first
