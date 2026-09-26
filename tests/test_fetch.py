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


def test_a_partial_overpass_answer_is_not_a_poi_layer(monkeypatch: pytest.MonkeyPatch) -> None:
    """A query that times out part-way still answers 200, with the elements it
    had and a `remark`. That was saved as the POI layer."""
    place = {"lon": -71.1, "lat": 42.38, "tags": {"leisure": "playground"}}
    answers = [
        {"elements": [place], "remark": "runtime error: Query timed out"},
        {"elements": [place, place, place]},
    ]
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_a, **_k: _FakeResponse(json.dumps(answers.pop(0)).encode()),
    )
    fc = fetch.fetch_pois()
    assert len(fc["features"]) == 3  # the complete answer, from the next mirror


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


class FakeArcGIS:
    """Just enough of an ArcGIS layer: its info, a count, and pages of at most
    its own maxRecordCount, in OBJECTID order."""

    def __init__(
        self,
        n: int,
        max_records: int,
        flag: bool = True,
        truncate_at: int | None = None,
        ignore_offset: bool = False,
    ) -> None:
        self.rows = [{"type": "Feature", "id": i, "properties": {"OBJECTID": i}} for i in range(n)]
        self.max_records = max_records
        self.flag = flag
        self.truncate_at = truncate_at
        self.ignore_offset = ignore_offset
        self.calls: list[dict[str, str]] = []

    def __call__(self, url: str, *_a: Any, **_k: Any) -> bytes:
        import urllib.parse

        parsed = urllib.parse.urlparse(url)
        q = dict(urllib.parse.parse_qsl(parsed.query))
        self.calls.append(q)
        if not parsed.path.endswith("/query"):
            info = {"objectIdField": "OBJECTID", "maxRecordCount": self.max_records}
            return json.dumps(info).encode()
        if q.get("returnCountOnly") == "true":
            return json.dumps({"count": len(self.rows)}).encode()
        assert q["orderByFields"] == "OBJECTID", "pages of an unordered query can skip rows"
        offset = 0 if self.ignore_offset else int(q["resultOffset"])
        size = min(int(q["resultRecordCount"]), self.max_records)
        end = len(self.rows) if self.truncate_at is None else self.truncate_at
        batch = self.rows[offset : min(offset + size, end)]
        page: dict[str, Any] = {"type": "FeatureCollection", "features": batch}
        if self.flag:
            page["properties"] = {"exceededTransferLimit": offset + size < end}
        return json.dumps(page).encode()


def test_arcgis_paging_follows_the_servers_own_page_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A layer capped at 500 per page returned its first 500 and stopped: the
    loop ended on any page shorter than 1,000."""
    server = FakeArcGIS(n=1234, max_records=500)
    monkeypatch.setattr(fetch, "_get", server)
    fc = fetch.arcgis_query("https://example.test/layer/0")
    assert len(fc["features"]) == 1234
    assert [f["id"] for f in fc["features"]] == list(range(1234))


def test_arcgis_paging_without_a_transfer_limit_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    server = FakeArcGIS(n=2001, max_records=1000, flag=False)
    monkeypatch.setattr(fetch, "_get", server)
    assert len(fetch.arcgis_query("https://example.test/layer/0")["features"]) == 2001


def test_a_short_arcgis_answer_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fewer features than the server's own count is a failed fetch, not a
    smaller layer."""
    monkeypatch.setattr(fetch, "_get", FakeArcGIS(n=1500, max_records=1000, truncate_at=1000))
    with pytest.raises(RuntimeError, match="got 1000 features but the server counts 1500"):
        fetch.arcgis_query("https://example.test/layer/0")
    # a server that ignores resultOffset would otherwise loop on page one forever
    monkeypatch.setattr(fetch, "_get", FakeArcGIS(n=1500, max_records=1000, ignore_offset=True))
    with pytest.raises(RuntimeError, match="server counts 1500"):
        fetch.arcgis_query("https://example.test/layer/0")


def test_arcgis_query_raises_on_error(monkeypatch: pytest.MonkeyPatch) -> None:
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


def test_cambridge_permits_become_dated_points(monkeypatch: pytest.MonkeyPatch) -> None:
    """Active street permits steer routes around work. A row without a position
    can't do that and must be dropped rather than land at (0, 0)."""
    rows = [
        {
            "longitude": "-71.1", "latitude": "42.38", "permit_type": "Excavation",
            "company_name": "Acme", "full_address": "1 Main St",
            "start_date": "2026-08-01T00:00:00", "end_date": "2026-09-01T00:00:00",
        },
        {"permit_type": "Excavation"},  # no position
        {"longitude": "nope", "latitude": "42.38"},  # unparseable
    ]
    monkeypatch.setattr(fetch, "_get", lambda *_a, **_k: json.dumps(rows).encode())
    fc = fetch.fetch_cambridge_permits()
    assert len(fc["features"]) == 1
    props = fc["features"][0]["properties"]
    assert props["src"] == "cambridge_permit"
    assert props["start"] == "2026-08-01"
    assert props["end"] == "2026-09-01"
    assert fc["features"][0]["geometry"]["coordinates"] == [-71.1, 42.38]


def test_cambridge_permits_are_paged_past_five_thousand(monkeypatch: pytest.MonkeyPatch) -> None:
    """One request with $limit=5000 ended the list at 5,000 without a word."""
    import urllib.parse

    rows = [{"longitude": "-71.1", "latitude": "42.38", "permit_type": "X"}] * 6200

    def socrata(url: str, *_a: Any, **_k: Any) -> bytes:
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
        assert q["$order"] == ":id"
        offset, limit = int(q.get("$offset", 0)), int(q["$limit"])
        return json.dumps(rows[offset : offset + min(limit, 50_000)]).encode()

    monkeypatch.setattr(fetch, "_get", socrata)
    assert len(fetch.fetch_cambridge_permits()["features"]) == 6200


def test_workzones_say_how_to_enable_them_when_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No key is a configuration state, and the message has to say what to do —
    fetch_all catches this so the other eleven sources still build."""
    monkeypatch.delenv(config.WZDX_KEY_ENV, raising=False)
    with pytest.raises(RuntimeError, match="MassDOT"):
        fetch.fetch_workzones()


def test_workzones_authenticate_with_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(config.WZDX_KEY_ENV, "test-key")
    feed = {"features": [{"type": "Feature", "geometry": None, "properties": {"id": "wz1"}}]}
    seen: dict[str, Any] = {}

    def fake_urlopen(req: Any, *_a: Any, **_k: Any) -> _FakeResponse:
        seen["auth"] = req.get_header("Authorization")
        return _FakeResponse(json.dumps(feed).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    fc = fetch.fetch_workzones()
    assert len(fc["features"]) == 1
    assert seen["auth"] == "Bearer test-key"


def test_mapc_labels_each_layer_with_the_class_it_means(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regional network arrives as separate layers; the class lives in the
    layer id, so it has to be attached before the geometries are merged."""
    def fake_query(url: str, *_a: Any, **_k: Any) -> dict[str, Any]:
        return {
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "geometry": None, "properties": {}}],
        }

    monkeypatch.setattr(fetch, "arcgis_query", fake_query)
    fc = fetch.fetch_mapc()
    classes = {f["properties"]["mapc_cls"] for f in fc["features"]}
    assert classes == set(config.MAPC_ALLTRAILS_LAYERS.values())
    assert len(fc["features"]) == len(config.MAPC_ALLTRAILS_LAYERS)


def test_fetch_all_skips_what_is_already_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A refresh shouldn't re-download twelve sources to rebuild one."""
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    (tmp_path / "pois.geojson").write_text('{"type":"FeatureCollection","features":[]}')
    calls: list[str] = []

    def boom(*_a: Any, **_k: Any) -> bytes:
        calls.append("fetched")
        raise OSError("should not be called for cached sources")

    monkeypatch.setattr(fetch, "_get", boom)
    monkeypatch.setattr(fetch, "arcgis_query", lambda *_a, **_k: {"features": []})
    monkeypatch.setattr(fetch, "fetch_pois", lambda: {"features": []})
    monkeypatch.setattr(fetch, "fetch_towns", lambda: {"features": []})
    monkeypatch.setattr(fetch, "fetch_population", lambda: {"features": []})
    monkeypatch.setattr(fetch, "fetch_workzones", lambda: {"features": []})
    monkeypatch.setattr(fetch, "fetch_cambridge_permits", lambda: {"features": []})
    monkeypatch.setattr(fetch, "fetch_mapc", lambda: {"features": []})
    fetch.fetch_all(refresh=False)
    out = capsys.readouterr().out
    assert "pois.geojson: cached, skipping" in out


def test_fetch_all_reports_failures_instead_of_dying(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """One dead endpoint must not cost the other eleven sources."""
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)

    def half_broken(*_a: Any, **_k: Any) -> dict[str, Any]:
        raise RuntimeError("endpoint down")

    monkeypatch.setattr(fetch, "arcgis_query", half_broken)
    empty = b'{"type":"FeatureCollection","features":[]}'
    monkeypatch.setattr(fetch, "_get", lambda *_a, **_k: empty)
    for name in ("fetch_pois", "fetch_towns", "fetch_population", "fetch_workzones",
                 "fetch_cambridge_permits", "fetch_mapc"):
        monkeypatch.setattr(fetch, name, lambda: {"type": "FeatureCollection", "features": []})
    failures = fetch.fetch_all(refresh=True)
    err = capsys.readouterr().err
    assert "FAILED" in err
    # and the sources that did work were still written
    assert (tmp_path / "pois.geojson").exists()
    assert failures and all(msg == "endpoint down" for _name, msg in failures)


def test_a_failed_source_fails_the_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """fetch.py exited 0 with sources failed, so the weekly refresh went on to
    build and publish without them."""
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    monkeypatch.setattr(fetch, "fetch_all", lambda refresh: [("pois.geojson", "504")])
    assert fetch.main(["--refresh"]) == 1
    monkeypatch.setattr(fetch, "fetch_all", lambda refresh: [])
    assert fetch.main(["--refresh"]) == 0


def test_no_work_zone_key_is_not_a_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one source that needs a key: without it, it is not configured,
    which must not fail every refresh of a fork without the secret."""
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    monkeypatch.delenv(config.WZDX_KEY_ENV, raising=False)
    empty: dict[str, Any] = {"type": "FeatureCollection", "features": []}
    monkeypatch.setattr(fetch, "_get", lambda *_a, **_k: json.dumps(empty).encode())
    monkeypatch.setattr(fetch, "arcgis_query", lambda *_a, **_k: empty)
    for name in ("fetch_pois", "fetch_towns", "fetch_population",
                 "fetch_cambridge_permits", "fetch_mapc"):
        monkeypatch.setattr(fetch, name, lambda: empty)
    assert fetch.fetch_all(refresh=True) == []
    assert not (tmp_path / "workzones.geojson").exists()
