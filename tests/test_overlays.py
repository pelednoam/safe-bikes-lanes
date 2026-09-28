"""Tests for the spatial join that decides what protection a street has.

`overlay_match` is the most consequential function in the pipeline: it decides
whether the app tells a parent a street is separated, painted or nothing at all.
It had no tests. Everything downstream — the router's costs, the safety
heatmap, the where-to-build ranking — inherits whatever it gets wrong.
"""

import json
import math
import random
from pathlib import Path
from typing import Any

import build_graph
import config
import geopandas as gpd
import pytest
from shapely.geometry import LineString, Point, Polygon

# a metric CRS, because overlay_match works in metres
CRS = "EPSG:26986"  # Massachusetts state plane


def edges_frame(rows: list[tuple[LineString, bool]]) -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"geometry": [g for g, _ in rows], "is_pathlike": [p for _, p in rows]},
        crs=CRS,
    )


def overlay_frame(rows: list[tuple[LineString | Polygon, str]]) -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"geometry": [g for g, _ in rows], "cls": [c for _, c in rows]}, crs=CRS
    )


def test_a_facility_running_along_a_street_matches_it() -> None:
    street = LineString([(0, 0), (100, 0)])
    facility = LineString([(0, 3), (100, 3)])  # 3 m to the side, same bearing
    got = build_graph.overlay_match(
        edges_frame([(street, False)]), overlay_frame([(facility, "separated")]), radius=18.0
    )
    assert got == [0]


def test_a_cross_street_facility_does_not_match() -> None:
    """The bearing gate. Without it, a protected lane on the avenue would mark
    every side street crossing it as protected too."""
    street = LineString([(0, 0), (100, 0)])
    crossing = LineString([(50, -50), (50, 50)])  # perpendicular, passes right through
    got = build_graph.overlay_match(
        edges_frame([(street, False)]), overlay_frame([(crossing, "separated")]), radius=18.0
    )
    assert got == [None]


def test_a_path_never_upgrades_the_road_beside_it() -> None:
    """An off-street path often runs parallel to the roadway a few metres away.
    Matching it to the road would route children onto the road as if it were
    the path."""
    road = LineString([(0, 0), (100, 0)])
    path_geom = LineString([(0, 5), (100, 5)])
    frame = overlay_frame([(path_geom, "path")])
    assert build_graph.overlay_match(edges_frame([(road, False)]), frame, 18.0) == [None]
    # the same overlay does match an actual path-like edge
    assert build_graph.overlay_match(edges_frame([(road, True)]), frame, 18.0) == [0]


def test_an_unpaved_trail_never_upgrades_the_road_beside_it() -> None:
    """The same rule for the other off-street class: MAPC's unimproved trails
    now arrive as "unpaved", and that must not turn a parallel arterial into a
    dirt path at 2.0."""
    road = LineString([(0, 0), (100, 0)])
    trail = overlay_frame([(LineString([(0, 5), (100, 5)]), "unpaved")])
    assert build_graph.overlay_match(edges_frame([(road, False)]), trail, 18.0) == [None]
    assert build_graph.overlay_match(edges_frame([(road, True)]), trail, 18.0) == [0]


def test_the_nearest_of_several_candidates_wins() -> None:
    street = LineString([(0, 0), (100, 0)])
    far = LineString([(0, 15), (100, 15)])
    near = LineString([(0, 2), (100, 2)])
    got = build_graph.overlay_match(
        edges_frame([(street, False)]),
        overlay_frame([(far, "lane"), (near, "separated")]),
        radius=18.0,
    )
    assert got == [1]  # the separated one, because it's closer


def test_nothing_beyond_the_radius_matches() -> None:
    street = LineString([(0, 0), (100, 0)])
    distant = LineString([(0, 40), (100, 40)])
    got = build_graph.overlay_match(
        edges_frame([(street, False)]), overlay_frame([(distant, "separated")]), radius=18.0
    )
    assert got == [None]


def test_a_polygon_overlay_matches_on_distance_alone() -> None:
    """Corridor areas (Somerville's high-crash polygons) have no bearing to
    compare, so the angle gate must not silently reject them."""
    street = LineString([(0, 0), (100, 0)])
    area = Polygon([(40, -10), (60, -10), (60, 10), (40, 10)])
    got = build_graph.overlay_match(
        edges_frame([(street, False)]), overlay_frame([(area, "separated")]), radius=18.0
    )
    assert got == [0]


def test_bearing_near_and_angle_diff_agree_about_direction() -> None:
    east = LineString([(0, 0), (100, 0)])
    north = LineString([(0, 0), (0, 100)])
    mid = Point(50, 0)
    e = build_graph.bearing_near(east, mid)
    n = build_graph.bearing_near(north, Point(0, 50))
    assert build_graph.angle_diff(e, e) == pytest.approx(0.0, abs=1e-6)
    # perpendicular is 90 degrees apart however the two are signed
    assert build_graph.angle_diff(e, n) == pytest.approx(90.0, abs=1.0)


# ── overlay loaders ────────────────────────────────────────────────────────


def _write(raw: Path, name: str, features: list[dict[str, object]]) -> None:
    (raw / name).write_text(json.dumps({"type": "FeatureCollection", "features": features}))


def _line_feature(props: dict[str, object]) -> dict[str, object]:
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": [[-71.10, 42.38], [-71.09, 42.38]]},
        "properties": props,
    }


def test_a_missing_source_is_fatal_unless_allowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """This used to assert the opposite — a missing layer skipped with a line
    in the log — and that is how a failed fetch became a published snapshot
    without the layer. Missing is now an error; building without a source is
    something asked for (ALLOW_MISSING_SOURCES=1), and then each overlay is
    simply absent."""
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    monkeypatch.delenv(build_graph.ALLOW_MISSING_ENV, raising=False)
    with pytest.raises(FileNotFoundError, match=r"nope\.geojson"):
        build_graph.load_geojson("nope.geojson")
    monkeypatch.setenv(build_graph.ALLOW_MISSING_ENV, "1")
    assert build_graph.load_geojson("nope.geojson") is None
    assert build_graph.cambridge_overlay() is None
    assert build_graph.newton_overlay() is None
    assert build_graph.salem_overlay() is None


def test_cambridge_keeps_built_facilities_and_drops_planned_ones(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cambridge encodes this as two numeric fields, not a yes/no flag: a built
    facility carries an ExistingFacility code, a planned one carries only
    PlannedFacility. Reading it the other way would route children onto lanes
    that don't exist yet, which is the one mistake this data must never make.
    """
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    _write(
        tmp_path,
        "cambridge_bike_facilities.geojson",
        [
            _line_feature({"FacilityType": "Separated Bike Lane", "ExistingFacility": 500.0}),
            _line_feature({"FacilityType": "Bike Lane", "ExistingFacility": 100.0}),
            # planned only: no existing code
            _line_feature(
                {
                    "FacilityType": "Separated Bike Lane",
                    "ExistingFacility": None,
                    "PlannedFacility": 9500.0,
                }
            ),
            _line_feature({"FacilityType": "Something New", "ExistingFacility": 100.0}),
        ],
    )
    out = build_graph.cambridge_overlay()
    assert out is not None
    # the planned separated lane and the unrecognised type are both gone
    assert sorted(out["cls"]) == ["lane", "separated"]


def test_salem_drops_its_in_design_lanes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    _write(
        tmp_path,
        "salem_bike_facilities.geojson",
        [
            _line_feature({"TYPE": "Protected Bike Lane"}),
            _line_feature({"TYPE": "Protected Bike Lane - In Design"}),
        ],
    )
    out = build_graph.salem_overlay()
    assert out is not None
    assert list(out["cls"]) == ["separated"]


def test_mapc_only_brings_the_built_layers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config, "RAW_DIR", tmp_path)
    # fetch_mapc resolves the layer id to a class and stores it as mapc_cls
    _write(
        tmp_path,
        "mapc_bike_network.geojson",
        [
            _line_feature({"mapc_cls": "separated"}),
            _line_feature({"mapc_cls": "lane"}),
            _line_feature({"mapc_cls": None}),  # a layer we don't take
        ],
    )
    out = build_graph.mapc_overlay()
    assert out is not None
    assert sorted(out["cls"]) == ["lane", "separated"]


def test_class_helpers_agree_with_the_config_tables() -> None:
    # a class table and its multiplier table drifting apart would silently
    # mis-cost a whole class of street
    for cls in config.CLASS_MULTIPLIER:
        assert build_graph.mult(cls) == config.CLASS_MULTIPLIER[cls]
    # an unknown class raises rather than defaulting: a silent fallback would
    # cost an unrecognised street as if it were quiet
    with pytest.raises(KeyError):
        build_graph.mult("not a class")
    # safer() keeps the better of two claims about the same street
    assert build_graph.safer("lane", "separated") == "separated"
    assert build_graph.safer("separated", None) == "separated"
    assert build_graph.safer(None, None) is None
    assert build_graph.safer("busy_street", "quiet_street") == "quiet_street"


def test_listy_normalises_osm_multivalue_tags() -> None:
    # OSM gives a list when a way carries two values for one key
    assert build_graph.listy(["a", "b"]) == ["a", "b"]
    assert build_graph.listy("a") == ["a"]
    # a missing tag wraps rather than vanishing, so callers can index [0] and
    # get None instead of an IndexError
    assert build_graph.listy(None) == [None]


# ── classifying a street from its OSM tags ─────────────────────────────────
# The fallback for everywhere no city publishes a facility layer, which is most
# of the 130 towns. Four cases were covered; the rest of the table wasn't.


def test_cycleway_tags_become_their_protection_class() -> None:
    cases: list[tuple[dict[str, str], str]] = [
        ({"highway": "cycleway"}, "path"),
        ({"highway": "path", "bicycle": "designated"}, "path"),
        ({"highway": "footway", "bicycle": "designated"}, "path"),
        ({"highway": "residential", "cycleway": "track"}, "separated"),
        ({"highway": "residential", "cycleway:right": "track"}, "separated"),
        ({"highway": "secondary", "cycleway": "lane"}, "lane"),
        ({"highway": "secondary", "cycleway": "shared_lane"}, "sharrow"),
        ({"highway": "residential"}, "quiet_street"),
        ({"highway": "living_street"}, "quiet_street"),
        ({"highway": "service"}, "service"),
        ({"highway": "tertiary"}, "moderate_street"),
        ({"highway": "primary"}, "busy_street"),
        ({"highway": "trunk"}, "busy_street"),
    ]
    for tags, expected in cases:
        cls, _busy = build_graph.classify_osm(tags)
        assert cls == expected, f"{tags} -> {cls}, expected {expected}"


def test_a_road_is_busy_by_class_or_by_speed() -> None:
    _cls, busy = build_graph.classify_osm({"highway": "primary"})
    assert busy
    _cls, quiet = build_graph.classify_osm({"highway": "residential"})
    assert not quiet
    # a residential street posted at 35 mph is not a quiet street
    cls_fast, busy_fast = build_graph.classify_osm(
        {"highway": "residential", "maxspeed": "35 mph"}
    )
    assert cls_fast != "quiet_street" or busy_fast


def test_maxspeed_parses_the_forms_osm_actually_uses() -> None:
    assert build_graph.parse_maxspeed_mph("25 mph") == pytest.approx(25.0)
    # a merged edge is as fast as its fastest part (this asserted the first, 25)
    assert build_graph.parse_maxspeed_mph(["25 mph", "30 mph"]) == pytest.approx(30.0)
    assert build_graph.parse_maxspeed_mph(None) is None
    assert build_graph.parse_maxspeed_mph("walk") is None
    assert build_graph.parse_maxspeed_mph("") is None

    # A unitless value is km/h by OSM convention, and this reads it as mph — so
    # "30" becomes 30 mph rather than 18.6. Documented rather than fixed: US
    # data almost always carries the unit, and the error is conservative (the
    # street looks faster, so routing avoids it more), which is the safe
    # direction for a tool that puts children on streets.
    assert build_graph.parse_maxspeed_mph("30") == pytest.approx(30.0)


def test_the_bbox_comes_from_config() -> None:
    west, south, east, north = build_graph._bbox()
    assert west == config.BBOX_WEST
    assert north == config.BBOX_NORTH
    assert west < east and south < north


def test_mem_reports_without_exploding(capsys: pytest.CaptureFixture[str]) -> None:
    # a progress helper on an 11 GB build: it must never be the thing that fails
    build_graph.mem("a stage")
    assert "a stage" in capsys.readouterr().out


def _reference_match(
    edges: gpd.GeoDataFrame, overlay: gpd.GeoDataFrame, radius: float, max_angle: float = 30.0
) -> list[int | None]:
    """The per-edge loop overlay_match used to be, kept as the specification
    the bulk version must agree with."""
    overlay = overlay.explode(index_parts=False).reset_index(drop=True)
    out: list[int | None] = []
    for geom, is_path in zip(edges.geometry, edges["is_pathlike"], strict=True):
        mid = geom.interpolate(0.5, normalized=True)
        brg = build_graph.bearing_near(geom, mid)
        best: tuple[float, int] | None = None
        for pos, (og, cls) in enumerate(zip(overlay.geometry, overlay["cls"], strict=True)):
            if cls in build_graph.OFFSTREET and not is_path:
                continue
            d = og.distance(mid)
            if d > radius:
                continue
            if og.geom_type == "LineString" and (
                build_graph.angle_diff(brg, build_graph.bearing_near(og, mid)) > max_angle
            ):
                continue
            if best is None or (d, pos) < best:
                best = (d, pos)
        out.append(None if best is None else best[1])
    return out


def test_the_bulk_match_agrees_with_the_per_edge_loop() -> None:
    rng = random.Random(7)
    streets: list[tuple[LineString, bool]] = []
    for _ in range(300):
        x, y = rng.uniform(0, 2000), rng.uniform(0, 2000)
        ang, length = rng.uniform(0, math.pi), rng.uniform(20, 300)
        end = (x + length * math.cos(ang), y + length * math.sin(ang))
        streets.append((LineString([(x, y), end]), rng.random() < 0.3))
    features: list[tuple[LineString | Polygon, str]] = []
    for _ in range(200):
        g, _p = streets[rng.randrange(len(streets))]
        dx, dy = rng.uniform(-20, 20), rng.uniform(-20, 20)
        shifted = LineString([(px + dx, py + dy) for px, py in g.coords])
        features.append((shifted, rng.choice(["lane", "path", "separated", "unpaved"])))
    features.append((Point(1000, 1000).buffer(200), "corridor"))
    edges, overlay = edges_frame(streets), overlay_frame(features)
    got = build_graph.overlay_match(edges, overlay, 18.0)
    assert got == _reference_match(edges, overlay, 18.0)
    assert sum(g is not None for g in got) > 50  # the comparison is not vacuous


def test_the_match_asks_the_spatial_index_once_not_once_per_edge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A query and a pandas .iloc per edge: 900k edges against MassDOT's LTS
    layer at its real size (251,046 features here) was the slow half of the
    build."""
    import geopandas.sindex

    calls = {"n": 0}
    original = geopandas.sindex.SpatialIndex.query

    def counting(self: Any, *args: Any, **kwargs: Any) -> Any:
        calls["n"] += 1
        return original(self, *args, **kwargs)

    monkeypatch.setattr(geopandas.sindex.SpatialIndex, "query", counting)
    streets = [(LineString([(0, i * 50), (100, i * 50)]), False) for i in range(40)]
    facilities = [(LineString([(0, i * 50 + 3), (100, i * 50 + 3)]), "lane") for i in range(40)]
    got = build_graph.overlay_match(edges_frame(streets), overlay_frame(facilities), 18.0)
    assert got == list(range(40))
    assert calls["n"] == 1


# --- what an official high-stress rating and a person's override do to a price


def price(cls: str, road_cls: str, busy: bool) -> float:
    """What the young-kids profile pays per metre, as the router will."""
    import weights

    return weights.profile_multiplier("young_kids", cls, road_cls, busy)


def test_paint_on_a_street_rated_high_stress_is_priced_as_paint_on_a_busy_road() -> None:
    # A tertiary street (moderate) that MassDOT rates LTS 3: its road escalates
    # to busy, and so must the price of the paint on it. Raising road_cls alone
    # left the lane at 3 and a sharrow at 6, a quiet street's prices.
    road, busy = build_graph.escalate_road("moderate_street", False)
    assert (road, busy) == ("busy_street", True)
    assert price("lane", road, busy) == price("lane", "busy_street", True)
    assert price("lane", road, busy) > price("lane", "moderate_street", False)
    assert price("sharrow", road, busy) == price("busy_street", "busy_street", True)


def test_a_quiet_street_rated_high_stress_is_moderate_not_busy() -> None:
    assert build_graph.escalate_road("quiet_street", False) == ("moderate_street", False)
    # a road that was busy already stays busy, and a path is not a road
    assert build_graph.escalate_road("busy_street", True) == ("busy_street", True)
    assert build_graph.escalate_road("path", False) == ("path", False)


def test_a_lane_override_on_an_arterial_keeps_the_arterial_under_it() -> None:
    # An override saying "there is a lane here" said nothing about the road, but
    # it used to overwrite road_cls too: min(10, 3) = 3 for paint on a primary.
    cls, road, busy = build_graph.apply_override("lane", "busy_street", True)
    assert (cls, road, busy) == ("lane", "busy_street", True)
    assert price(cls, road, busy) == price("lane", "busy_street", True)
    for facility in build_graph.ON_ROAD_FACILITIES:
        _, road, busy = build_graph.apply_override(facility, "busy_street", True)
        assert (road, busy) == ("busy_street", True), facility


def test_an_override_naming_the_street_says_what_the_street_is() -> None:
    # "this is really a quiet street" and "this is a busy road" are about the road
    assert build_graph.apply_override("quiet_street", "busy_street", True) == (
        "quiet_street",
        "quiet_street",
        False,
    )
    assert build_graph.apply_override("busy_street", "quiet_street", False) == (
        "busy_street",
        "busy_street",
        True,
    )
    assert build_graph.apply_override("path", "busy_street", True) == ("path", "path", False)


def test_the_on_road_facilities_are_classes_the_model_has() -> None:
    import weights

    assert build_graph.ON_ROAD_FACILITIES <= set(weights.CLASSES)
