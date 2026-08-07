"""Tests for the per-city pages.

The page makes claims about a specific place to the people who live there, so
the two things worth pinning are that it only ever describes that city, and
that its framing follows the city's own numbers rather than the one the module
was written around.
"""

import json
import pickle
from pathlib import Path

import city_pages
import config
import networkx as nx
import pytest
from test_priorities import GraphBuilder, _lonlat


def test_slugs_are_urls() -> None:
    assert city_pages.slugify("Somerville") == "somerville"
    assert city_pages.slugify("North Reading") == "north-reading"
    assert city_pages.slugify("Manchester-by-the-Sea") == "manchester-by-the-sea"


def test_point_in_rings_handles_multipart_towns() -> None:
    square = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]
    far = [(10.0, 10.0), (12.0, 10.0), (12.0, 12.0), (10.0, 12.0)]
    assert city_pages.point_in_rings((1.0, 1.0), [square])
    assert not city_pages.point_in_rings((5.0, 5.0), [square])
    # a town with an island offshore is two rings, and both count
    assert city_pages.point_in_rings((11.0, 11.0), [square, far])
    assert city_pages.point_in_rings((1.0, 1.0), [square, far])


def test_a_hole_in_a_town_is_not_in_the_town() -> None:
    """Rings arrive flattened, outer boundaries and interior holes together.
    Testing them one at a time answered "inside" for a point in the hole."""
    outer = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    hole = [(4.0, 4.0), (6.0, 4.0), (6.0, 6.0), (4.0, 6.0)]
    assert city_pages.point_in_rings((1.0, 1.0), [outer, hole])
    assert not city_pages.point_in_rings((5.0, 5.0), [outer, hole])


def test_a_street_belongs_to_the_town_its_middle_is_in() -> None:
    """coords[len // 2] is the middle vertex, not the middle. OSM puts vertices
    on bends, so a straight run with curves bunched at one end has its middle
    vertex down at that end — and this decides which town a street counts for."""
    # nine vertices crowded into the first tenth, then one long straight leg
    coords = [(x / 100, 0.0) for x in range(9)] + [(10.0, 0.0)]
    assert coords[len(coords) // 2] == (0.05, 0.0)  # the old answer: 5 cm along a 10 m street
    mx, my = city_pages.midpoint(coords)
    assert mx == pytest.approx(5.0, abs=0.01) and my == pytest.approx(0.0)

    # An L: one leg east, one north, equal in DEGREES but not on the ground — at
    # 42.4°N a degree of longitude is ~0.74 of a degree of latitude, so the east
    # leg is the shorter one and the true midpoint sits in the north leg. A
    # midpoint measured in raw degrees lands exactly on the corner, so this is
    # the case that tells the two apart; the straight line above cannot.
    lat = 42.4
    el = [(-71.0, lat), (-70.0, lat), (-70.0, lat + 1.0)]
    mx2, my2 = city_pages.midpoint(el)
    assert (mx2, my2) != pytest.approx((-70.0, lat)), "landed on the corner: degrees, not ground"
    assert mx2 == pytest.approx(-70.0), "the midpoint should be up the north leg"
    assert my2 > lat, "the north leg is the longer one on the ground"
    # degenerate inputs don't explode
    assert city_pages.midpoint([(3.0, 4.0)]) == (3.0, 4.0)
    assert city_pages.midpoint([(0.0, 0.0), (0.0, 0.0)]) == (0.0, 0.0)


def test_a_name_with_no_slug_never_overwrites_the_app(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """slugify strips everything non-alphanumeric, and WEB / "" is WEB — so an
    unsluggable name would write its page over the route planner's index.html."""
    monkeypatch.setattr(city_pages, "WEB", tmp_path)
    app = tmp_path / "index.html"
    app.write_text("the route planner")
    assert city_pages.slugify("—") == ""
    with pytest.raises(SystemExit, match="no usable slug"):
        city_pages.write_page("", "—")
    assert app.read_text() == "the route planner"


def test_a_town_name_cannot_inject_markup_into_its_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(city_pages, "WEB", tmp_path)
    page = city_pages.write_page("x", 'Foo" onload="evil()')
    written = page.read_text()
    assert 'onload="evil()' not in written
    assert "&quot;" in written


def test_bbox_covers_every_ring() -> None:
    west, south, east, north = city_pages.bbox_of(
        [[(0.0, 0.0), (1.0, 1.0)], [(-2.0, -1.0), (0.5, 0.5)]]
    )
    assert (west, south, east, north) == (-2.0, -1.0, 1.0, 1.0)


@pytest.fixture
def town_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A two-pocket city: a connected grid, a cut-off pocket, and an arterial."""
    web = tmp_path / "web"
    data = tmp_path / "data"
    raw = data / "raw"
    (web / "data").mkdir(parents=True)
    raw.mkdir(parents=True)
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "RAW_DIR", raw)
    monkeypatch.setattr(city_pages, "WEB", web)
    monkeypatch.setattr(city_pages, "OUT", web / "data" / "cities")

    b = GraphBuilder()
    # node 5 sits west of the town line, joined to Main St by a long edge whose
    # midpoint is also outside. Its island is therefore 2.4 km region-wide but
    # only 0.4 km in Testville — without that difference, local and global
    # island sizes are identical here and the size test below cannot fail.
    for i, x in ((0, 0), (1, 200), (2, 400), (3, 414), (4, 614), (5, -2000)):
        b.node(i, x)
    b.edge(0, 1, 200, "quiet_street", "Main St")
    b.edge(1, 2, 200, "quiet_street", "Main St")
    b.edge(2, 3, 14, "busy_street", "The Pinch")
    b.edge(3, 4, 200, "quiet_street", "Far St")
    b.edge(5, 0, 2000, "quiet_street", "Long Road Out")
    with (data / "graph.pkl").open("wb") as fh:
        pickle.dump(b.g, fh)

    # a boundary around the whole toy town
    ring = [[-71.11, 42.37], [-71.08, 42.37], [-71.08, 42.39], [-71.11, 42.39], [-71.11, 42.37]]
    (raw / "towns.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "geometry": {"type": "Polygon", "coordinates": [ring]},
                        "properties": {"town": "Testville"},
                    },
                    {
                        "geometry": {"type": "Polygon", "coordinates": [ring]},
                        "properties": {"town": "Elsewhere"},
                    },
                ],
            }
        )
    )
    lon, lat = _lonlat(300)
    (web / "data" / "priorities.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "MultiLineString", "coordinates": [[[lon, lat]]]},
                        "properties": {
                            "pid": "c1", "name": "The Pinch",
                            "towns": "Testville", "length_m": 14,
                            "summary": "a spot fix on The Pinch",
                            "kind": "spot_fix",
                        },
                    },
                    {
                        "type": "Feature",
                        "geometry": {"type": "MultiLineString", "coordinates": [[[lon, lat]]]},
                        "properties": {
                            "pid": "c2", "name": "Somewhere Else",
                            "towns": "Elsewhere", "length_m": 300,
                            "summary": "300 m of Somewhere Else",
                            "kind": "corridor",
                        },
                    },
                ],
            }
        )
    )
    (web / "data" / "access.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [
                                [[-71.10, 42.379], [-71.09, 42.379], [-71.09, 42.381],
                                 [-71.10, 42.381], [-71.10, 42.379]]
                            ],
                        },
                        "properties": {"pct_served": 50, "residents": 1000, "band": "partial"},
                    },
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [
                                [[-70.0, 41.0], [-69.99, 41.0], [-69.99, 41.01],
                                 [-70.0, 41.01], [-70.0, 41.0]]
                            ],
                        },
                        "properties": {"pct_served": 100, "residents": 5000, "band": "good"},
                    },
                ],
            }
        )
    )
    (web / "data" / "priorities_meta.json").write_text(
        json.dumps(
            {
                "built": "2026-08-06",
                "population": {"is_headcount": True},
                "limits": ["a limit", "another limit", "a third"],
            }
        )
    )
    return web


def test_a_city_page_describes_only_that_city(town_fixture: Path) -> None:
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)

    # projects, residents and cells all come from inside the boundary
    pids = {f["properties"]["pid"] for f in city["projects"]["features"]}
    assert pids == {"c1"}, "a neighbouring town's project leaked in"
    assert city["stats"]["residents"] == 1000  # the far-away cell is not ours
    assert len(city["access"]["features"]) == 1
    assert city["name"] == "Testville"
    assert city["slug"] == "testville"


def test_the_connected_piece_and_the_pockets_are_told_apart(town_fixture: Path) -> None:
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)

    ranks = {f["properties"]["isle"] for f in city["islands"]["features"]}
    # rank 0 is the piece that reaches the wider network; the far grid is a pocket
    assert 0 in ranks
    assert len(ranks) > 1, "a two-piece network drawn as one colour says nothing"
    assert city["stats"]["pockets"] >= 1
    assert city["stats"]["pocket_km"] > 0
    assert city["stats"]["connected_km"] > 0
    # the hostile street is drawn as a barrier, not as safe
    names = {f["properties"]["name"] for f in city["barriers"]["features"]}
    assert "The Pinch" in names


def test_island_sizes_are_reported_for_this_city_not_the_region(
    town_fixture: Path,
) -> None:
    """Ranking and sizing islands globally put every pocket in one bucket and
    reported a 1,422 km regional figure on a city page."""
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)
    by_km = {f["properties"]["isle_km"] for f in city["islands"]["features"]}
    # Main St's island runs 2.4 km region-wide but 0.4 km inside Testville, and
    # this page is read by someone who lives here. Pinning the value, not just
    # "< 1.0": the regional figure is 2.4, so an assertion loose enough to pass
    # either way is the bug this test exists to catch.
    assert 2.4 not in by_km, "reported the region's island size on a city page"
    assert by_km == {0.4, 0.2}


def test_a_missing_town_fails_loudly(town_fixture: Path) -> None:
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    with pytest.raises(SystemExit, match="Nowhereville"):
        city_pages.build_city("Nowhereville", graph)


def test_build_writes_a_page_and_an_index(town_fixture: Path) -> None:
    city_pages.build(["Testville"])
    page = town_fixture / "testville" / "index.html"
    assert page.exists()
    html = page.read_text()
    # the slug the script reads, and the relative paths a /testville/ URL needs
    assert 'window.__CITY__ = "testville"' in html
    assert "../city.js" in html
    assert "../city.css" in html
    assert "<title>Testville" in html

    data = json.loads((town_fixture / "data" / "cities" / "testville.json").read_text())
    assert data["stats"]["projects"] == 1
    index = json.loads((town_fixture / "data" / "cities" / "index.json").read_text())
    assert [c["slug"] for c in index] == ["testville"]
    # the index carries the stats, so a future landing page needn't load each city
    assert "pockets" in index[0]


def test_the_page_carries_its_own_caveats(town_fixture: Path) -> None:
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)
    # the app's limits travel with the city's numbers, plus the one this page
    # introduces by cutting the region up along a town line
    assert len(city["limits"]) == 4
    assert city["limits"][:3] == ["a limit", "another limit", "a third"]
    assert any("grid cell" in limit for limit in city["limits"]), (
        "the page names a city beside a resident count it assembled itself"
    )
    assert city["population_is_headcount"] is True
    assert city["built"] == "2026-08-06"


def test_a_neighbouring_towns_projects_stay_off_this_page(town_fixture: Path) -> None:
    """"Testville" is a substring of "North Testville", as Reading is of North
    Reading and Andover of North Andover. A substring filter puts the
    neighbour's projects on this city's page, which is the one thing the page
    promises not to do."""
    lon, lat = _lonlat(300)
    feats = json.loads((town_fixture / "data" / "priorities.geojson").read_text())
    feats["features"].append(
        {
            "type": "Feature",
            "geometry": {"type": "MultiLineString", "coordinates": [[[lon, lat]]]},
            "properties": {
                "pid": "c3", "name": "Next Town Over",
                "towns": "North Testville", "length_m": 100,
                "summary": "100 m in the next town", "kind": "corridor",
            },
        }
    )
    (town_fixture / "data" / "priorities.geojson").write_text(json.dumps(feats))

    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)
    pids = {f["properties"]["pid"] for f in city["projects"]["features"]}
    assert pids == {"c1"}, "a town whose name contains ours leaked its projects in"

    # and a town genuinely listed among several still matches
    feats["features"][0]["properties"]["towns"] = "Elsewhere, Testville"
    (town_fixture / "data" / "priorities.geojson").write_text(json.dumps(feats))
    city = city_pages.build_city("Testville", graph)
    assert "c1" in {f["properties"]["pid"] for f in city["projects"]["features"]}


def test_the_two_pocket_numbers_describe_the_same_pockets(town_fixture: Path) -> None:
    """"33 km stranded in 38 pockets" was summing every pocket while counting
    only those over 200 m — two different sets in one sentence.

    The fixture must contain a pocket the threshold actually drops, or this
    passes against the very code it names. It didn't, at first."""
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    # a 150 m stub: under MIN_POCKET_M, but big enough that its presence in
    # safe_km is visible after rounding (600 m without it, 750 m with)
    b = GraphBuilder()
    b.node(90, 700)
    b.node(91, 850)
    b.edge(90, 91, 150, "quiet_street", "Stub Way")
    graph.add_nodes_from(b.g.nodes(data=True))
    graph.add_edges_from(b.g.edges(keys=True, data=True))

    city = city_pages.build_city("Testville", graph)
    s = city["stats"]
    # the stub is safe street inside the town, so it counts toward safe_km...
    assert s["safe_km"] == 0.8, "the stub should still be safe street in this town"
    # ...but it is not one of the pockets the page reports
    assert s["pockets"] == 1
    assert s["pocket_km"] == 0.2, "a sub-threshold stub leaked into the total"
    assert s["pocket_km"] <= s["pockets"] * s["biggest_pocket_km"] + 1e-9

    # and the map must not colour it as a pocket the sentence didn't count
    ranks = [f["properties"]["isle"] for f in city["islands"]["features"]]
    counted = {r for r in ranks if 0 < r <= city_pages.NAMED_POCKETS}
    assert len(counted) == s["pockets"], "more pockets drawn than the page claims"


def test_the_page_says_how_many_projects_the_city_has_not_how_many_it_drew(
    town_fixture: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reporting only the truncated count told a city it had 40 candidates when
    it had more."""
    monkeypatch.setattr(city_pages, "MAX_PROJECTS", 1)
    feats = json.loads((town_fixture / "data" / "priorities.geojson").read_text())
    lon, lat = _lonlat(300)
    for i in range(3):
        feats["features"].append(
            {
                "type": "Feature",
                "geometry": {"type": "MultiLineString", "coordinates": [[[lon, lat]]]},
                "properties": {
                    "pid": f"x{i}", "name": f"Street {i}", "towns": "Testville",
                    "length_m": 50, "summary": "a fix", "kind": "spot_fix",
                },
            }
        )
    (town_fixture / "data" / "priorities.geojson").write_text(json.dumps(feats))

    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)
    assert city["stats"]["projects"] == 4  # what Testville actually has
    assert city["stats"]["projects_shown"] == 1  # what the map carries
    assert len(city["projects"]["features"]) == 1


def test_the_stranded_headcount_is_measured_not_recovered_from_a_percentage(
    town_fixture: Path,
) -> None:
    """The page used to rebuild the count as residents * round(pct) / 100, which
    turned a whole-number 9% into "About 7,225 people" — four significant digits
    nothing had computed. The pipeline now states the count it measured."""
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)
    s = city["stats"]
    # the fixture cell: 1000 residents, 50% served -> 500 stranded, 50%
    assert s["residents"] == 1000
    assert s["stranded"] == 500
    assert s["stranded_pct"] == 50
    # and the budget those numbers assume travels with them
    assert s["budget_km"] == round(config.ACCESS_BUDGET_M / 1000, 1)


def test_no_pocket_gets_a_colour_the_page_does_not_have(town_fixture: Path) -> None:
    """Ranks index a palette in city.ts. NAMED_POCKETS individually-coloured
    pockets plus rank 0 (connected) plus the shared tail is NAMED_POCKETS + 2
    entries; a rank past the end falls through to the same grey as the tail and
    silently merges a pocket into it.

    Needs more pockets than there are colours, or the bound is unreachable and
    the assertion is decoration — which is what it was."""
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    b = GraphBuilder()
    for i in range(city_pages.NAMED_POCKETS + 4):  # comfortably past the palette
        left, right = 100 + i * 2, 101 + i * 2
        b.node(left, 700.0 + i * 40)
        b.node(right, 700.0 + i * 40 + 250)
        b.edge(left, right, 250, "quiet_street", f"Pocket {i} Road")
    graph.add_nodes_from(b.g.nodes(data=True))
    graph.add_edges_from(b.g.edges(keys=True, data=True))

    city = city_pages.build_city("Testville", graph)
    ranks = {f["properties"]["isle"] for f in city["islands"]["features"]}
    assert city["stats"]["pockets"] > city_pages.NAMED_POCKETS, (
        "the fixture must produce more pockets than there are colours"
    )
    assert min(ranks) >= 0
    assert max(ranks) <= city_pages.NAMED_POCKETS + 1
    assert city_pages.NAMED_POCKETS + 1 in ranks, "the shared tail colour is unused"


def test_building_one_city_does_not_unpublish_the_others(
    town_fixture: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """index.json is what the Pages assembly walks to decide which city
    directories to copy, so a partial build silently drops the rest of the site.
    It stays a partial build — being told is the point."""
    monkeypatch.setattr(city_pages, "CITIES", ["Testville", "Elsewhere"])
    city_pages.build(["Testville"])
    index = json.loads((town_fixture / "data" / "cities" / "index.json").read_text())
    assert [c["slug"] for c in index] == ["testville"]
    assert "will drop off the site" in capsys.readouterr().out


def test_the_published_set_is_what_a_bare_build_builds() -> None:
    # the default has to be every city we publish, or running the generator
    # without arguments is itself the partial build above
    assert "Somerville" in city_pages.CITIES
    assert "Cambridge" in city_pages.CITIES


def test_a_cell_with_no_coverage_figure_is_not_counted_as_unserved(
    town_fixture: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The headline claim's worst failure mode, and it shipped twice: first as a
    KeyError, then as pct_served defaulting to 0 — which counts everyone in the
    cell as unable to reach a school and inflates the number the page leads with.
    An unmeasured cell is unmeasured, not unserved."""
    access = json.loads((town_fixture / "data" / "access.geojson").read_text())
    # a second cell inside the town, with people but no coverage figure
    ring = [[-71.10, 42.3795], [-71.09, 42.3795], [-71.09, 42.3798],
            [-71.10, 42.3798], [-71.10, 42.3795]]
    access["features"].append(
        {
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [ring]},
            "properties": {"residents": 500, "band": "unknown"},  # no pct_served
        }
    )
    (town_fixture / "data" / "access.geojson").write_text(json.dumps(access))

    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)
    s = city["stats"]

    # the measured cell alone: 1000 residents, 50% served
    assert s["residents"] == 1000, "an unmeasured cell inflated the denominator"
    assert s["stranded"] == 500, "an unmeasured cell was counted as unserved"
    assert s["stranded_pct"] == 50
    # and the exclusion is visible rather than silent — in the data and on stdout
    assert s["unmeasured_residents"] == 500
    assert "500 residents in cells with no coverage figure" in capsys.readouterr().out
    # the cell is not drawn either: shading it would put a claim on the map that
    # the sentence does not make
    assert len(city["access"]["features"]) == 1


def test_a_fully_measured_town_says_so(town_fixture: Path) -> None:
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    city = city_pages.build_city("Testville", graph)
    assert city["stats"]["unmeasured_residents"] == 0


def test_a_stub_too_small_to_count_is_not_drawn_as_connected(town_fixture: Path) -> None:
    """Sub-MIN_POCKET_M islands have no entry in rank_of at all now, so the
    lookup's default is live for the first time. If it were 0 a stranded stub
    would be painted with the "reaches the region" colour — the strongest claim
    the map makes, on the piece that least deserves it."""
    with (config.DATA_DIR / "graph.pkl").open("rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    b = GraphBuilder()
    b.node(90, 700)
    b.node(91, 750)
    b.edge(90, 91, 50, "quiet_street", "Stub Way")  # 50 m: far under the threshold
    graph.add_nodes_from(b.g.nodes(data=True))
    graph.add_edges_from(b.g.edges(keys=True, data=True))

    city = city_pages.build_city("Testville", graph)
    stub = [f for f in city["islands"]["features"] if f["properties"]["name"] == "Stub Way"]
    assert stub, "the stub should still be drawn as safe street"
    assert stub[0]["properties"]["isle"] == city_pages.NAMED_POCKETS + 1, (
        "a stub must share the tail colour, not claim to reach the region"
    )
