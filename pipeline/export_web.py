"""Export the routing graph to web/data/graph.json for in-browser routing.

Compact format v2 (index-based, flat coordinate arrays). Weights are NOT
precomputed — the browser computes them from raw components so rider profiles
are fully client-side:
  nodes:   [[lon, lat, elev_m], ...]             graph nodes
  names:   ["", "Main Street", ...]              deduped street names
  classes: ["path", ...]                         protection classes
  edges:   [[u, v, len_m, clsIdx, nameIdx, geomIdx, crashFactor, pen_m,
             climb_m, busyRoad01], ...]
           pen_m = busy-crossing penalty meters, climb_m = elevation gain u->v
  geoms:   [[lon, lat, lon, lat, ...], ...]      flat coords, edge u->v order;
           geomIdx = -1 when the edge is a straight line between its nodes
Also copies network.geojson + pois.geojson for map layers, writes
gateways.geojson (signalized crossings of busy streets — the safe "passes"
through barriers), heatmap.geojson (~100 m cells colored by length-weighted
average kid-stress: green/yellow/red), and elevation.geojson (hypsometric
grid).
"""

import datetime
import itertools
import json
import math
import pickle
import shutil
from collections import defaultdict
from typing import Any

import config
import networkx as nx
from elevation import ElevationSampler

WEB_DATA = config.DATA_DIR.parent / "web" / "data"

CELL_LON = 0.0012  # ~98 m at 42.4°N
CELL_LAT = 0.0009  # ~100 m
SAMPLE_STEP_M = 35.0
HEAT_GREEN_MAX = 2.0
HEAT_YELLOW_MAX = 5.0
HEAT_COLORS = {"green": "#1a9850", "yellow": "#f9d057", "red": "#d73027"}


def _seg_samples(coords: list[tuple[float, float]]) -> list[tuple[float, float, float]]:
    """(lon, lat, meters) samples every ~SAMPLE_STEP_M along a polyline."""
    out: list[tuple[float, float, float]] = []
    for (x1, y1), (x2, y2) in itertools.pairwise(coords):
        dx = (x2 - x1) * 111_320 * math.cos(math.radians(y1))
        dy = (y2 - y1) * 110_540
        seg_len = math.hypot(dx, dy)
        n = max(1, round(seg_len / SAMPLE_STEP_M))
        for i in range(n):
            t = (i + 0.5) / n
            out.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, seg_len / n))
    return out


def export_heatmap(graph: nx.MultiDiGraph) -> None:
    cells: defaultdict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0, 0.0])
    seen: set[tuple[int, int, float]] = set()
    for u, v, d in graph.edges(data=True):
        key = (min(u, v), max(u, v), round(float(d["length"]), 1))
        if key in seen:
            continue
        seen.add(key)
        stress = float(d["stress_mult"]) * float(d.get("crash_factor", 1.0))
        if "geometry" in d:
            coords = [(float(x), float(y)) for x, y in d["geometry"].coords]
        else:
            coords = [
                (float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"])),
                (float(graph.nodes[v]["x"]), float(graph.nodes[v]["y"])),
            ]
        for lon, lat, meters in _seg_samples(coords):
            cell = (int(lon / CELL_LON), int(lat / CELL_LAT))
            acc = cells[cell]
            acc[0] += stress * meters
            acc[1] += meters
    feats: list[dict[str, Any]] = []
    for (cx, cy), (weighted, meters) in cells.items():
        if meters < 30:  # ignore near-empty cells
            continue
        avg = weighted / meters
        band = "green" if avg <= HEAT_GREEN_MAX else "yellow" if avg <= HEAT_YELLOW_MAX else "red"
        w, s = cx * CELL_LON, cy * CELL_LAT
        e, n = w + CELL_LON, s + CELL_LAT
        feats.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [[w, s], [e, s], [e, n], [w, n], [w, s]],
                    ],
                },
                "properties": {"color": HEAT_COLORS[band], "stress": round(avg, 2)},
            }
        )
    path = WEB_DATA / "heatmap.geojson"
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
    )
    print(f"wrote {path} ({len(feats)} cells)")


# Hypsometric bands (meters above sea level) → color; the area tops out ~60 m.
ELEV_BANDS: list[tuple[float, str]] = [
    (5, "#4575b4"),
    (12, "#91bfdb"),
    (20, "#e0f3f8"),
    (30, "#fee090"),
    (42, "#fc8d59"),
    (float("inf"), "#d73027"),
]


def export_elevation_heatmap() -> None:
    """Full-coverage elevation grid so hills are visible at a glance."""
    sampler = ElevationSampler()
    feats: list[dict[str, Any]] = []
    lon = config.BBOX_WEST
    while lon < config.BBOX_EAST:
        lat = config.BBOX_SOUTH
        while lat < config.BBOX_NORTH:
            elev = sampler.elevation(lon + CELL_LON / 2, lat + CELL_LAT / 2)
            color = next(c for cap, c in ELEV_BANDS if elev <= cap)
            feats.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [lon, lat],
                                [lon + CELL_LON, lat],
                                [lon + CELL_LON, lat + CELL_LAT],
                                [lon, lat + CELL_LAT],
                                [lon, lat],
                            ],
                        ],
                    },
                    "properties": {"color": color, "elev": round(elev, 1)},
                }
            )
            lat += CELL_LAT
        lon += CELL_LON
    path = WEB_DATA / "elevation.geojson"
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
    )
    print(f"wrote {path} ({len(feats)} cells)")


def export_gateways(graph: nx.MultiDiGraph) -> None:
    """Signalized nodes touching a busy street: the safe crossings ("passes")
    through the barriers that split the low-stress network into islands."""
    busy_nodes: set[int] = set()
    for u, v, d in graph.edges(data=True):
        if d.get("road_busy") or d.get("cls") == "busy_street":
            busy_nodes.add(u)
            busy_nodes.add(v)
    feats: list[dict[str, Any]] = []
    for n, nd in graph.nodes(data=True):
        if n in busy_nodes and nd.get("highway") == "traffic_signals":
            feats.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [round(nd["x"], 6), round(nd["y"], 6)],
                    },
                    "properties": {},
                }
            )
    path = WEB_DATA / "gateways.geojson"
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
    )
    print(f"wrote {path} ({len(feats)} signalized busy crossings)")


def export() -> None:
    with open(config.DATA_DIR / "graph.pkl", "rb") as f:
        graph: nx.MultiDiGraph = pickle.load(f)

    node_index: dict[int, int] = {}
    nodes: list[list[float]] = []
    for n, nd in graph.nodes(data=True):
        node_index[n] = len(nodes)
        nodes.append([round(nd["x"], 6), round(nd["y"], 6), round(float(nd.get("elev", 0)), 1)])

    name_index: dict[str, int] = {"": 0}
    names: list[str] = [""]
    classes: list[str] = sorted(config.CLASS_MULTIPLIER)
    cls_index = {c: i for i, c in enumerate(classes)}

    edges: list[list[float]] = []
    geoms: list[list[float]] = []
    for u, v, d in graph.edges(data=True):
        name = d.get("name")
        if isinstance(name, list):
            name = name[0]
        if not isinstance(name, str):
            name = ""
        if name not in name_index:
            name_index[name] = len(names)
            names.append(name)

        geom_idx = -1
        if "geometry" in d:
            coords = list(d["geometry"].coords)
            if len(coords) > 2:
                ux, uy = graph.nodes[u]["x"], graph.nodes[u]["y"]
                # geometry keeps original way direction; flip to u->v order
                if abs(coords[-1][0] - ux) + abs(coords[-1][1] - uy) < abs(
                    coords[0][0] - ux
                ) + abs(coords[0][1] - uy):
                    coords.reverse()
                flat: list[float] = []
                for x, y in coords:
                    flat.extend((round(x, 6), round(y, 6)))
                geom_idx = len(geoms)
                geoms.append(flat)

        edges.append(
            [
                node_index[u],
                node_index[v],
                round(float(d["length"]), 1),
                cls_index[d["cls"]],
                name_index[name],
                geom_idx,
                round(float(d.get("crash_factor", 1.0)), 2),
                round(float(d.get("xpen", 0.0)), 1),
                round(float(d.get("climb", 0.0)), 1),
                1 if d.get("road_busy") else 0,
            ]
        )

    out: dict[str, Any] = {
        "nodes": nodes,
        "names": names,
        "classes": classes,
        "edges": edges,
        "geoms": geoms,
    }
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    path = WEB_DATA / "graph.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    shutil.copy(config.DATA_DIR / "network.geojson", WEB_DATA / "network.geojson")
    print(
        f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB): "
        f"{len(nodes)} nodes, {len(edges)} edges, {len(geoms)} geometries"
    )
    pois = config.RAW_DIR / "pois.geojson"
    if pois.exists():
        shutil.copy(pois, WEB_DATA / "pois.geojson")
    export_gateways(graph)
    export_heatmap(graph)
    export_elevation_heatmap()
    export_construction()
    export_meta()


def _in_bbox(coords: list[Any]) -> bool:
    """True if any coordinate of a (possibly nested) coord array is in our bbox."""
    flat: list[tuple[float, float]] = []

    def walk(node: list[Any]) -> None:
        if len(node) >= 2 and isinstance(node[0], (int, float)):
            flat.append((float(node[0]), float(node[1])))
            return
        for child in node:
            if isinstance(child, list):
                walk(child)

    walk(coords)
    return any(
        config.BBOX_WEST <= lon <= config.BBOX_EAST
        and config.BBOX_SOUTH <= lat <= config.BBOX_NORTH
        for lon, lat in flat
    )


def export_construction() -> None:
    """Merge active construction into web/data/construction.geojson:
    MassDOT WZDx work zones (when fetched) + Cambridge street/excavation
    permits. Filter: currently active or starting within 21 days."""
    now = datetime.datetime.now(datetime.UTC)
    horizon = now + datetime.timedelta(days=21)
    features: list[dict[str, Any]] = []

    wz = config.RAW_DIR / "workzones.geojson"
    if wz.exists():
        feed = json.loads(wz.read_text())
        for f in feed.get("features", []):
            props = f.get("properties", {})
            core = props.get("core_details", props)
            start_s = str(props.get("start_date") or core.get("start_date") or "")[:19]
            end_s = str(props.get("end_date") or core.get("end_date") or "")[:19]

            def parse(s: str) -> datetime.datetime | None:
                try:
                    return datetime.datetime.fromisoformat(s).replace(
                        tzinfo=datetime.UTC
                    )
                except ValueError:
                    return None

            start = parse(start_s)
            end = parse(end_s)
            if end is not None and end < now:
                continue
            if start is not None and start > horizon:
                continue
            geom = f.get("geometry")
            if not geom or not _in_bbox(geom.get("coordinates", [])):
                continue
            roads = core.get("road_names") or []
            features.append(
                {
                    "type": "Feature",
                    "geometry": geom,
                    "properties": {
                        "src": "massdot_wzdx",
                        "name": ", ".join(str(r) for r in roads) or "work zone",
                        "detail": str(core.get("description", ""))[:200],
                        "start": start_s[:10],
                        "end": end_s[:10],
                    },
                }
            )
    else:
        print("  (no workzones.geojson — WZDx key not configured, skipping)")

    permits = config.RAW_DIR / "cambridge_permits.geojson"
    if permits.exists():
        for f in json.loads(permits.read_text()).get("features", []):
            geom = f.get("geometry")
            if geom and _in_bbox(geom.get("coordinates", [])):
                features.append(f)

    path = WEB_DATA / "construction.geojson"
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":"))
    )
    print(f"wrote {path} ({len(features)} active construction features)")


def export_meta() -> None:
    """Data-freshness manifest for the app's About dialog: when each source
    was last retrieved (from the fetch sidecars) and when the graph was built."""
    sources: list[dict[str, Any]] = []
    for meta_path in sorted(config.RAW_DIR.glob("*.meta.json")):
        info = json.loads(meta_path.read_text())
        sources.append(
            {
                "name": meta_path.name.replace(".geojson.meta.json", ""),
                "retrieved": info.get("retrieved", "")[:10],
                "features": info.get("features", 0),
            }
        )
    out = {
        "built": datetime.datetime.now(datetime.UTC).isoformat()[:10],
        "sources": sources,
    }
    path = WEB_DATA / "meta.json"
    path.write_text(json.dumps(out, indent=1))
    print(f"wrote {path} ({len(sources)} sources)")


if __name__ == "__main__":
    export()
