"""Unit tests for the classification and cost model."""

import config
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


def test_safer_picks_lower_stress() -> None:
    assert safer("busy_street", "separated") == "separated"
    assert safer(None, "lane") == "lane"
    assert safer("path", None) == "path"


def test_angle_diff_wraps() -> None:
    assert angle_diff(179, 1) == 2
    assert angle_diff(90, 0) == 90
