"""Unit tests for the classification and cost model."""

import config
import pytest
from build_graph import angle_diff, classify_osm, parse_maxspeed_mph, safer


def test_class_tables_consistent() -> None:
    assert set(config.CLASS_MULTIPLIER) == set(config.CLASS_COLOR)
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
    assert classify_osm({"highway": "residential", "cycleway": "shared_lane"}) == (
        "sharrow",
        False,
    )
    assert classify_osm({"highway": "tertiary"}) == ("moderate_street", False)


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


def test_a_bare_speed_limit_is_kmh() -> None:
    """OSM's default unit is km/h. "50" is 31 mph, and "40" is 25 mph — reading
    them as mph put 40 km/h streets over the 30 mph line."""
    assert parse_maxspeed_mph("50") == pytest.approx(31.07, abs=0.01)
    assert parse_maxspeed_mph("40 km/h") == pytest.approx(24.85, abs=0.01)
    assert parse_maxspeed_mph("25mph") == 25
    assert parse_maxspeed_mph("none") is None
    assert classify_osm({"highway": "residential", "maxspeed": "40"}) == (
        "quiet_street",
        False,
    )
    assert classify_osm({"highway": "residential", "maxspeed": "60"}) == (
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
