"""Tests for the web export's geometry and binning.

These functions had no coverage at all, which is how a cell-binning bug lived in
the heatmap, the lane map, the aerial audit and the mapillary check at once:
every one of them binned samples with int() instead of floor(), so west of the
meridian a sample landed in the cell next door and every overlay was drawn about
100 m off its own data.
"""

import json
import math
from pathlib import Path
from typing import Any

import config
import export_web
import networkx as nx
import pytest


def test_a_sample_falls_inside_the_cell_it_is_binned_into() -> None:
    """The property the int()/floor() bug broke, asserted directly.

    Every longitude here is negative, which is exactly where truncation rounds
    the wrong way: int(-14220.1) is -14220, one cell east of where the point is.
    """
    for lon in (-71.1005, -71.0001, -70.9999, -71.5, -71.123456):
        for lat in (42.0001, 42.3812, 42.6):
            cx = math.floor(lon / export_web.CELL_LON)
            cy = math.floor(lat / export_web.CELL_LAT)
            west, south = cx * export_web.CELL_LON, cy * export_web.CELL_LAT
            assert west <= lon <= west + export_web.CELL_LON, f"{lon} outside its cell"
            assert south <= lat <= south + export_web.CELL_LAT, f"{lat} outside its cell"


def test_tile_keys_are_stable_and_contain_their_points() -> None:
    """Tile keys must never renumber: coverage grows by adding tiles, and a
    shifted origin would invalidate every cached tile on every device."""
    col, row = export_web._tile_key(-71.1, 42.38)
    west = config.TILE_ORIGIN_LON + col * config.TILE_DEG
    south = config.TILE_ORIGIN_LAT + row * config.TILE_DEG
    assert west <= -71.1 <= west + config.TILE_DEG
    assert south <= 42.38 <= south + config.TILE_DEG
    # west of the origin would be negative, and must still floor correctly
    assert export_web._tile_key(-73.61, 41.09) == (-1, -1)


def test_segment_samples_preserve_length_and_stay_on_the_line() -> None:
    coords = [(-71.10, 42.38), (-71.09, 42.38)]
    samples = export_web._seg_samples(coords)
    assert samples
    total = sum(m for _lon, _lat, m in samples)
    expected = 0.01 * 111_320 * math.cos(math.radians(42.38))
    assert total == pytest.approx(expected, rel=0.01)
    for lon, lat, _m in samples:
        assert -71.10 <= lon <= -71.09
        assert lat == pytest.approx(42.38)


def test_a_single_point_line_samples_nothing() -> None:
    assert export_web._seg_samples([(-71.1, 42.38)]) == []


def test_bbox_test_walks_nested_coordinates() -> None:
    inside: list[Any] = [[-71.1, 42.38], [-71.09, 42.39]]
    outside: list[Any] = [[-80.0, 30.0]]
    assert export_web._in_bbox(inside)
    assert not export_web._in_bbox(outside)
    # a polygon's nested rings, not just a flat line
    assert export_web._in_bbox([[[-71.1, 42.38], [-71.09, 42.39]]])


def _tiny_graph() -> nx.MultiDiGraph:
    g = nx.MultiDiGraph()
    g.add_node(1, x=-71.1000, y=42.3800, elev=10.0)
    g.add_node(2, x=-71.0988, y=42.3800, elev=12.0, highway="traffic_signals")
    for a, b in ((1, 2), (2, 1)):
        g.add_edge(
            a, b, length=100.0, cls="busy_street", stress_mult=25.0, crash_factor=1.2,
            road_busy=True, name="Test Ave",
        )
    return g


def test_heatmap_cells_hold_their_own_streets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(export_web, "WEB_DATA", tmp_path)
    export_web.export_heatmap(_tiny_graph())
    cells = json.loads((tmp_path / "heatmap.geojson").read_text())["features"]
    assert cells
    # the street sits at -71.099, 42.38; some cell must actually contain it
    def contains(feat: dict[str, Any], lon: float, lat: float) -> bool:
        ring = feat["geometry"]["coordinates"][0]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return min(xs) <= lon <= max(xs) and min(ys) <= lat <= max(ys)

    assert any(contains(f, -71.0994, 42.38) for f in cells)
    # a busy street with a crash factor on top is the red band, not green
    colours = {f["properties"]["color"] for f in cells}
    assert colours <= set(export_web.HEAT_COLORS.values())
    assert export_web.HEAT_COLORS["red"] in colours
    assert cells[0]["properties"]["stress"] > export_web.HEAT_YELLOW_MAX


def test_lane_map_reports_facility_metres_per_cell(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(export_web, "WEB_DATA", tmp_path)
    g = _tiny_graph()
    for _u, _v, d in g.edges(data=True):
        d["cls"] = "separated"
        d["stress_mult"] = 1.0
    export_web.export_lane_heatmap(g)
    cells = json.loads((tmp_path / "lanemap.geojson").read_text())["features"]
    assert cells
    props = cells[0]["properties"]
    assert props["fac_m"] > 0
    # separated counts as protected, so the protected metres are the same
    assert props["prot_m"] == props["fac_m"]


def test_gateways_are_signalized_nodes_on_busy_streets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(export_web, "WEB_DATA", tmp_path)
    export_web.export_gateways(_tiny_graph())
    feats = json.loads((tmp_path / "gateways.geojson").read_text())["features"]
    # node 2 is signalized and on a busy street; node 1 is not signalized
    assert len(feats) == 1
    assert feats[0]["geometry"]["coordinates"] == [-71.0988, 42.38]


# ── tiling: the app's whole loading strategy rests on these ────────────────


def test_a_tile_holds_its_own_edges_and_renumbers_locally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tiles carry global node ids so neighbours stitch together, and only the
    nodes their own edges touch — that's what keeps a first load small."""
    monkeypatch.setattr(export_web, "WEB_DATA", tmp_path)
    nodes = [[-71.100, 42.380, 5.0], [-71.098, 42.380, 6.0], [-71.300, 42.500, 7.0]]
    names = ["", "Near St", "Far St"]
    edges = [
        [0, 1, 100.0, 0, 1, -1, 1.0, 0.0, 0.0, 0],
        [1, 2, 9000.0, 0, 2, -1, 1.0, 0.0, 0.0, 0],
    ]
    export_web.export_tiles(nodes, names, edges, [])
    manifest = json.loads((tmp_path / "tiles" / "manifest.json").read_text())
    assert manifest["tileDeg"] == config.TILE_DEG
    assert manifest["originLon"] == config.TILE_ORIGIN_LON
    assert manifest["tiles"], "no tiles written"

    key = f"{export_web._tile_key(-71.099, 42.380)[0]}_{export_web._tile_key(-71.099, 42.380)[1]}"
    assert key in manifest["tiles"]
    tile = json.loads((tmp_path / "tiles" / f"{key}.json").read_text())
    # the near edge is here, and its endpoints came with it
    assert tile["edges"]
    assert len(tile["nodeIds"]) == len(tile["nodes"])
    assert all(isinstance(i, int) for i in tile["nodeIds"])


def test_network_tiles_split_the_display_layer_by_cell(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(export_web, "WEB_DATA", tmp_path)
    data = tmp_path / "src"
    data.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", data)
    feats = [
        {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[-71.10, 42.38], [-71.099, 42.38]]},
            "properties": {"cls": "quiet_street", "name": "A St"},
        },
        {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[-71.30, 42.50], [-71.299, 42.50]]},
            "properties": {"cls": "busy_street", "name": "B St"},
        },
    ]
    (data / "network.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats})
    )
    export_web.export_network_tiles()
    manifest = json.loads((tmp_path / "nettiles" / "manifest.json").read_text())
    # two far-apart streets can't share a tile
    assert len(manifest["tiles"]) == 2
    total = 0
    for key in manifest["tiles"]:
        total += len(json.loads((tmp_path / "nettiles" / f"{key}.json").read_text())["features"])
    assert total == 2  # nothing lost, nothing duplicated


def test_meta_reports_every_source_and_the_build_date(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(export_web, "WEB_DATA", tmp_path)
    raw = tmp_path / "raw"
    raw.mkdir()
    monkeypatch.setattr(config, "RAW_DIR", raw)
    (raw / "crashes_2025.geojson.meta.json").write_text(
        json.dumps({"retrieved": "2026-08-05T10:00:00Z", "features": 42})
    )
    export_web.export_meta()
    meta = json.loads((tmp_path / "meta.json").read_text())
    assert meta["built"].startswith("20")
    assert meta["sources"][0]["name"] == "crashes_2025"
    assert meta["sources"][0]["retrieved"] == "2026-08-05"
    assert meta["sources"][0]["features"] == 42
