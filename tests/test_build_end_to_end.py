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


def tiny_osm(painted: bool = False) -> nx.MultiDiGraph:
    """Six nodes in Cambridge: a quiet street, an arterial, and a path.

    `painted` adds two more streets with markings on them: a residential
    street with a painted lane and an arterial with sharrows."""
    g = nx.MultiDiGraph()
    g.graph["crs"] = "EPSG:4326"
    coords = {
        1: (-71.1000, 42.3800),
        2: (-71.0980, 42.3800),
        3: (-71.0960, 42.3800),
        4: (-71.0980, 42.3820),
        5: (-71.0960, 42.3820),
        6: (-71.0940, 42.3800),
        7: (-71.1000, 42.3780),
        8: (-71.0980, 42.3780),
    }
    for n, (x, y) in coords.items():
        if n <= 6 or painted:
            g.add_node(n, x=x, y=y, street_count=2)
    def link(u: int, v: int, **tags: Any) -> None:
        for a, b in ((u, v), (v, u)):
            g.add_edge(a, b, osmid=a * 100 + b, **tags)

    link(1, 2, highway="residential", name="Quiet St")
    link(2, 3, highway="primary", name="Big Ave", maxspeed="35 mph")
    link(2, 4, highway="cycleway", name="The Path")
    link(4, 5, highway="cycleway", name="The Path")
    link(3, 6, highway="residential", name="Other St")
    if painted:
        link(1, 7, highway="residential", name="Painted St", cycleway="lane")
        link(4, 8, highway="path", name="Mud Trail", surface="dirt")
        # one-way for cars, both ways for bikes, a contraflow lane on the left;
        # osmnx hands over only the car direction
        g.add_edge(
            6, 5, osmid=605, highway="residential", name="Contra St", oneway=True,
            reversed=False, **{"oneway:bicycle": "no", "cycleway:left": "lane"},
        )
        link(7, 8, highway="primary", name="Sharrow Ave", cycleway="shared_lane")
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
    # the sandbox fetches nothing: build without the official layers on purpose
    monkeypatch.setenv(build_graph.ALLOW_MISSING_ENV, "1")
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
        # the crash count is written for the where-to-build report, and which
        # crashes, so a corridor can count each one once
        assert "crash_count" in d
        assert len(d["crash_ids"]) == d["crash_count"]

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
    # and what the publish step's sanity gate compares with the live snapshot
    stats = json.loads((web / "meta.json").read_text())["graph"]
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)
    assert stats == {
        "nodes": g.number_of_nodes(), "edges": g.number_of_edges(), "crashes_joined": 0,
    }


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


def test_markings_are_priced_against_the_street_they_are_painted_on(
    sandbox: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Paint can only help, and a sharrow on an arterial is the arterial.

    Before: the residential street with a painted lane cost 3.0 per metre
    against 1.4 bare, and the arterial with sharrows 6.0 against 25."""
    import json

    monkeypatch.setattr(build_graph, "acquire_osm", lambda _bbox: tiny_osm(painted=True))
    monkeypatch.setattr(export_web, "ElevationSampler", lambda: StubSampler())
    build_graph.build()
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)
    by_name = {d["name"]: d for _u, _v, d in g.edges(data=True)}

    painted = by_name["Painted St"]
    assert painted["cls"] == "lane"  # what is there is still what riders are told
    assert painted["stress_mult"] == config.CLASS_MULTIPLIER["quiet_street"]
    assert painted["road_cls"] == "quiet_street"

    sharrow = by_name["Sharrow Ave"]
    assert sharrow["cls"] == "sharrow"
    assert sharrow["stress_mult"] == config.CLASS_MULTIPLIER["busy_street"]
    assert sharrow["weight_solo"] / sharrow["length"] == pytest.approx(
        config.SOLO_CLASS_MULTIPLIER["busy_street"] * sharrow["crash_factor"]
    )

    # the browser prices edges itself, so the street's own class has to reach it
    web = tmp_path / "web-painted"
    web.mkdir()
    monkeypatch.setattr(export_web, "WEB_DATA", web)
    export_web.export()
    manifest = json.loads((web / "tiles" / "manifest.json").read_text())
    table = manifest.get("classTable", manifest["classes"])
    seen = False
    for key in manifest["tiles"]:
        tile = json.loads((web / "tiles" / f"{key}.json").read_text())
        for e in tile["edges"]:
            if tile["names"][e[4]] == "Painted St":
                assert table[e[3]] == "lane"
                assert table[e[10]] == "quiet_street"
                seen = True
    assert seen


def test_an_unpaved_trail_reaches_the_app_as_its_own_class(
    sandbox: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end: classified, priced, drawn in its own colour, and exported so
    that the app can name it while an app from before the class existed still
    routes it (as the quiet street it falls back to) rather than as NaN."""
    import json

    monkeypatch.setattr(build_graph, "acquire_osm", lambda _bbox: tiny_osm(painted=True))
    monkeypatch.setattr(export_web, "ElevationSampler", lambda: StubSampler())
    # An official layer draws a "shared-use path" along it. That says nothing
    # about the surface, and OSM saying "dirt" does: it stays unpaved.
    official = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[-71.09802, 42.3820], [-71.09802, 42.3780]],
                },
                "properties": {"mapc_cls": "path"},
            }
        ],
    }
    (sandbox / "raw" / "mapc_bike_network.geojson").write_text(json.dumps(official))
    build_graph.build()
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)
    trail = next(d for _u, _v, d in g.edges(data=True) if d["name"] == "Mud Trail")
    assert trail["cls"] == "unpaved"
    assert trail["stress_mult"] == config.CLASS_MULTIPLIER["unpaved"]

    net = json.loads((sandbox / "network.geojson").read_text())
    drawn = [f for f in net["features"] if f["properties"]["name"] == "Mud Trail"]
    assert drawn and drawn[0]["properties"]["color"] == config.CLASS_COLOR["unpaved"]

    web = tmp_path / "web-unpaved"
    web.mkdir()
    monkeypatch.setattr(export_web, "WEB_DATA", web)
    export_web.export()
    manifest = json.loads((web / "tiles" / "manifest.json").read_text())
    legacy, table = manifest["classes"], manifest["classTable"]
    assert table[: len(legacy)] == legacy
    found = False
    for key in manifest["tiles"]:
        tile = json.loads((web / "tiles" / f"{key}.json").read_text())
        for e in tile["edges"]:
            if tile["names"][e[4]] == "Mud Trail":
                assert table[e[3]] == "unpaved"
                # past the end of what an old app reads: it falls back, not NaN
                assert e[3] >= len(legacy)
                found = True
            else:
                # every other class keeps the index it has always had
                assert e[3] < len(legacy)
    assert found


def test_a_contraflow_street_can_be_ridden_both_ways(
    sandbox: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(build_graph, "acquire_osm", lambda _bbox: tiny_osm(painted=True))
    build_graph.build()
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)
    with_traffic = g.get_edge_data(6, 5)
    against = g.get_edge_data(5, 6)
    assert with_traffic is not None
    assert against is not None, "the contraflow direction is missing"
    # the lane is on the contraflow side, and only there
    assert against[0]["cls"] == "lane"
    assert with_traffic[0]["cls"] == "quiet_street"


def test_a_footpath_meeting_a_road_mid_block_is_joined_to_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The two networks are simplified separately, so the node where a path
    meets a road partway along it is only a bend to the road and vanishes from
    the bike graph: the path ended 0 m from the road and did not connect."""
    from shapely.geometry import LineString

    bike = nx.MultiDiGraph()
    bike.graph["crs"] = "EPSG:4326"
    bike.add_node(1, x=-71.1000, y=42.3800)
    bike.add_node(2, x=-71.0980, y=42.3800)
    road = [(-71.1000, 42.3800), (-71.0990, 42.3801), (-71.0980, 42.3800)]
    for a, b, line in ((1, 2, road), (2, 1, road[::-1])):
        bike.add_edge(a, b, osmid=12, highway="residential", name="Road St",
                      geometry=LineString(line), length=170.0)

    foot = nx.MultiDiGraph()
    foot.graph["crs"] = "EPSG:4326"
    foot.add_node(9, x=-71.0990, y=42.3801)  # the road's middle vertex
    foot.add_node(10, x=-71.0990, y=42.3820)
    for a, b in ((9, 10), (10, 9)):
        foot.add_edge(a, b, osmid=910, highway="footway", bicycle="yes", length=210.0)

    monkeypatch.setattr(
        ox, "graph_from_bbox",
        lambda *_a, **kw: foot if "custom_filter" in kw else bike.copy(),
    )
    g = build_graph.acquire_osm((-71.2, 42.3, -71.0, 42.5))
    assert nx.has_path(g, 1, 10), "the path is still a dead end beside the road"
    assert nx.has_path(g, 10, 2)
    # the road runs through the junction, in both directions, with its length
    # split between the pieces rather than duplicated
    assert not g.has_edge(1, 2) and not g.has_edge(2, 1)
    pieces = [g.edges[1, 9, 0], g.edges[9, 2, 0]]
    assert sum(p["length"] for p in pieces) == pytest.approx(170.0, rel=0.05)
    assert all(p["name"] == "Road St" for p in pieces)
    assert g.edges[9, 1, 0]["geometry"].coords[0] == (-71.0990, 42.3801)


class HillSampler:
    """A 20 m ridge along 42.381 N, level ground at 42.380."""

    def elevation(self, _lon: float, lat: float) -> float:
        return max(0.0, 20.0 - abs(lat - 42.381) * 20_000)


def test_a_street_over_a_hill_is_not_flat(
    sandbox: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Climb came from the two ends of an edge, so a street that goes over a
    hill and comes down to the same height counted as climb 0 both ways."""
    from shapely.geometry import LineString

    def hilly() -> nx.MultiDiGraph:
        g = tiny_osm()
        over = [(-71.1000, 42.3800), (-71.0990, 42.3810), (-71.0980, 42.3800)]
        g.edges[1, 2, 0]["geometry"] = LineString(over)
        g.edges[2, 1, 0]["geometry"] = LineString(over[::-1])
        return g

    monkeypatch.setattr(build_graph, "acquire_osm", lambda _bbox: hilly())
    monkeypatch.setattr(build_graph, "ElevationSampler", lambda: HillSampler())
    build_graph.build()
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)
    # up 20 m and down again, whichever way it is ridden
    assert g.edges[1, 2, 0]["climb"] == pytest.approx(20.0, abs=2.0)
    assert g.edges[2, 1, 0]["climb"] == pytest.approx(20.0, abs=2.0)
    # and a level street is still level
    assert g.edges[3, 6, 0]["climb"] == 0.0


def test_a_crash_at_a_junction_is_one_crash_to_the_corridor(sandbox: Path) -> None:
    """The join puts a crash on every edge within 25 m — at a junction that is
    every street meeting there — so the build records which crash, and the
    where-to-build corridor counts each once."""
    import json

    import priorities

    crash = {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [-71.0981, 42.3800]},
        "properties": {},
    }
    (sandbox / "raw" / "crashes_2021.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": [crash]})
    )
    build_graph.build()
    with (sandbox / "graph.pkl").open("rb") as fh:
        g: nx.MultiDiGraph = pickle.load(fh)
    assert g.graph["crashes_joined"] == 1
    near = [d for _u, _v, d in g.edges(data=True) if d["crash_count"]]
    assert len(near) >= 4, "the crash should reach several edge-directions"
    assert all(d["crash_ids"] == (0,) for d in near)
    big_ave = [c for c in priorities.find_candidates(g) if c.name == "Big Ave"]
    assert big_ave and big_ave[0].crashes == 1


def _overpass_answer(payload: dict[str, Any]) -> Any:
    """A real requests.Response, as osmnx's own parser receives it."""
    import json

    import requests

    r = requests.Response()
    r.status_code = 200
    r._content = json.dumps(payload).encode()
    r.url = "https://overpass-api.de/api/interpreter"
    return r


def test_a_partial_overpass_answer_is_retried_not_built_from(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Overpass answers a query that timed out part-way with 200, whatever it
    had, and a `remark`. osmnx logs the remark and builds from the fragment,
    so the network could lose whole towns with nothing failing."""
    import time

    import osmnx._http as http

    calls = {"n": 0}

    def download(*_a: object, **_k: object) -> nx.MultiDiGraph:
        calls["n"] += 1
        # what osmnx's _overpass_request does with each response it gets
        remark = "runtime error: Query timed out in \"query\" at line 3 after 181 seconds."
        payload: dict[str, Any] = {"elements": []}
        if calls["n"] == 1:
            payload["remark"] = remark
        http._parse_response(_overpass_answer(payload))
        return tiny_osm()

    monkeypatch.setattr(time, "sleep", lambda _s: None)
    monkeypatch.setattr(ox, "graph_from_bbox", download)
    g = build_graph.acquire_osm((-71.2, 42.3, -71.0, 42.5))
    assert g.number_of_nodes() > 0
    # the partial answer was thrown away and the download tried again
    assert calls["n"] == 3, "bike (partial, then whole) and footpaths: three downloads"


def test_every_mirror_answering_partially_stops_the_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    import osmnx._http as http

    def download(*_a: object, **_k: object) -> nx.MultiDiGraph:
        http._parse_response(_overpass_answer({"elements": [], "remark": "out of memory"}))
        return tiny_osm()

    monkeypatch.setattr(time, "sleep", lambda _s: None)
    monkeypatch.setattr(ox, "graph_from_bbox", download)
    with pytest.raises(RuntimeError, match="partial Overpass response: out of memory"):
        build_graph.acquire_osm((-71.2, 42.3, -71.0, 42.5))


def test_a_local_rebuild_does_not_reuse_old_osm_answers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """osmnx caches every Overpass answer forever by default, so a second
    build on the same machine rebuilt the first one's OSM."""
    import os
    import time

    monkeypatch.setattr(ox.settings, "cache_folder", str(tmp_path))
    monkeypatch.setattr(ox.settings, "use_cache", True)
    monkeypatch.delenv(build_graph.OSM_CACHE_ENV, raising=False)
    build_graph.configure_osm_cache()
    assert ox.settings.use_cache is False

    old = tmp_path / "old.json"
    new = tmp_path / "new.json"
    old.write_text("{}")
    new.write_text("{}")
    two_days_ago = time.time() - 48 * 3600
    os.utime(old, (two_days_ago, two_days_ago))
    monkeypatch.setenv(build_graph.OSM_CACHE_ENV, "24")
    build_graph.configure_osm_cache()
    assert ox.settings.use_cache is True
    assert not old.exists() and new.exists()


def test_a_source_that_was_never_fetched_stops_the_build(
    sandbox: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """It used to print "(missing ... — skipping)" and build on, so a failed
    fetch became a snapshot without Cambridge's lanes, published as a good week."""
    monkeypatch.delenv(build_graph.ALLOW_MISSING_ENV)
    with pytest.raises(FileNotFoundError, match=r"fetch\.py"):
        build_graph.build()
