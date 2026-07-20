"""FastAPI routing server: safest-route queries over the prebuilt graph."""

import itertools
import math
import pickle
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, TypedDict

import networkx as nx
import numpy as np
import numpy.typing as npt
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT: Path = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import config  # noqa: E402

app = FastAPI(title="family-bike-router")

GRAPH_PATH: Path = ROOT / "data" / "graph.pkl"
if not GRAPH_PATH.exists():
    raise SystemExit("data/graph.pkl missing — run pipeline/fetch.py then pipeline/build_graph.py")
with open(GRAPH_PATH, "rb") as f:
    G: nx.MultiDiGraph = pickle.load(f)

NODE_IDS: list[int] = list(G.nodes)
_XY: npt.NDArray[np.float64] = np.array(
    [[G.nodes[n]["x"], G.nodes[n]["y"]] for n in NODE_IDS]
)  # lon, lat


class Caution(TypedDict):
    name: str
    cls: str
    meters: float


class Summary(TypedDict, total=False):
    meters: int
    minutes: int
    pct_protected: int
    pct_quiet: int
    by_class_m: dict[str, int]
    cautions: list[Caution]
    shortest_meters: int
    detour_pct: int


class RoutePayload(TypedDict):
    geojson: dict[str, Any]
    summary: Summary


def nearest_node(lon: float, lat: float) -> int:
    dx = (_XY[:, 0] - lon) * math.cos(math.radians(lat)) * 111_320
    dy = (_XY[:, 1] - lat) * 110_540
    d2 = dx * dx + dy * dy
    i = int(np.argmin(d2))
    if d2[i] > 500**2:
        raise HTTPException(400, "point is too far from the Cambridge/Somerville network")
    return NODE_IDS[i]


def best_edge(u: int, v: int, weight_attr: str = "weight") -> dict[str, Any]:
    return min(G[u][v].values(), key=lambda d: d[weight_attr])


def edge_coords(u: int, v: int, data: Mapping[str, Any]) -> list[list[float]]:
    if "geometry" in data:
        coords: list[list[float]] = [[x, y] for x, y in data["geometry"].coords]
    else:
        coords = [
            [G.nodes[u]["x"], G.nodes[u]["y"]],
            [G.nodes[v]["x"], G.nodes[v]["y"]],
        ]
    # simplified-edge geometries keep the original way direction; flip if needed
    ux, uy = G.nodes[u]["x"], G.nodes[u]["y"]
    if abs(coords[-1][0] - ux) + abs(coords[-1][1] - uy) < abs(coords[0][0] - ux) + abs(
        coords[0][1] - uy
    ):
        coords.reverse()
    return [[round(x, 6), round(y, 6)] for x, y in coords]


def path_payload(nodes_seq: Sequence[int], weight_attr: str = "weight") -> RoutePayload:
    features: list[dict[str, Any]] = []
    total = 0.0
    by_class: dict[str, float] = {}
    cautions: list[Caution] = []
    for u, v in itertools.pairwise(nodes_seq):
        d = best_edge(u, v, weight_attr)
        cls: str = d["cls"]
        length = float(d["length"])
        total += length
        by_class[cls] = by_class.get(cls, 0.0) + length
        name = d.get("name")
        if isinstance(name, list):
            name = name[0]
        if cls in ("sharrow", "moderate_street", "busy_street"):
            prev = cautions[-1] if cautions else None
            if prev and prev["name"] == (name or "unnamed") and prev["cls"] == cls:
                prev["meters"] += length
            else:
                cautions.append({"name": name or "unnamed", "cls": cls, "meters": length})
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": edge_coords(u, v, d)},
                "properties": {
                    "cls": cls,
                    "color": config.CLASS_COLOR[cls],
                    "name": name,
                },
            }
        )
    protected = sum(by_class.get(c, 0.0) for c in ("path", "separated", "buffered"))
    quiet = sum(by_class.get(c, 0.0) for c in ("quiet_street", "service"))
    summary: Summary = {
        "meters": round(total),
        "minutes": round(total / 1000 / 10 * 60),  # ~10 km/h family pace
        "pct_protected": round(100 * protected / total) if total else 0,
        "pct_quiet": round(100 * quiet / total) if total else 0,
        "by_class_m": {k: round(v) for k, v in sorted(by_class.items(), key=lambda x: -x[1])},
        "cautions": [
            Caution(name=c["name"], cls=c["cls"], meters=round(c["meters"]))
            for c in cautions
            if c["meters"] >= 15
        ],
    }
    return {"geojson": {"type": "FeatureCollection", "features": features}, "summary": summary}


@app.get("/route/{src}/{dst}")
def route_path(src: str, dst: str, mode: str = "kids") -> dict[str, RoutePayload]:
    if mode not in ("kids", "solo"):
        raise HTTPException(400, "mode must be 'kids' or 'solo'")
    try:
        slon, slat = map(float, src.split(","))
        dlon, dlat = map(float, dst.split(","))
    except ValueError as exc:
        raise HTTPException(400, "coordinates must be lon,lat") from exc
    a, b = nearest_node(slon, slat), nearest_node(dlon, dlat)
    if a == b:
        raise HTTPException(400, "start and end snap to the same intersection")
    weight_attr = "weight" if mode == "kids" else "weight_solo"
    try:
        safest: list[int] = nx.shortest_path(G, a, b, weight=weight_attr)
        shortest: list[int] = nx.shortest_path(G, a, b, weight="length")
    except nx.NetworkXNoPath as exc:
        raise HTTPException(404, "no path found") from exc
    safe = path_payload(safest, weight_attr)
    short = path_payload(shortest, "length")
    safe["summary"]["shortest_meters"] = short["summary"]["meters"]
    short_m = short["summary"]["meters"]
    safe["summary"]["detour_pct"] = (
        round(100 * (safe["summary"]["meters"] / short_m - 1)) if short_m else 0
    )
    return {"safest": safe, "shortest": short}


@app.get("/network.geojson")
def network() -> FileResponse:
    return FileResponse(ROOT / "data" / "network.geojson", media_type="application/geo+json")


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
