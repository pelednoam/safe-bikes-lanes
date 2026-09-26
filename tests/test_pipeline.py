"""Unit tests for the classification and cost model."""

import config
import networkx as nx
import pytest
from build_graph import (
    add_contraflow_edges,
    angle_diff,
    classify_osm,
    classify_road,
    facility_multiplier,
    parse_maxspeed_mph,
    safer,
)

# (table, busy-lane, busy-buffered) for each profile the pipeline costs
PROFILES = {
    "kids": (
        config.CLASS_MULTIPLIER,
        config.BUSY_ROAD_LANE_MULTIPLIER,
        config.BUSY_ROAD_BUFFERED_MULTIPLIER,
    ),
    "solo": (
        config.SOLO_CLASS_MULTIPLIER,
        config.SOLO_BUSY_ROAD_LANE_MULTIPLIER,
        config.SOLO_BUSY_ROAD_BUFFERED_MULTIPLIER,
    ),
}


def cost(tags: dict[str, object], profile: str = "kids") -> float:
    cls, busy = classify_osm(tags)
    table, busy_lane, busy_buffered = PROFILES[profile]
    return facility_multiplier(cls, classify_road(tags), busy, table, busy_lane, busy_buffered)


def test_class_tables_consistent() -> None:
    assert set(config.CLASS_MULTIPLIER) == set(config.CLASS_COLOR)
    assert set(config.CLASS_MULTIPLIER) == set(config.SOLO_CLASS_MULTIPLIER)
    assert set(config.CLASS_MULTIPLIER) == set(config.TILE_CLASSES)
    assert set(config.MAPC_ALLTRAILS_LAYERS.values()) <= set(config.CLASS_MULTIPLIER)


def test_the_tile_class_table_only_ever_grows() -> None:
    """Tile edges carry class *indices*. The first nine are what every snapshot
    has published (sorted names), and what an app built before a new class reads;
    anything new goes after them, where an old app falls back to a quiet street
    instead of pricing an unknown name as NaN."""
    legacy = config.LEGACY_TILE_CLASSES
    assert legacy == tuple(sorted(legacy)) and len(legacy) == 9
    assert config.TILE_CLASSES[: len(legacy)] == legacy
    assert len(set(config.TILE_CLASSES)) == len(config.TILE_CLASSES)


def test_unpaved_paths_are_not_the_best_class() -> None:
    """`surface` was downloaded and never read, and track and bridleway counted as
    paths: a mud horse trail was priced like the Minuteman."""
    assert classify_osm({"highway": "path", "surface": "dirt"}) == ("unpaved", False)
    assert classify_osm({"highway": "footway", "surface": "Natural"}) == ("unpaved", False)
    assert classify_osm({"highway": "bridleway"}) == ("unpaved", False)
    assert classify_osm({"highway": "track"}) == ("unpaved", False)
    # the worst part of a merged edge governs, as it does for roads
    assert classify_osm({"highway": "path", "surface": ["asphalt", "ground"]}) == (
        "unpaved",
        False,
    )
    # a pandas record says "absent" with NaN, and that is not a surface
    assert classify_osm({"highway": "track", "surface": float("nan")}) == ("unpaved", False)
    # rideable: paved, and the packed stone dust of rail trails
    assert classify_osm({"highway": "cycleway"}) == ("path", False)
    assert classify_osm({"highway": "path", "surface": "fine_gravel"}) == ("path", False)
    assert classify_osm({"highway": "path", "surface": "compacted"}) == ("path", False)
    assert classify_osm({"highway": "track", "surface": "asphalt"}) == ("path", False)
    assert classify_osm({"highway": "track", "tracktype": "grade1"}) == ("path", False)


def test_unpaved_sits_between_a_quiet_street_and_a_painted_lane() -> None:
    m = config.CLASS_MULTIPLIER
    assert m["quiet_street"] < m["unpaved"] < m["lane"]
    # off the road, so still kid-safe for the where-to-build analysis
    assert m["unpaved"] <= config.SAFE_MULT_MAX
    s = config.SOLO_CLASS_MULTIPLIER
    assert s["path"] < s["unpaved"] <= s["lane"]
    assert set(config.CAMBRIDGE_FACILITY_CLASS.values()) <= set(config.CLASS_MULTIPLIER)


def test_protected_is_cheapest() -> None:
    m = config.CLASS_MULTIPLIER
    assert m["path"] <= m["quiet_street"] < m["lane"] < m["sharrow"] < m["busy_street"]


def test_classify_cycleway() -> None:
    assert classify_osm({"highway": "cycleway"}) == ("path", False)
    assert classify_osm({"highway": "residential"}) == ("quiet_street", False)
    assert classify_osm({"highway": "primary"}) == ("busy_street", True)
    assert classify_osm({"highway": "primary", "cycleway:right": "track"}) == ("separated", True)
    assert classify_osm({"highway": "secondary", "cycleway": "lane"}) == ("lane", True)
    # the class shown to riders is the facility that is there...
    assert classify_osm({"highway": "residential", "cycleway": "shared_lane"}) == (
        "sharrow",
        False,
    )
    # ...but it is not priced above the street it is painted on (this test used
    # to stop at the class, and the class alone priced it at 6.0 against 1.4)
    assert cost({"highway": "residential", "cycleway": "shared_lane"}) == (
        config.CLASS_MULTIPLIER["quiet_street"]
    )
    assert classify_osm({"highway": "tertiary"}) == ("moderate_street", False)


def test_a_sharrow_on_a_busy_road_costs_the_busy_road() -> None:
    """A sharrow is a marking, not a space: on an arterial it cost 6.0 against
    the bare arterial's 25 — a quarter of the price for the same traffic."""
    for profile, (table, _lane, _buf) in PROFILES.items():
        assert cost({"highway": "primary", "cycleway": "shared_lane"}, profile) == (
            table["busy_street"]
        ), profile
    # lanes and buffered lanes on busy roads keep their own (still high) price
    assert cost({"highway": "primary", "cycleway": "lane"}) == config.BUSY_ROAD_LANE_MULTIPLIER
    assert cost({"highway": "secondary", "cycleway": "buffered_lane"}, "solo") == (
        config.SOLO_BUSY_ROAD_BUFFERED_MULTIPLIER
    )


def test_paint_can_only_help() -> None:
    """A marked facility never costs more than the same street without it.
    Residential alone was 1.4; with a painted lane 3.0, with sharrows 6.0."""
    for profile in PROFILES:
        for highway in ("residential", "service", "tertiary", "primary", "unclassified"):
            bare = cost({"highway": highway}, profile)
            for mark in ("lane", "shared_lane", "buffered_lane", "track"):
                marked = cost({"highway": highway, "cycleway": mark}, profile)
                assert marked <= bare, (profile, highway, mark, marked, bare)
    # and it still helps where it should: a lane on a moderate street is a lane
    assert cost({"highway": "tertiary", "cycleway": "lane"}) == config.CLASS_MULTIPLIER["lane"]
    assert cost({"highway": "residential", "cycleway": "lane"}) == (
        config.CLASS_MULTIPLIER["quiet_street"]
    )


def test_a_separately_mapped_cycleway_does_not_protect_the_road() -> None:
    """`cycleway=separate` says the bike facility is its own way nearby; the
    carriageway itself has none, so it must cost what the bare road costs."""
    assert classify_osm({"highway": "primary", "cycleway:right": "separate"}) == (
        "busy_street",
        True,
    )
    assert classify_osm({"highway": "residential", "cycleway:both": "separate"}) == (
        "quiet_street",
        False,
    )
    # not an OSM value; it must not earn protection either
    assert classify_osm({"highway": "secondary", "cycleway": "separated"}) == (
        "busy_street",
        True,
    )
    # a painted lane on the other side still counts for what it is
    assert classify_osm(
        {"highway": "secondary", "cycleway:right": "separate", "cycleway:left": "lane"}
    ) == ("lane", True)


def test_classify_list_tags() -> None:
    # simplified edges can carry lists; a busy component governs the road flag
    cls, busy = classify_osm({"highway": ["residential", "secondary"]})
    assert busy and cls == "busy_street"


def test_fast_residential_escalates() -> None:
    assert classify_osm({"highway": "residential", "maxspeed": "35 mph"}) == (
        "moderate_street",
        False,
    )


def test_parse_maxspeed() -> None:
    assert parse_maxspeed_mph("25 mph") == 25
    assert parse_maxspeed_mph(["30 mph", "25 mph"]) == 30
    assert parse_maxspeed_mph(None) is None
    assert parse_maxspeed_mph("walk") is None


def test_a_merged_edge_is_as_fast_as_its_fastest_part() -> None:
    # the docstring always promised the worst part; the code took the first
    assert parse_maxspeed_mph(["25 mph", "35 mph"]) == 35
    assert classify_osm({"highway": "residential", "maxspeed": ["25 mph", "35 mph"]}) == (
        "moderate_street",
        False,
    )


def test_speed_units() -> None:
    """An explicit km/h is converted. A bare number stays mph: every sign here
    is in mph, so a bare "40" is a 40 mph road missing its unit (see
    parse_maxspeed_mph)."""
    assert parse_maxspeed_mph("40 km/h") == pytest.approx(24.85, abs=0.01)
    assert parse_maxspeed_mph("25mph") == 25
    assert parse_maxspeed_mph("none") is None
    assert parse_maxspeed_mph("40") == 40
    assert classify_osm({"highway": "residential", "maxspeed": "60 km/h"}) == (
        "moderate_street",
        False,
    )


def test_a_multilane_residential_street_is_not_quiet() -> None:
    """Three lanes or more is a road built to move traffic, whatever its
    highway tag; `lanes` was downloaded and never read."""
    assert classify_osm({"highway": "residential", "lanes": "4"}) == ("moderate_street", False)
    assert classify_osm({"highway": "residential", "lanes": ["2", "3"]}) == (
        "moderate_street",
        False,
    )
    assert classify_osm({"highway": "residential", "lanes": "3", "oneway": True}) == (
        "moderate_street",
        False,
    )
    # an ordinary two-way street is still quiet
    assert classify_osm({"highway": "residential", "lanes": "2"}) == ("quiet_street", False)
    # and so is a one-way lanes=2 street: here that tag counts the parking lane
    # (see build_graph.multilane), so it is not evidence of two travel lanes
    assert classify_osm({"highway": "residential", "lanes": "2", "oneway": True}) == (
        "quiet_street",
        False,
    )


def test_safer_picks_lower_stress() -> None:
    assert safer("busy_street", "separated") == "separated"
    assert safer(None, "lane") == "lane"
    assert safer("path", None) == "path"


def test_angle_diff_wraps() -> None:
    assert angle_diff(179, 1) == 2
    assert angle_diff(90, 0) == 90


def side(tags: dict[str, object], reversed_: bool) -> str:
    return classify_osm({**tags, "reversed": reversed_})[0]


def test_a_lane_on_one_side_serves_one_direction() -> None:
    """Traffic keeps right: on a two-way street cycleway:right serves riders
    going with the way and cycleway:left riders going against it. Both
    directions used to get the lane."""
    street = {"highway": "residential", "oneway": False, "cycleway:left": "lane"}
    assert side(street, reversed_=True) == "lane"
    assert side(street, reversed_=False) == "quiet_street"
    street = {"highway": "tertiary", "oneway": False, "cycleway:right": "lane"}
    assert side(street, reversed_=False) == "lane"
    assert side(street, reversed_=True) == "moderate_street"
    # both sides, or no side named: both directions
    assert side({"highway": "tertiary", "cycleway": "lane"}, reversed_=True) == "lane"
    assert side({"highway": "tertiary", "cycleway:both": "lane"}, reversed_=True) == "lane"


def test_on_a_one_way_street_every_side_serves_the_one_direction() -> None:
    # Boston and Cambridge paint many one-way streets' lanes on the left
    street = {"highway": "tertiary", "oneway": True, "cycleway:left": "lane"}
    assert side(street, reversed_=False) == "lane"


def test_a_contraflow_lane_is_for_riding_against_the_traffic() -> None:
    street = {
        "highway": "tertiary", "oneway": True, "oneway:bicycle": "no", "cycleway:left": "lane",
    }
    assert side(street, reversed_=True) == "lane"  # the contraflow edge
    assert side(street, reversed_=False) == "moderate_street"  # with traffic: no lane
    # the older tagging says the same on `cycleway`
    older = {"highway": "tertiary", "oneway": True, "cycleway": "opposite_lane"}
    assert side(older, reversed_=True) == "lane"
    assert side(older, reversed_=False) == "moderate_street"
    track = {"highway": "tertiary", "oneway": True, "cycleway": "opposite_track"}
    assert side(track, reversed_=True) == "separated"
    # plain `opposite` is permission with no facility
    bare = {"highway": "tertiary", "oneway": True, "cycleway": "opposite"}
    assert side(bare, reversed_=True) == "moderate_street"


def test_contraflow_streets_get_their_bike_direction() -> None:
    """osmnx builds directions from `oneway` alone, so the router could not
    ride a contraflow lane it drew on the map."""
    g = nx.MultiDiGraph()
    one_way = {"highway": "residential", "oneway": True, "reversed": False}
    g.add_edge(1, 2, osmid=10, **one_way, **{"oneway:bicycle": "no"})
    g.add_edge(3, 4, osmid=11, **one_way, cycleway="opposite_lane")
    g.add_edge(5, 6, osmid=12, **one_way)  # no contraflow: stays one-way
    # a merged chain: "no" may be the tag of only some of its ways
    g.add_edge(7, 8, osmid=[13, 14], **one_way, **{"oneway:bicycle": "no"})
    assert add_contraflow_edges(g) == 2
    assert g.has_edge(2, 1) and g.has_edge(4, 3)
    assert not g.has_edge(6, 5) and not g.has_edge(8, 7)
    back = g.get_edge_data(2, 1)[0]
    assert back["contraflow"] is True and back["reversed"] is True
    assert classify_osm(g.get_edge_data(4, 3)[0])[0] == "lane"
    # idempotent: a street that already runs both ways is left alone
    assert add_contraflow_edges(g) == 0
