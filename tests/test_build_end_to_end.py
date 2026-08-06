"""The two orchestrations, run whole on a network small enough for a test.

Everything under `build_graph.build()` and `export_web.export()` is unit-tested
elsewhere; nothing checked that the parts fit together. They are also where a
mistake is most expensive — the graph they produce is what every route, every
overlay and the entire where-to-build ranking is derived from — and they were
the two largest uncovered blocks in the pipeline.

OSM and the elevation service are stubbed. Everything else is the real code.
"""

import pickle
from pathlib import Path
from typing import Any

import build_graph
import config
import export_web
import networkx as nx
import osmnx as ox
import pytest


def tiny_osm() -> nx.MultiDiGraph:
    """Six nodes in Cambridge: a quiet street, an arterial, and a path."""
    g = nx.MultiDiGraph()
    g.graph["crs"] = "EPSG:4326"
    coords = {
        1: (-71.1000, 42.3800),
        2: (-71.0980, 42.3800),
        3: (-71.0960, 42.3800),
        4: (-71.0980, 42.3820),
        5: (-71.0960, 42.3820),
        6: (-71.0940, 42.3800),
    }
    for n, (x, y) in coords.items():
        g.add_node(n, x=x, y=y, street_count=2)
    def link(u: int, v: int, **tags: Any) -> None:
        for a, b in ((u, v), (v, u)):
            g.add_edge(a, b, osmid=a * 100 + b, **tags)

    link(1, 2, highway="residential", name="Quiet St")
    link(2, 3, highway="primary", name="Big Ave", maxspeed="35 mph")
    link(2, 4, highway="cycleway", name="The Path")
    link(4, 5, highway="cycleway", name="The Path")
    link(3, 6, highway="residential", name="Other St")
    # osmnx measures lengths during the download the real acquire_osm does;
    # use its own helper rather than inventing metres by hand
    return ox.distance.add_edge_lengths(g)


class StubSampler:
    """Terrain without the network: a gentle slope east."""

    def elevation(self, lon: float, _lat: float) -> float:
        return (lon + 71.1) * 1000.0


@pytest.fixture
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    data = tmp_path / "data"
    raw = data / "raw"
    raw.mkdir(parents=True)
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "RAW_DIR", raw)
    monkeypatch.setattr(build_graph, "acquire_osm", lambda _bbox: tiny_osm())
    monkeypatch.setattr(build_graph, "ElevationSampler", lambda: StubSampler())
    return data


def test_build_produces_a_routable_graph_with_every_edge_costed(sandbox: Path) -> None:
    build_graph.build()
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)

    assert g.number_of_nodes() > 0
    for _u, _v, d in g.edges(data=True):
        # everything downstream reads these; a missing one is a silent zero
        for key in ("cls", "stress_mult", "weight", "weight_solo", "crash_factor", "length"):
            assert key in d, f"edge missing {key}"
        assert d["weight"] > 0
        # the crash count is written for the where-to-build report
        assert "crash_count" in d

    classes = {d["cls"] for _u, _v, d in g.edges(data=True)}
    # the classifier ran: a residential street, an arterial and a path
    assert "quiet_street" in classes
    assert "busy_street" in classes
    assert "path" in classes


def test_the_arterial_costs_far_more_than_the_quiet_street(sandbox: Path) -> None:
    """The whole product in one assertion: the graph a family routes on has to
    make the arterial expensive and the path cheap."""
    build_graph.build()
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)
    per_class: dict[str, float] = {}
    for _u, _v, d in g.edges(data=True):
        per_class[d["cls"]] = d["weight"] / max(d["length"], 1e-9)
    assert per_class["busy_street"] > per_class["quiet_street"] * 5
    assert per_class["path"] <= per_class["quiet_street"]


def test_build_writes_the_display_network(sandbox: Path) -> None:
    import json

    build_graph.build()
    fc = json.loads((sandbox / "network.geojson").read_text())
    assert fc["features"]
    props = fc["features"][0]["properties"]
    for key in ("cls", "color", "name", "source", "crashes"):
        assert key in props


def test_export_turns_the_graph_into_tiles_the_app_can_load(
    sandbox: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    build_graph.build()
    web = tmp_path / "web-data"
    web.mkdir()
    monkeypatch.setattr(export_web, "WEB_DATA", web)
    export_web.export()

    manifest = json.loads((web / "tiles" / "manifest.json").read_text())
    assert manifest["tiles"]
    # a tile the app can actually route across: global ids so seams stitch
    tile = json.loads((web / "tiles" / f"{manifest['tiles'][0]}.json").read_text())
    assert tile["edges"] and tile["nodes"] and tile["nodeIds"]
    assert len(tile["nodeIds"]) == len(tile["nodes"])
    assert set(manifest["classes"]) <= set(config.CLASS_MULTIPLIER)

    # and the layers the app expects alongside them
    for name in ("nettiles/manifest.json", "heatmap.geojson", "lanemap.geojson", "meta.json"):
        assert (web / name).exists(), f"{name} missing"


def test_an_edge_survives_the_round_trip_into_a_tile(
    sandbox: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Lengths and classes have to mean the same thing on both sides of the
    export, or the browser routes on different numbers than the ranking did."""
    import json

    build_graph.build()
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)
    graph_len = sorted(round(float(d["length"]), 1) for _u, _v, d in g.edges(data=True))

    web = tmp_path / "web-data2"
    web.mkdir()
    monkeypatch.setattr(export_web, "WEB_DATA", web)
    export_web.export()

    manifest = json.loads((web / "tiles" / "manifest.json").read_text())
    tile_len: list[float] = []
    for key in manifest["tiles"]:
        tile = json.loads((web / "tiles" / f"{key}.json").read_text())
        tile_len.extend(round(float(e[2]), 1) for e in tile["edges"])
    # tiles duplicate edges that straddle a seam, so compare the sets
    assert set(tile_len) <= set(graph_len)
    assert set(graph_len) == set(tile_len)
