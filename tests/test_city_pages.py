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
    for i, x in ((0, 0), (1, 200), (2, 400), (3, 414), (4, 614)):
        b.node(i, x)
    b.edge(0, 1, 200, "quiet_street", "Main St")
    b.edge(1, 2, 200, "quiet_street", "Main St")
    b.edge(2, 3, 14, "busy_street", "The Pinch")
    b.edge(3, 4, 200, "quiet_street", "Far St")
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
    for feat in city["islands"]["features"]:
        # nothing in a 600 m toy town can be kilometres long
        assert feat["properties"]["isle_km"] < 1.0


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
    # the same limits the app shows, travelling with the city's numbers
    assert len(city["limits"]) == 3
    assert city["population_is_headcount"] is True
    assert city["built"] == "2026-08-06"
