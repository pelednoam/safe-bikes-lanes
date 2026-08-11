"""Tests for the where-to-build ranking.

The module's whole claim is that a short link between two large kid-safe islands
beats a long street that connects nothing. If that ordering ever inverts, the
output stops being an argument a city can act on, so it is asserted directly on
hand-built graphs rather than on real data.
"""

import csv
import json
import math
import pickle
import tempfile
from pathlib import Path
from typing import NamedTuple

import config
import networkx as nx
import numpy as np
import priorities
import pytest


def _lonlat(x_m: float, lat: float = 42.38) -> tuple[float, float]:
    """Metres east of a fixed origin, as a lon/lat pair."""
    return (-71.1 + x_m / (111_320.0 * math.cos(math.radians(lat))), lat)


class GraphBuilder:
    """A tiny straight-line network: nodes at metre offsets, edges between them."""

    def __init__(self) -> None:
        self.g = nx.MultiDiGraph()

    def node(self, n: int, x_m: float, lat: float = 42.38) -> None:
        lon, la = _lonlat(x_m, lat)
        self.g.add_node(n, x=lon, y=la)

    def edge(
        self,
        u: int,
        v: int,
        length: float,
        cls: str,
        name: str = "",
        crashes: int = 0,
    ) -> None:
        mult = {
            "path": 1.0, "separated": 1.0, "buffered": 2.0, "quiet_street": 1.4,
            "lane": 3.0, "sharrow": 6.0, "moderate_street": 8.0, "busy_street": 25.0,
        }[cls]
        for a, b in ((u, v), (v, u)):
            self.g.add_edge(
                a, b, length=length, cls=cls, stress_mult=mult, name=name,
                crash_count=crashes,
                # what build_graph writes: perceived cost the router travels on
                weight=length * mult,
            )


@pytest.fixture
def severed() -> nx.MultiDiGraph:
    """Two quiet grids, 120 m of arterial between them, and a long arterial
    elsewhere that joins nothing. The short link is the whole point."""
    b = GraphBuilder()
    for i in range(6):
        b.node(i, i * 200)
    # island A: 0-1-2 quiet
    b.edge(0, 1, 200, "quiet_street", "Elm St")
    b.edge(1, 2, 200, "quiet_street", "Elm St")
    # the gap: 2-3, short and hostile
    b.edge(2, 3, 120, "busy_street", "Broadway")
    # island B: 3-4-5 quiet
    b.edge(3, 4, 200, "quiet_street", "Oak St")
    b.edge(4, 5, 200, "quiet_street", "Oak St")
    # a long arterial hanging off island B, joining nothing
    b.node(6, 1400)
    b.node(7, 2000)
    b.edge(5, 6, 600, "busy_street", "Long Ave")
    b.edge(6, 7, 600, "busy_street", "Long Ave")
    return b.g


def test_short_link_between_islands_outranks_long_street_to_nowhere(
    severed: nx.MultiDiGraph,
) -> None:
    island_of, island_m = priorities.safe_islands(severed)
    cands = priorities.find_candidates(severed)
    priorities.score_severance(cands, island_of, island_m)
    priorities.score_all(cands)
    cands.sort(key=lambda c: c.score, reverse=True)

    assert cands, "expected candidates from the unsafe streets"
    assert cands[0].name == "Broadway"
    # the gain is the SMALLER island it unlocks (both are 400 m here), not the
    # sum: summing let every candidate touching the region-wide island claim it
    assert cands[0].join_m == pytest.approx(400.0)
    nowhere = next(c for c in cands if c.name == "Long Ave")
    assert nowhere.join_m == 0.0
    assert cands[0].score > nowhere.score


def test_islands_are_found_and_measured(severed: nx.MultiDiGraph) -> None:
    _island_of, island_m = priorities.safe_islands(severed)
    sizes = sorted((round(m) for m in island_m.values() if m > 0), reverse=True)
    # two 400 m quiet grids, nothing else safe
    assert sizes == [400, 400]


def test_corridor_merges_by_name_through_shared_nodes() -> None:
    """A street should come out as one project, not one per OSM way segment."""
    b = GraphBuilder()
    for i in range(4):
        b.node(i, i * 100)
    for i in range(3):
        b.edge(i, i + 1, 100, "moderate_street", "Pearl St")
    cands = priorities.find_candidates(b.g)
    pearl = [c for c in cands if c.name == "Pearl St"]
    assert len(pearl) == 1
    assert pearl[0].length_m == pytest.approx(300.0)


def test_same_name_split_by_a_protected_stretch_is_two_projects() -> None:
    """Two unsafe runs of one street either side of a protected block are two
    separate builds; merging them would inflate cost and claimed benefit."""
    b = GraphBuilder()
    for i in range(5):
        b.node(i, i * 100)
    b.edge(0, 1, 100, "moderate_street", "Hampshire St")
    b.edge(1, 2, 100, "separated", "Hampshire St")  # already built
    b.edge(2, 3, 100, "moderate_street", "Hampshire St")
    b.edge(3, 4, 100, "moderate_street", "Hampshire St")
    hampshire = [c for c in priorities.find_candidates(b.g) if c.name == "Hampshire St"]
    assert len(hampshire) == 2
    assert sorted(round(c.length_m) for c in hampshire) == [100, 200]


def test_painted_lane_is_not_kid_safe_but_buffered_is() -> None:
    """The kid-safe threshold is the module's central judgement, so pin it."""
    assert priorities.is_kid_safe({"stress_mult": 1.0})   # path / separated
    assert priorities.is_kid_safe({"stress_mult": 1.4})   # quiet street
    assert priorities.is_kid_safe({"stress_mult": 2.0})   # buffered
    assert not priorities.is_kid_safe({"stress_mult": 3.0})   # painted lane
    assert not priorities.is_kid_safe({"stress_mult": 25.0})  # arterial
    # a missing multiplier must not be treated as safe
    assert not priorities.is_kid_safe({})


def test_crash_weighting_is_monotone() -> None:
    """Between two otherwise identical streets, the one with a crash history
    ranks higher — and per km, so a long street can't win on raw count."""
    b = GraphBuilder()
    for i in range(5):
        b.node(i, i * 200)
    b.edge(0, 1, 200, "moderate_street", "Quiet Ave", crashes=0)
    b.edge(2, 3, 200, "moderate_street", "Crashy St", crashes=5)
    cands = priorities.find_candidates(b.g)
    priorities.score_all(cands)
    by_name = {c.name: c for c in cands}
    assert by_name["Crashy St"].crashes_per_km > by_name["Quiet Ave"].crashes_per_km
    assert by_name["Crashy St"].score > by_name["Quiet Ave"].score


def test_a_programme_length_street_is_never_a_candidate() -> None:
    b = GraphBuilder()
    b.node(0, 100)
    b.node(1, 5000)
    b.edge(0, 1, 4900, "busy_street", "Route 2")  # over CANDIDATE_MAX_M
    assert "Route 2" not in {c.name for c in priorities.find_candidates(b.g)}


def test_short_stubs_are_dropped_but_short_connectors_are_not() -> None:
    """The length floor exists for kerb cuts and driveway stubs. Applying it in
    find_candidates also threw away 12 m links between two safe islands — the
    cheapest real projects there are — before anything could measure them.
    """
    b = GraphBuilder()
    # a stub joining nothing
    b.node(0, 0)
    b.node(1, 10)
    b.edge(0, 1, 10, "busy_street", "Kerb Cut")
    # a 14 m hostile link between two quiet grids
    for i, x in ((2, 500), (3, 700), (4, 714), (5, 914)):
        b.node(i, x)
    b.edge(2, 3, 200, "quiet_street", "West St")
    b.edge(3, 4, 14, "busy_street", "The Pinch")
    b.edge(4, 5, 200, "quiet_street", "East St")

    island_of, island_m = priorities.safe_islands(b.g)
    cands = priorities.find_candidates(b.g)
    # both survive the first pass now, so both can be measured
    assert {"Kerb Cut", "The Pinch"} <= {c.name for c in cands}
    priorities.score_severance(cands, island_of, island_m)
    kept = {c.name: c for c in priorities.classify_and_prune(cands)}
    assert "Kerb Cut" not in kept  # joins nothing, so the floor applies
    assert "The Pinch" in kept
    # one location to treat, not a corridor to protect
    assert kept["The Pinch"].kind == "spot_fix"


def test_an_already_signalized_link_stays_a_corridor() -> None:
    b = GraphBuilder()
    for i, x in ((0, 0), (1, 200), (2, 214), (3, 414)):
        b.node(i, x)
    b.edge(0, 1, 200, "quiet_street", "West St")
    b.edge(1, 2, 14, "busy_street", "Signalled Link")
    b.edge(2, 3, 200, "quiet_street", "East St")
    b.g.nodes[1]["highway"] = "traffic_signals"
    island_of, island_m = priorities.safe_islands(b.g)
    cands = priorities.find_candidates(b.g)
    priorities.score_severance(cands, island_of, island_m)
    kept = {c.name: c for c in priorities.classify_and_prune(cands)}
    # it may still need something, but a spot fix at a signalized junction is a
    # different (and probably bigger) job than one at an unsignalized pinch
    assert kept["Signalled Link"].kind == "corridor"


def test_spot_fixes_are_costed_as_a_location_not_a_length() -> None:
    """A 14 m spot fix costed per metre reads as a rounding error, and a city
    comparing benefit per dollar would rank it absurdly high."""
    crossing = priorities.Candidate(
        pid="x", name="Main St", kind="spot_fix", cls="busy_street", length_m=14.0
    )
    corridor = priorities.Candidate(
        pid="c", name="Main St", kind="corridor", cls="busy_street", length_m=14.0
    )
    longer_crossing = priorities.Candidate(
        pid="x2", name="Main St", kind="spot_fix", cls="busy_street", length_m=40.0
    )
    # a signal costs what a signal costs, whatever the road's width
    assert crossing.cost_proxy == longer_crossing.cost_proxy
    assert crossing.cost_proxy > corridor.cost_proxy
    # and it describes a location without asserting the treatment: nothing in the
    # geometry distinguishes crossing a road from briefly riding along one
    text = priorities.summary_sentence(crossing)
    assert "a spot fix on Main St" in text
    assert "46 ft of it" in text
    assert "crossing" not in text


def test_normalise_works_on_a_short_list() -> None:
    """Truncating the percentile index picked the minimum for short lists, which
    made the divisor zero and scored every project in a small town as 0.0."""
    assert priorities.normalise([0.0, 25.0]) == [0.0, 1.0]
    assert priorities.normalise([7.0]) == [1.0]
    three = priorities.normalise([1.0, 2.0, 4.0])
    assert three[-1] == 1.0
    assert 0.0 < three[0] < three[1] < three[2]


def test_normalise_never_ties_distinct_values() -> None:
    """The property that matters: distinct evidence must give distinct scores.

    Dividing by a percentile and clamping tied the top 284 real projects at 1.0,
    so the list stopped ranking exactly where a city reads it.
    """
    values = [float(i) for i in range(1, 40)] + [10_000.0]
    out = priorities.normalise(values)
    assert len(set(out)) == len(out), "distinct inputs produced tied scores"
    assert out == sorted(out), "must be monotone in the input"
    assert out[-1] == 1.0
    # and the outlier must not collapse the ordinary field toward zero
    assert out[38] > 0.3


def test_normalise_handles_empty_and_all_zero() -> None:
    assert priorities.normalise([]) == []
    assert priorities.normalise([0.0, 0.0]) == [0.0, 0.0]


def test_summary_only_claims_what_the_numbers_say() -> None:
    """The sentence shown to a city must not invent a benefit."""
    cand = priorities.Candidate(
        pid="c1", name="Beacon St", kind="corridor", cls="busy_street",
        length_m=180.0, crashes=0,
    )
    plain = priorities.summary_sentence(cand)
    assert "591 ft of Beacon St" in plain
    # what it is today, so two candidates on one street aren't indistinguishable
    assert "no bike facility on a busy road" in plain
    assert "joins" not in plain  # no island gain computed, so no claim
    assert "crash" not in plain

    cand.join_m = 18_000.0
    cand.join_names = ["14.9 mi", "11.2 mi"]
    cand.gain_km = "11.2 mi"
    cand.crashes = 1
    cand.towns = ["Somerville"]
    rich = priorities.summary_sentence(cand)
    assert "Somerville" in rich
    assert "connects 11.2 mi of kid-safe streets to a 14.9 mi network" in rich
    assert "1 bike crash since 2021" in rich  # singular

    # When the big side is the whole region's network, its mileage is not worth
    # printing: "connects 1422.0 km and 96.5 km" states the kid-safe total of 76
    # towns, which says nothing and, on a city page reporting 262 km, reads like
    # a typo. Name the side that gains instead.
    cand.joins_region = True
    cand.gain_km = "11.2 mi"
    regional = priorities.summary_sentence(cand)
    assert "connects 11.2 mi of kid-safe streets to the region-wide network" in regional
    assert "14.9 mi" not in regional


def test_cost_proxy_scales_with_length_for_corridors() -> None:
    corridor = priorities.Candidate(
        pid="c1", name="A", kind="corridor", cls="busy_street", length_m=100.0
    )
    longer = priorities.Candidate(
        pid="c2", name="B", kind="corridor", cls="busy_street", length_m=400.0
    )
    spot = priorities.Candidate(
        pid="c3", name="C", kind="spot_fix", cls="busy_street", length_m=0.0
    )
    assert longer.cost_proxy == pytest.approx(4 * corridor.cost_proxy)
    # a spot fix costs a location, not zero, however short it is
    assert spot.cost_proxy > corridor.cost_proxy


def test_towns_are_assigned_from_a_polygon() -> None:
    b = GraphBuilder()
    b.node(0, 0)
    b.node(1, 200)
    b.edge(0, 1, 200, "busy_street", "Border Rd")
    cands = priorities.find_candidates(b.g)
    # a box around the test origin
    ring = [(-71.11, 42.37), (-71.09, 42.37), (-71.09, 42.39), (-71.11, 42.39)]
    priorities.assign_towns(cands, [("Testville", [ring])])
    assert cands[0].towns == ["Testville"]
    # no town data must not crash or invent a town
    priorities.assign_towns(cands, [])
    assert cands[0].towns == ["Testville"]  # left as-is rather than cleared


def test_isolated_junctions_are_not_islands() -> None:
    """A node with no kid-safe edge is a junction, not an island. Counting them
    reported 44,643 islands where there were 34,734, padded by 9,909 bare nodes."""
    b = GraphBuilder()
    for i in range(4):
        b.node(i, i * 100)
    b.edge(0, 1, 100, "quiet_street", "Safe St")
    b.edge(2, 3, 100, "busy_street", "Loud Rd")  # its nodes touch nothing safe
    island_of, island_m = priorities.safe_islands(b.g)
    assert len(island_m) == 1
    assert all(m > 0 for m in island_m.values())
    # the unsafe street's nodes belong to no island
    assert 2 not in island_of
    assert 3 not in island_of


def test_parallel_ways_both_count_toward_length() -> None:
    """Two ways between the same junctions are two streets. A simple-Graph pass
    collapsed them and undercounted the corridor."""
    b = GraphBuilder()
    b.node(0, 0)
    b.node(1, 300)
    b.edge(0, 1, 300, "busy_street", "Twin Rd")           # key 0
    b.edge(0, 1, 300, "busy_street", "Twin Rd")           # key 1: the other carriageway
    cands = [c for c in priorities.find_candidates(b.g) if c.name == "Twin Rd"]
    assert len(cands) == 1
    assert cands[0].length_m == pytest.approx(600.0)
    assert len(cands[0].edges) == 2


def test_unmeasured_metrics_are_blank_not_zero() -> None:
    """Before the accessibility pass runs, "residents gaining access" must be
    empty rather than 0 — a zero there reads as "this helps nobody"."""
    cand = priorities.Candidate(
        pid="c1", name="A St", kind="corridor", cls="busy_street", length_m=100.0
    )
    assert not cand.access_computed
    props = priorities.to_geojson([cand])["features"][0]["properties"]
    assert props["pop_gaining"] is None
    assert props["resident_m_saved"] is None
    assert props["dest_unlocked"] is None


def test_candidates_with_no_island_pair_are_not_each_others_alternatives() -> None:
    """Grouping on an absent island pair made unrelated same-named streets in
    different towns report as options for one another."""
    a = priorities.Candidate(
        pid="c1", name="Main St", kind="corridor", cls="busy_street", length_m=100.0
    )
    b_ = priorities.Candidate(
        pid="c2", name="Main St", kind="corridor", cls="busy_street", length_m=100.0
    )
    priorities.group_alternatives([a, b_])
    assert a.group != b_.group
    assert a.group_size == 1 and b_.group_size == 1

    # but two ways across the same gap on the same street are alternatives
    a.islands = [7, 9]
    b_.islands = [9, 7]
    priorities.group_alternatives([a, b_])
    assert a.group == b_.group
    assert a.group_size == 2


# ── accessibility (phase 2) ────────────────────────────────────────────────


@pytest.fixture
def stranded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> nx.MultiDiGraph:
    """A neighbourhood cut off from the only school by 100 m of arterial.

    0-1-2 quiet (homes) | 2-3 arterial (the gap) | 3-4 quiet, school at 4.
    A second arterial 5-6 sits off to the side, connecting nothing.
    """
    b = GraphBuilder()
    for i in range(7):
        b.node(i, i * 200)
    b.edge(0, 1, 200, "quiet_street", "Home St")
    b.edge(1, 2, 200, "quiet_street", "Home St")
    b.edge(2, 3, 100, "busy_street", "The Gap")
    b.edge(3, 4, 200, "quiet_street", "School St")
    b.edge(5, 6, 300, "busy_street", "Useless Rd")

    raw = tmp_path / "raw"
    raw.mkdir()
    lon, lat = _lonlat(800)
    (raw / "pois.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {"kind": "school", "name": "Test Elementary"},
                    },
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {"kind": "ice_cream", "name": "Not a destination"},
                    },
                ],
            }
        )
    )
    monkeypatch.setattr(config, "RAW_DIR", raw)
    return b.g


class Measured(NamedTuple):
    cands: dict[str, priorities.Candidate]
    pop: np.ndarray
    pop_is_real: bool
    dests: list[int]
    before: np.ndarray


def _measure(graph: nx.MultiDiGraph) -> Measured:
    island_of, island_m = priorities.safe_islands(graph)
    cands = priorities.find_candidates(graph)
    priorities.score_severance(cands, island_of, island_m)
    net = priorities.Network(graph)
    pop, pop_is_real = priorities.node_population(graph, net)
    dests = priorities.destination_nodes(graph, net)
    before = priorities.score_accessibility(graph, cands, net, pop, dests, island_of)
    return Measured({c.name: c for c in cands}, pop, pop_is_real, dests, before)


def test_only_destination_kinds_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ice-cream shop is a kid stop, not somewhere a safe route is owed to."""
    raw = tmp_path / "raw3"
    raw.mkdir()
    lon, lat = _lonlat(100)
    (raw / "pois.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {"kind": "school"},
                    },
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {"kind": "ice_cream"},
                    },
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {"kind": "restroom"},
                    },
                ],
            }
        )
    )
    monkeypatch.setattr(config, "RAW_DIR", raw)
    b = GraphBuilder()
    b.node(0, 0)
    b.node(1, 100)
    b.edge(0, 1, 100, "quiet_street", "A St")
    net = priorities.Network(b.g)
    # three POIs at the same spot, one of them a destination
    assert len(priorities.destination_nodes(b.g, net)) == 1

    # and with no POI file at all it degrades rather than raising
    empty = tmp_path / "raw3-empty"
    empty.mkdir()
    monkeypatch.setattr(config, "RAW_DIR", empty)
    assert priorities.destination_nodes(b.g, net) == []


def test_closing_the_gap_saves_resident_distance(stranded: nx.MultiDiGraph) -> None:
    out = _measure(stranded)
    gap = out.cands["The Gap"]
    useless = out.cands["Useless Rd"]
    assert gap.access_computed
    # the homes get closer to the school; the street to nowhere changes nothing
    assert gap.resident_m_saved > 0
    assert useless.resident_m_saved == 0
    assert gap.resident_m_saved > useless.resident_m_saved


def test_a_stranded_neighbourhood_gains_access(stranded: nx.MultiDiGraph) -> None:
    """pop_gaining counts people crossing from "nothing in reach" to "in reach"."""
    out = _measure(stranded)
    # with the arterial in the way the homes are over budget from the school
    assert out.cands["The Gap"].pop_gaining > 0
    assert out.cands["Useless Rd"].pop_gaining == 0


def test_unreachable_gains_are_clamped_not_infinite(stranded: nx.MultiDiGraph) -> None:
    """A node going from unreachable to reachable must not post an infinite
    saving — one such node would otherwise outrank every real project."""
    out = _measure(stranded)
    saved = out.cands["The Gap"].resident_m_saved
    assert math.isfinite(saved)
    ceiling = (
        config.ACCESS_BUDGET_M
        * config.ACCESS_CLAMP_MULT
        * float(out.pop.sum())
    )
    assert saved <= ceiling


def test_population_falls_back_to_street_length_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the census layer the analysis still runs, but nothing may claim
    to have counted residents."""
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setattr(config, "RAW_DIR", empty)
    b = GraphBuilder()
    b.node(0, 0)
    b.node(1, 200)
    b.edge(0, 1, 200, "quiet_street", "Home St")
    net = priorities.Network(b.g)
    pop, pop_is_real = priorities.node_population(b.g, net)
    assert not pop_is_real
    assert pop.sum() == pytest.approx(200.0)  # the street's own length


def test_population_spreads_over_nodes_not_a_centroid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A centroid can land across the very arterial being measured, which would
    credit the wrong side. Residents go on the streets inside the block group."""
    raw = tmp_path / "raw2"
    raw.mkdir()
    ring = [
        [-71.11, 42.37], [-71.09, 42.37], [-71.09, 42.39], [-71.11, 42.39],
        [-71.11, 42.37],
    ]
    (raw / "population.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "MultiPolygon", "coordinates": [[ring]]},
                        "properties": {"geoid": "test", "pop": 900},
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(config, "RAW_DIR", raw)
    b = GraphBuilder()
    for i in range(3):
        b.node(i, i * 100)
    b.edge(0, 1, 100, "quiet_street", "A St")
    b.edge(1, 2, 100, "quiet_street", "A St")
    net = priorities.Network(b.g)
    pop, pop_is_real = priorities.node_population(b.g, net)
    assert pop_is_real
    assert pop.sum() == pytest.approx(900.0)
    # spread across all three nodes rather than piled on one
    assert (pop > 0).sum() == 3


def test_coverage_export_labels_a_proxy_as_a_proxy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = tmp_path / "empty2"
    empty.mkdir()
    monkeypatch.setattr(config, "RAW_DIR", empty)
    b = GraphBuilder()
    b.node(0, 0)
    b.node(1, 200)
    b.edge(0, 1, 200, "quiet_street", "Home St")
    net = priorities.Network(b.g)
    pop, pop_is_real = priorities.node_population(b.g, net)
    before = np.zeros(net.node_count())  # everything in reach
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    priorities.export_coverage(b.g, net, pop, before, pop_is_real, out_dir)
    cells = json.loads((out_dir / "access.geojson").read_text())["features"]
    assert cells
    props = cells[0]["properties"]
    assert props["weight_kind"] == "residential_street_m"
    assert props["residents"] is None  # must not report a headcount it didn't count
    assert props["pct_served"] == 100
    assert props["band"] == "good"


def test_cost_is_measured_toward_the_destination_not_away(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pins the direction of the accessibility search.

    Every other fixture here is symmetric, so a transposed cost matrix would
    give identical answers and no test would notice. A one-way street is the
    only thing that can tell "how far to the school" from "how far from it":
    here you can ride 0 -> 1 cheaply but not back, so node 0 is close to the
    school and node 1 is not.
    """
    b = GraphBuilder()
    b.node(0, 0)
    b.node(1, 300)
    # 0 -> 1 quiet and short; 1 -> 0 only via a long arterial detour
    b.g.add_edge(0, 1, length=300, cls="quiet_street", stress_mult=1.4, name="One Way",
                 crash_count=0, weight=300 * 1.4)
    b.node(2, -4000)
    b.g.add_edge(1, 2, length=4000, cls="busy_street", stress_mult=25.0, name="Long Way",
                 crash_count=0, weight=4000 * 25.0)
    b.g.add_edge(2, 0, length=4000, cls="busy_street", stress_mult=25.0, name="Long Way",
                 crash_count=0, weight=4000 * 25.0)

    raw = tmp_path / "oneway"
    raw.mkdir()
    lon, lat = _lonlat(300)  # a school at node 1
    (raw / "pois.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {"kind": "school"},
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(config, "RAW_DIR", raw)

    net = priorities.Network(b.g)
    dests = priorities.destination_nodes(b.g, net)
    assert len(dests) == 1
    cost = net.cost_to_nearest(dests)
    at_0 = cost[net.index[0]]
    at_2 = cost[net.index[2]]
    # from 0 you ride the short quiet street to the school
    assert at_0 == pytest.approx(300 * 1.4)
    # from 2 you must take the arterial; if the matrix were transposed this
    # would come out as the cheap direction instead
    assert at_2 == pytest.approx(4000 * 25.0 + 300 * 1.4)
    assert at_2 > at_0


def test_coverage_cells_contain_their_own_points() -> None:
    """Cell binning truncated toward zero, so west of the meridian a point was
    binned into the cell next door and every overlay drew ~100 m off its data."""
    b = GraphBuilder()
    b.node(0, 0)
    b.node(1, 100)
    b.edge(0, 1, 100, "quiet_street", "A St")
    net = priorities.Network(b.g)
    pop = np.ones(net.node_count())
    before = np.zeros(net.node_count())
    out_dir = Path(tempfile.mkdtemp())
    priorities.export_coverage(b.g, net, pop, before, True, out_dir)
    cells = json.loads((out_dir / "access.geojson").read_text())["features"]
    assert cells
    for node in b.g.nodes:
        x, y = float(b.g.nodes[node]["x"]), float(b.g.nodes[node]["y"])
        assert any(
            ring[0][0] <= x <= ring[2][0] and ring[0][1] <= y <= ring[2][1]
            for cell in cells
            for ring in [cell["geometry"]["coordinates"][0]]
        ), f"node at {x},{y} fell outside every cell"


def test_priority_weights_sum_to_one() -> None:
    """Otherwise scores aren't comparable between runs, and a reweighting in
    config silently rescales every project."""
    assert sum(config.PRIORITY_WEIGHTS.values()) == pytest.approx(1.0)
    assert set(config.PRIORITY_WEIGHTS) == {"severance", "access", "crash", "coverage"}


def test_summary_reports_reach_only_once_measured() -> None:
    """The accessibility finding is the point of the second pass, so it has to
    reach the sentence — but never as a headcount when the weight is a proxy."""
    cand = priorities.Candidate(
        pid="c1", name="Gap St", kind="corridor", cls="busy_street", length_m=120.0
    )
    cand.dest_unlocked = 3
    cand.pop_gaining = 1900.0
    # not measured yet: say nothing about reach
    assert "opens a network" not in priorities.summary_sentence(cand)

    cand.access_computed = True
    cand.pop_is_headcount = True
    rich = priorities.summary_sentence(cand)
    # phrased as what it is: the joined network holds those destinations, most
    # already reachable from its own side
    assert "opens a network with 3 schools, playgrounds and libraries on it" in rich
    assert "reaches 3 schools" not in rich
    assert "about 1,900 residents gain a safe route" in rich

    # proxy weighting: the destinations still count, the people do not
    cand.pop_is_headcount = False
    proxy = priorities.summary_sentence(cand)
    assert "opens a network with 3 schools, playgrounds and libraries on it" in proxy
    assert "1,900" not in proxy
    assert "residents" not in proxy

    # and a single destination reads as one
    cand.dest_unlocked = 1
    cand.pop_is_headcount = True
    assert (
        "opens a network with 1 school, playground or library on it"
        in priorities.summary_sentence(cand)
    )


def test_scoring_restores_the_network_between_candidates(
    stranded: nx.MultiDiGraph,
) -> None:
    """Each candidate is measured on a graph re-costed in place and put back.

    A restore that missed anything would silently measure every later candidate
    against a network with earlier upgrades already built into it — the numbers
    would still look plausible and would all be wrong.
    """
    island_of, island_m = priorities.safe_islands(stranded)
    cands = priorities.find_candidates(stranded)
    priorities.score_severance(cands, island_of, island_m)
    net = priorities.Network(stranded)
    original = net.matrix.data.copy()
    pop, _real = priorities.node_population(stranded, net)
    dests = priorities.destination_nodes(stranded, net)
    priorities.score_accessibility(stranded, cands, net, pop, dests, island_of)
    assert np.array_equal(net.matrix.data, original), "arc weights leaked between candidates"


def test_measuring_twice_gives_the_same_answer(stranded: nx.MultiDiGraph) -> None:
    """Idempotence, which is the symptom a leaky restore would break first."""
    first = _measure(stranded)
    second = _measure(stranded)
    for name, cand in first.cands.items():
        assert cand.resident_m_saved == pytest.approx(second.cands[name].resident_m_saved)
        assert cand.pop_gaining == pytest.approx(second.cands[name].pop_gaining)


def test_map_slice_keeps_the_top_of_every_measure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The app re-sorts the slice it was given, so a project that tops one
    measure has to be in it — otherwise moving the sliders onto crash history
    can never surface the streets that actually top that list."""
    monkeypatch.setattr(config, "PRIORITY_MAP_N", 16)
    cands: list[priorities.Candidate] = []
    for i in range(60):
        c = priorities.Candidate(
            pid=f"c{i}", name=f"St {i}", kind="corridor", cls="busy_street", length_m=100.0
        )
        # composite favours the low indices; crash favours the high ones
        c.components = {
            "severance": 1.0 - i / 60,
            "access": 1.0 - i / 60,
            "coverage": 1.0 - i / 60,
            "crash": i / 60,
        }
        c.score = 0.85 * (1.0 - i / 60) + 0.15 * (i / 60)
        cands.append(c)
    cands.sort(key=lambda c: c.score, reverse=True)
    # a spot fix ranked last overall must still make the map
    cands[-1].kind = "spot_fix"
    last_pid = cands[-1].pid
    chosen = {c.pid for c in priorities.select_for_map(cands)}
    assert len(chosen) <= 16
    assert last_pid in chosen, "spot fixes are the cheapest projects; always map them"
    # the worst project by our weighting is the best by crash history
    assert "c59" in chosen
    # and the overall leader is still there
    assert "c0" in chosen


# ── the export surface, and the module end to end ──────────────────────────


def test_load_towns_handles_both_polygon_shapes_and_a_missing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = tmp_path / "raw-towns"
    raw.mkdir()
    monkeypatch.setattr(config, "RAW_DIR", raw)
    assert priorities.load_towns() == []  # not fetched yet: no towns, no crash

    ring = [[-71.11, 42.37], [-71.09, 42.37], [-71.09, 42.39], [-71.11, 42.37]]
    (raw / "towns.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "geometry": {"type": "Polygon", "coordinates": [ring]},
                        "properties": {"town": "Simpleton"},
                    },
                    {
                        "geometry": {"type": "MultiPolygon", "coordinates": [[ring], [ring]]},
                        "properties": {"town": "Islandia"},
                    },
                    {"geometry": {"type": "Point", "coordinates": [0, 0]}, "properties": {}},
                ],
            }
        )
    )
    towns = dict(priorities.load_towns())
    assert set(towns) == {"Simpleton", "Islandia"}
    assert len(towns["Islandia"]) == 2  # both parts kept


def test_csv_carries_every_project_and_blanks_what_wasnt_measured(tmp_path: Path) -> None:
    """A city sorts this in a spreadsheet, so the columns have to be complete
    and empty where nothing was measured rather than zero."""
    cands = [
        priorities.Candidate(
            pid="c1", name="A St", kind="corridor", cls="busy_street", length_m=100.0,
            crashes=2, join_m=1000.0,
        ),
        priorities.Candidate(
            pid="c2", name="B St", kind="spot_fix", cls="busy_street", length_m=20.0
        ),
    ]
    out = tmp_path / "p.csv"
    priorities.write_csv(out, cands)
    rows = list(csv.DictReader(out.open()))
    assert [r["pid"] for r in rows] == ["c1", "c2"]
    assert rows[0]["rank"] == "1"
    assert rows[0]["crashes"] == "2"
    assert rows[0]["pop_gaining"] == ""  # not measured, not "0"
    assert rows[1]["kind"] == "spot_fix"
    assert rows[1]["towns"] == "-"
    assert set(priorities.CSV_COLUMNS) <= set(rows[0])


def test_spot_fix_points_are_exported_for_the_map(tmp_path: Path) -> None:
    spot = priorities.Candidate(
        pid="s1", name="Pinch", kind="spot_fix", cls="busy_street", length_m=14.0
    )
    spot.parts = [[(-71.1, 42.38), (-71.0999, 42.3801)]]
    corridor = priorities.Candidate(
        pid="c1", name="Long", kind="corridor", cls="busy_street", length_m=400.0
    )
    corridor.parts = [[(-71.2, 42.4), (-71.19, 42.4)]]
    priorities.export_spot_fixes(tmp_path, [spot, corridor])
    fc = json.loads((tmp_path / "severance.geojson").read_text())
    # only spot fixes, and as points a city can see at city zoom
    assert len(fc["features"]) == 1
    assert fc["features"][0]["geometry"]["type"] == "Point"
    assert fc["features"][0]["properties"]["pid"] == "s1"


def test_meta_records_provenance_and_refuses_to_call_a_proxy_a_headcount(
    tmp_path: Path,
) -> None:
    cands = [
        priorities.Candidate(
            pid="c1", name="A", kind="corridor", cls="busy_street", length_m=100.0
        )
    ]
    priorities.write_meta(
        tmp_path, cands, shown_count=1, islands={0: 5000.0, 1: 100.0},
        destinations=7, pop=np.array([1.0, 2.0]), pop_is_real=False,
        stranded=1.0, stranded_pct=50.0,
    )
    meta = json.loads((tmp_path / "priorities_meta.json").read_text())
    assert meta["population"]["is_headcount"] is False
    assert "PROXY" in meta["population"]["source"]
    assert meta["islands"]["substantial"] == 1  # the 100 m fragment doesn't count
    assert meta["access"]["stranded_pct"] == 50
    # the caveats a city will be asked about must ship with the numbers
    assert len(meta["limits"]) >= 4
    assert any("not measurement" in limit for limit in meta["limits"])
    assert meta["model"]["kid_safe_max_multiplier"] == config.SAFE_MULT_MAX


def test_meta_publishes_the_weighting_the_score_was_computed_with(tmp_path: Path) -> None:
    """The web pages read this to set their sliders.

    Both the /build workspace and the app's own list start their weight sliders
    from meta.model.weights, so the first ranking a reader sees is the one the
    exported `score` field ranks by. Before that, each surface repeated the four
    numbers itself and they agreed only as long as nobody edited the config —
    which would have given a city two different answers to "which first?".
    """
    cands = [
        priorities.Candidate(
            pid="c1", name="A", kind="corridor", cls="busy_street", length_m=100.0
        )
    ]
    priorities.write_meta(
        tmp_path, cands, shown_count=1, islands={0: 5000.0},
        destinations=1, pop=np.array([1.0]), pop_is_real=True,
        stranded=0.0, stranded_pct=0.0,
    )
    weights = json.loads((tmp_path / "priorities_meta.json").read_text())["model"]["weights"]
    assert weights == config.PRIORITY_WEIGHTS
    # every component the pages weight has a weight, and they are shares
    assert set(weights) == {"severance", "access", "crash", "coverage"}
    assert abs(sum(weights.values()) - 1.0) < 1e-9
    # whole percents, or the sliders cannot express the published weighting and
    # the page's opening order would silently differ from the exported score
    for key, value in weights.items():
        assert abs(value * 100 - round(value * 100)) < 1e-9, f"{key} is not a whole percent"


def test_joins_region_is_exported_as_a_bool_for_every_candidate() -> None:
    """The what-if sentence on /build is only as specific as this field.

    join_m is the smaller of the two sides a build would link, which says nothing
    about whether the larger side is the region's main network or another local
    pocket. The page claimed the region for every join until this shipped; with
    the field absent it says "the network on the other side of this gap" and no
    more, so the field has to arrive as a real boolean or the page silently falls
    back to the vaguer wording.
    """
    b = GraphBuilder()
    for i, x in ((0, 0), (1, 400), (2, 420), (3, 1200), (4, 1260), (5, 5260)):
        b.node(i, x)
    b.edge(0, 1, 400, "quiet_street", "A St")
    b.edge(1, 2, 20, "busy_street", "The Gap")     # joins two local pockets
    b.edge(2, 3, 780, "quiet_street", "B St")
    b.edge(3, 4, 60, "busy_street", "The Bridge")  # joins one to the region's
    b.edge(4, 5, 4000, "quiet_street", "The Big One")

    island_of, island_m = priorities.safe_islands(b.g)
    cands = priorities.find_candidates(b.g)
    priorities.score_severance(cands, island_of, island_m)
    priorities.score_all(cands)
    fc = priorities.to_geojson(cands)

    assert fc["features"], "no candidates exported"
    for feature in fc["features"]:
        flag = feature["properties"]["joins_region"]
        assert isinstance(flag, bool), f"joins_region is {type(flag).__name__}, not a bool"
    # and it never disagrees with the sentence written from the same candidate
    for feature in fc["features"]:
        props = feature["properties"]
        if "region-wide network" in props["summary"]:
            assert props["joins_region"] is True
    # both values occur here, so neither is exported by accident
    flags = {f["properties"]["joins_region"] for f in fc["features"]}
    assert flags == {True, False}, f"expected both, got {flags}"


def test_build_runs_end_to_end_on_a_small_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The orchestration itself, on a graph small enough to pickle in a test.

    Everything below build() is unit-tested, but nothing checked that the parts
    fit together and that a run produces the four files the app and the export
    packet read.
    """
    data = tmp_path / "data"
    raw = data / "raw"
    raw.mkdir(parents=True)
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "RAW_DIR", raw)

    b = GraphBuilder()
    for i, x in ((0, 0), (1, 200), (2, 400), (3, 414), (4, 614), (5, 814)):
        b.node(i, x)
    b.edge(0, 1, 200, "quiet_street", "West St")
    b.edge(1, 2, 200, "quiet_street", "West St")
    b.edge(2, 3, 14, "busy_street", "The Pinch")
    b.edge(3, 4, 200, "quiet_street", "East St")
    b.edge(4, 5, 200, "quiet_street", "East St")
    with (data / "graph.pkl").open("wb") as fh:
        pickle.dump(b.g, fh)

    lon, lat = _lonlat(814)
    (raw / "pois.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                        "properties": {"kind": "school"},
                    }
                ],
            }
        )
    )

    out = priorities.build()
    assert out, "a severed network must yield at least one project"
    web = data.parent / "web" / "data"
    for name in ("priorities.geojson", "priorities.csv", "access.geojson",
                 "priorities_meta.json", "severance.geojson"):
        assert (web / name).exists(), f"{name} missing"

    # the pinch is the project, and it's a spot fix
    top = out[0]
    assert top.name == "The Pinch"
    assert top.kind == "spot_fix"
    assert top.access_computed

    # and the files agree with what build() returned
    fc = json.loads((web / "priorities.geojson").read_text())
    assert fc["features"][0]["properties"]["pid"] == top.pid
    meta = json.loads((web / "priorities_meta.json").read_text())
    assert meta["candidates"] == len(out)


def test_only_the_region_wide_network_is_named_as_such() -> None:
    """Two mid-sized pockets joining each other still get both figures — the
    phrasing is about which island is the region's, not about size."""
    b = GraphBuilder()
    for i, x in ((0, 0), (1, 400), (2, 420), (3, 1200)):
        b.node(i, x)
    b.edge(0, 1, 400, "quiet_street", "A St")   # a 400 m island
    b.edge(1, 2, 20, "busy_street", "The Gap")  # the candidate's street
    b.edge(2, 3, 780, "quiet_street", "B St")   # a 780 m island, the biggest
    island_of, island_m = priorities.safe_islands(b.g)

    gap = priorities.Candidate(
        pid="c1", name="The Gap", kind="corridor", cls="busy_street", length_m=20.0
    )
    gap.nodes = [1, 2]
    priorities.score_severance([gap], island_of, island_m)
    assert gap.joins_region, "the larger side here IS the biggest island in the graph"
    assert "to the region-wide network" in priorities.summary_sentence(gap)

    # A candidate that touches neither end of the region's network gets both
    # figures. Built as a real graph and classified by score_severance, not by
    # setting the flag by hand — the flag is the thing under test.
    b2 = GraphBuilder()
    for i, x in ((0, 0), (1, 400), (2, 420), (3, 1200), (4, 5000), (5, 9000)):
        b2.node(i, x)
    b2.edge(0, 1, 400, "quiet_street", "A St")
    b2.edge(1, 2, 20, "busy_street", "The Gap")
    b2.edge(2, 3, 780, "quiet_street", "B St")
    b2.edge(4, 5, 4000, "quiet_street", "The Big One")  # the region's network
    island_of2, island_m2 = priorities.safe_islands(b2.g)

    gap2 = priorities.Candidate(
        pid="c2", name="The Gap", kind="corridor", cls="busy_street", length_m=20.0
    )
    gap2.nodes = [1, 2]
    priorities.score_severance([gap2], island_of2, island_m2)
    assert not gap2.joins_region, "neither side here is the biggest island"
    both = priorities.summary_sentence(gap2)
    # the gaining side first, then what it joins — so which number is the point
    # doesn't have to be worked out
    assert "connects 0.2 mi of kid-safe streets to a 0.5 mi network" in both
    assert "region-wide" not in both


def test_a_half_filled_candidate_never_renders_a_gap_in_a_sentence() -> None:
    """joins_region, gain_km and join_names are independent fields. A candidate
    with the flag but not the figure used to render "connects  of kid-safe
    streets to the region-wide network" — worse than the IndexError it replaced,
    because it publishes."""
    cand = priorities.Candidate(
        pid="c1", name="Nowhere St", kind="corridor", cls="busy_street", length_m=100.0
    )
    cand.join_m = 5_000.0
    cand.joins_region = True
    # join_names populated but gain_km not: without this the old code skipped
    # the region branch too, and the test passed against the bug it names.
    cand.join_names = ["14.9 mi", "11.2 mi"]
    out = priorities.summary_sentence(cand)
    assert "connects  of" not in out
    assert "region-wide" not in out
    # it falls back to what it can support
    assert "unlocks 3.1 mi of kid-safe streets" in out
    assert "14.9 mi" not in out
