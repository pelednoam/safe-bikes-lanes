"""End-to-end routing tests against the built graph (skipped if not built)."""

from pathlib import Path
from typing import Any

import pytest

GRAPH = Path(__file__).resolve().parent.parent / "data" / "graph.pkl"
pytestmark = pytest.mark.skipif(not GRAPH.exists(), reason="graph not built")

DAVIS = "-71.122258,42.396748"
KENDALL = "-71.086705,42.362552"
PORTER = "-71.119033,42.388389"
HARVARD = "-71.118848,42.373576"


@pytest.fixture(scope="module")
def client() -> Any:
    import app as server_app
    from fastapi.testclient import TestClient

    return TestClient(server_app.app)


def busy_fraction(summary: dict[str, Any]) -> float:
    by_class: dict[str, int] = summary["by_class_m"]
    busy = by_class.get("busy_street", 0) + by_class.get("moderate_street", 0)
    return busy / max(summary["meters"], 1)


def test_davis_to_kendall_low_stress(client: Any) -> None:
    resp = client.get(f"/route/{DAVIS}/{KENDALL}")
    assert resp.status_code == 200
    safe = resp.json()["safest"]["summary"]
    # kids mode should keep busy/moderate exposure minimal on this classic pair
    assert busy_fraction(safe) < 0.05
    assert safe["pct_protected"] + safe["pct_quiet"] >= 75
    assert safe["meters"] > 3000  # sanity: it's a real cross-town route


def test_porter_to_harvard(client: Any) -> None:
    resp = client.get(f"/route/{PORTER}/{HARVARD}")
    assert resp.status_code == 200
    safe = resp.json()["safest"]["summary"]
    assert busy_fraction(safe) < 0.10


def test_solo_mode_differs_and_is_shorter_or_equal(client: Any) -> None:
    kids = client.get(f"/route/{DAVIS}/{KENDALL}?mode=kids").json()["safest"]["summary"]
    solo = client.get(f"/route/{DAVIS}/{KENDALL}?mode=solo").json()["safest"]["summary"]
    assert solo["meters"] <= kids["meters"] * 1.05


def test_bad_inputs(client: Any) -> None:
    assert client.get("/route/foo/bar").status_code == 400
    assert client.get(f"/route/{DAVIS}/{KENDALL}?mode=nope").status_code == 400
    # somewhere in the Atlantic
    assert client.get("/route/-70.0,42.0/-70.01,42.01").status_code == 400


def test_network_layer_served(client: Any) -> None:
    resp = client.get("/network.geojson")
    assert resp.status_code == 200
    fc = resp.json()
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) > 10_000
