"""Tests for the where-to-build ranking.

The module's whole claim is that a short link between two large kid-safe islands
beats a long street that connects nothing. If that ordering ever inverts, the
output stops being an argument a city can act on, so it is asserted directly on
hand-built graphs rather than on real data.
"""

import math

import networkx as nx
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


def test_length_bounds_drop_stubs_and_programmes() -> None:
    b = GraphBuilder()
    b.node(0, 0)
    b.node(1, 10)
    b.edge(0, 1, 10, "busy_street", "Kerb Cut")  # under CANDIDATE_MIN_M
    b.node(2, 100)
    b.node(3, 5000)
    b.edge(2, 3, 4900, "busy_street", "Route 2")  # over CANDIDATE_MAX_M
    names = {c.name for c in priorities.find_candidates(b.g)}
    assert "Kerb Cut" not in names
    assert "Route 2" not in names


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
    assert "180 m of Beacon St" in plain
    # what it is today, so two candidates on one street aren't indistinguishable
    assert "no bike facility on a busy road" in plain
    assert "joins" not in plain  # no island gain computed, so no claim
    assert "crash" not in plain

    cand.join_m = 18_000.0
    cand.join_names = ["24.0 km", "18.0 km"]
    cand.crashes = 1
    cand.towns = ["Somerville"]
    rich = priorities.summary_sentence(cand)
    assert "Somerville" in rich
    assert "connects 24.0 km and 18.0 km of kid-safe streets" in rich
    assert "1 bike crash since 2021" in rich  # singular


def test_cost_proxy_scales_with_length_and_flags_crossings() -> None:
    corridor = priorities.Candidate(
        pid="c1", name="A", kind="corridor", cls="busy_street", length_m=100.0
    )
    longer = priorities.Candidate(
        pid="c2", name="B", kind="corridor", cls="busy_street", length_m=400.0
    )
    crossing = priorities.Candidate(
        pid="c3", name="C", kind="crossing", cls="busy_street", length_m=0.0
    )
    assert longer.cost_proxy == pytest.approx(4 * corridor.cost_proxy)
    # a crossing costs a signal, not zero, even though its length is ~0
    assert crossing.cost_proxy > corridor.cost_proxy


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


def test_unmeasured_metrics_are_blank_not_zero(tmp_path: object) -> None:
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
