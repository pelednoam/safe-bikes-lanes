"""Build the safety-weighted routing graph.

OSM (via OSMnx) provides the network geometry and base classification; official
layers (Cambridge Bike Facilities, MassDOT Bike Inventory, MassDOT LTS) and the
crash overlay adjust per-edge protection class and cost. Outputs:

  data/graph.pkl        pickled networkx MultiDiGraph with `weight` per edge
  data/network.geojson  undirected edge layer for map display
"""

import json
import math
import pickle
from collections import Counter
from collections.abc import Mapping
from typing import Any, Final

import config
import geopandas as gpd
import networkx as nx
import osmnx as ox
import pandas as pd
from elevation import ElevationSampler
from shapely.geometry import LineString, Point

METRIC_CRS: Final[str] = "EPSG:26986"  # MA mainland state plane (meters)
BBOX: Final[tuple[float, float, float, float]] = (
    config.BBOX_WEST,
    config.BBOX_SOUTH,
    config.BBOX_EAST,
    config.BBOX_NORTH,
)

ROAD_BUSY: Final[set[str]] = {
    "primary", "primary_link", "secondary", "secondary_link", "trunk", "trunk_link",
}
ROAD_MODERATE: Final[set[str]] = {"tertiary", "tertiary_link"}
PATHLIKE: Final[set[str]] = {
    "cycleway", "path", "footway", "pedestrian", "track", "bridleway", "steps",
}

ox.settings.useful_tags_way = list(
    set(ox.settings.useful_tags_way)
    | {
        "cycleway", "cycleway:left", "cycleway:right", "cycleway:both",
        "bicycle", "maxspeed", "surface", "segregated", "oneway:bicycle",
    }
)
ox.settings.useful_tags_node = ["ref", "highway", "crossing"]


def listy(v: Any) -> list[Any]:
    return v if isinstance(v, list) else [v]


def mult(cls: str) -> float:
    return config.CLASS_MULTIPLIER[cls]


def safer(a: str | None, b: str | None) -> str | None:
    if a is None:
        return b
    if b is None:
        return a
    return a if mult(a) <= mult(b) else b


def parse_maxspeed_mph(v: Any) -> float | None:
    for item in listy(v):
        if not item:
            continue
        try:
            return float(str(item).split()[0])
        except ValueError:
            continue
    return None


def classify_osm(tags: Mapping[str, Any]) -> tuple[str, bool]:
    """Base protection class from OSM tags alone, plus a busy-road flag.

    Conservative: when a tag is a list (simplified edge spans several ways),
    road class uses the worst part but a facility tag anywhere counts —
    mixed segments are rare and short."""
    hws: list[str] = [h for h in listy(tags.get("highway")) if h]

    def hw_in(group: set[str]) -> bool:
        return any(h in group for h in hws)

    if hws and all(h in PATHLIKE for h in hws):
        return "path", False
    cw: set[str] = set()
    for key in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both"):
        cw.update(v for v in listy(tags.get(key)) if v)
    busy = hw_in(ROAD_BUSY)
    if {"track", "separate", "separated"} & cw:
        return "separated", busy
    if "buffered_lane" in cw:
        return "buffered", busy
    if "lane" in cw:
        return "lane", busy
    if {"shared_lane", "share_busway"} & cw:
        return "sharrow", busy
    if busy:
        return "busy_street", True
    if hw_in(ROAD_MODERATE):
        return "moderate_street", False
    if hw_in({"service"}):
        return "service", False
    ms = parse_maxspeed_mph(tags.get("maxspeed"))
    if ms is not None and ms > 30:
        return "moderate_street", False
    return "quiet_street", False


# ---------------------------------------------------------------------------
# geometry helpers
# ---------------------------------------------------------------------------

def bearing_near(line: LineString, pt: Point, chord: float = 6.0) -> float:
    """Bearing (0-180) of `line` around the point nearest to `pt`."""
    d = line.project(pt)
    p1 = line.interpolate(max(d - chord, 0))
    p2 = line.interpolate(min(d + chord, line.length))
    ang = math.degrees(math.atan2(p2.y - p1.y, p2.x - p1.x))
    return ang % 180


def angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 180
    return min(d, 180 - d)


def overlay_match(
    edges: gpd.GeoDataFrame,
    overlay: gpd.GeoDataFrame,
    radius: float,
    max_angle: float = config.FACILITY_JOIN_MAX_ANGLE_DEG,
) -> list[int | None]:
    """For each edge, the overlay feature running along it (None if no match).

    `edges` and `overlay` must be in a metric CRS. Overlay rows need columns
    `geometry` and `cls`. Path-class overlay features only match path-like OSM
    edges — otherwise an off-street path would upgrade the parallel roadway.
    Returns a list aligned with edges.index of overlay row positions or None.
    """
    overlay = overlay.explode(index_parts=False).reset_index(drop=True)
    sindex = overlay.sindex
    results: list[int | None] = []
    for geom, is_path in zip(edges.geometry, edges["is_pathlike"], strict=True):
        mid = geom.interpolate(0.5, normalized=True)
        edge_brg = bearing_near(geom, mid)
        best: int | None = None
        best_d: float | None = None
        for pos in sindex.query(mid.buffer(radius)):
            row = overlay.iloc[pos]
            if row["cls"] == "path" and not is_path:
                continue
            d = row.geometry.distance(mid)
            if d > radius:
                continue
            # polygons (e.g. corridor areas) match on distance alone
            if row.geometry.geom_type == "LineString" and (
                angle_diff(edge_brg, bearing_near(row.geometry, mid)) > max_angle
            ):
                continue
            if best_d is None or d < best_d:
                best, best_d = pos, d
        results.append(best)
    return results


# ---------------------------------------------------------------------------
# load overlays
# ---------------------------------------------------------------------------

def load_geojson(name: str) -> gpd.GeoDataFrame | None:
    path = config.RAW_DIR / name
    if not path.exists():
        print(f"  (missing {name} — skipping)")
        return None
    gdf = gpd.GeoDataFrame.from_features(json.loads(path.read_text()), crs="EPSG:4326")
    return gdf.to_crs(METRIC_CRS)


def cambridge_overlay() -> gpd.GeoDataFrame | None:
    gdf = load_geojson("cambridge_bike_facilities.geojson")
    if gdf is None:
        return None
    gdf = gdf[gdf["ExistingFacility"].notna()].copy() if "ExistingFacility" in gdf else gdf
    gdf["cls"] = gdf["FacilityType"].map(config.CAMBRIDGE_FACILITY_CLASS)
    return gdf[gdf["cls"].notna()][["geometry", "cls"]]


def boston_overlay() -> gpd.GeoDataFrame | None:
    gdf = load_geojson("boston_bike_facilities.geojson")
    if gdf is None:
        return None
    gdf = gdf.copy()
    gdf["cls"] = gdf["ExisFacil"].map(config.BOSTON_FACILITY_CLASS)
    return gdf[gdf["cls"].notna()][["geometry", "cls"]]


MASSDOT_FAC_CLASS: Final[dict[int, str]] = {
    1: "lane", 2: "separated", 3: "sharrow", 4: "lane", 5: "path",
    7: "quiet_street", 8: "lane", 9: "sharrow",
}


def massdot_overlay() -> gpd.GeoDataFrame | None:
    gdf = load_geojson("massdot_bike_inventory.geojson")
    if gdf is None:
        return None
    if "Planned_Facility_Status" in gdf:
        gdf = gdf[gdf["Planned_Facility_Status"].isna()]
    gdf = gdf.copy()
    gdf["cls"] = gdf["Fac_Type"].map(MASSDOT_FAC_CLASS)
    return gdf[gdf["cls"].notna()][["geometry", "cls"]]


def lts_overlay() -> gpd.GeoDataFrame | None:
    gdf = load_geojson("massdot_lts.geojson")
    if gdf is None:
        return None
    gdf = gdf[gdf["LTS_define"].isin([1, 2, 3, 4])].copy()
    gdf["cls"] = "lts"  # class label unused; carries LTS score instead
    gdf["lts"] = gdf["LTS_define"].astype(int)
    return gdf[["geometry", "cls", "lts"]]


def overrides_overlay() -> gpd.GeoDataFrame | None:
    path = config.DATA_DIR / "overrides.geojson"
    if not path.exists():
        path.write_text(json.dumps({"type": "FeatureCollection", "features": []}, indent=2))
        return None
    raw = json.loads(path.read_text())
    if not raw.get("features"):
        return None
    gdf = gpd.GeoDataFrame.from_features(raw, crs="EPSG:4326")
    gdf = gdf.to_crs(METRIC_CRS)
    gdf["cls"] = gdf["class"]
    return gdf[["geometry", "cls"]]


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def build() -> None:
    print("downloading OSM graph (bike network) ...")
    G = ox.graph_from_bbox(BBOX, network_type="bike", simplify=True, truncate_by_edge=True)
    print(f"  bike graph: {len(G.nodes)} nodes, {len(G.edges)} edges")
    print("downloading OSM bike-permitted footpaths ...")
    try:
        G_foot = ox.graph_from_bbox(
            BBOX,
            custom_filter='["highway"~"footway|pedestrian|path"]["bicycle"~"yes|designated|permissive"]',
            simplify=True,
            retain_all=True,
            truncate_by_edge=True,
        )
        G = nx.compose(G_foot, G)
        print(f"  after adding footpaths: {len(G.nodes)} nodes, {len(G.edges)} edges")
    except Exception as e:
        print(f"  footpath layer failed ({e}) — continuing with bike graph only")

    nodes, edges = ox.graph_to_gdfs(G)
    edges = edges.to_crs(METRIC_CRS)

    # base classification from OSM tags
    base = [classify_osm(t) for t in edges.to_dict("records")]
    edges["cls"] = [c for c, _ in base]
    edges["road_busy"] = [b for _, b in base]
    edges["is_pathlike"] = edges["cls"] == "path"
    edges["source"] = "osm"
    edges["lts"] = 0

    # official overlays, in increasing precedence
    for name, overlay, radius in [
        ("massdot", massdot_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("cambridge", cambridge_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("boston", boston_overlay(), config.FACILITY_JOIN_RADIUS_M),
    ]:
        if overlay is None or overlay.empty:
            continue
        print(f"matching {name} overlay ({len(overlay)} features) ...")
        matches = overlay_match(edges, overlay, radius)
        exploded = overlay.explode(index_parts=False).reset_index(drop=True)
        upgraded = 0
        for i, pos in enumerate(matches):
            if pos is None:
                continue
            cls = exploded.iloc[pos]["cls"]
            # official path can't upgrade an on-road edge past "separated"
            cur = edges.iloc[i]["cls"]
            new = safer(cur, cls)
            if new != cur:
                edges.iat[i, edges.columns.get_loc("cls")] = new
                edges.iat[i, edges.columns.get_loc("source")] = name
                upgraded += 1
        print(f"  upgraded {upgraded} edges")

    # LTS escalation: official high-stress rating on an edge we think is calm
    lts = lts_overlay()
    if lts is not None and not lts.empty:
        print(f"matching MassDOT LTS ({len(lts)} features) ...")
        matches = overlay_match(edges, lts, radius=15)
        exploded = lts.explode(index_parts=False).reset_index(drop=True)
        escalated = 0
        for i, pos in enumerate(matches):
            if pos is None:
                continue
            score = int(exploded.iloc[pos]["lts"])
            edges.iat[i, edges.columns.get_loc("lts")] = score
            if score >= 3:
                cur = edges.iloc[i]["cls"]
                new = {"quiet_street": "moderate_street", "moderate_street": "busy_street"}.get(cur)
                if new:
                    edges.iat[i, edges.columns.get_loc("cls")] = new
                    escalated += 1
        print(f"  escalated {escalated} edges via LTS>=3")

    # manual overrides trump everything (can downgrade too)
    ov = overrides_overlay()
    if ov is not None and not ov.empty:
        print(f"applying {len(ov)} manual overrides ...")
        matches = overlay_match(edges, ov, radius=config.FACILITY_JOIN_RADIUS_M)
        exploded = ov.explode(index_parts=False).reset_index(drop=True)
        for i, pos in enumerate(matches):
            if pos is not None:
                edges.iat[i, edges.columns.get_loc("cls")] = exploded.iloc[pos]["cls"]
                edges.iat[i, edges.columns.get_loc("source")] = "override"

    # crash density
    crash_frames: list[gpd.GeoDataFrame] = []
    for year in config.IMPACT_CRASH_YEARS:
        gdf = load_geojson(f"crashes_{year}.geojson")
        if gdf is not None:
            crash_frames.append(gdf[["geometry"]])
    edges["crash_count"] = 0
    if crash_frames:
        crashes = pd.concat(crash_frames, ignore_index=True)
        print(f"joining {len(crashes)} bike crashes (2021-2026) ...")
        # query returns (input=crash indices, tree=edge positions)
        _crash_idx, edge_pos = edges.sindex.query(
            crashes.geometry, predicate="dwithin", distance=config.CRASH_JOIN_RADIUS_M
        )
        counts = Counter(edge_pos)
        cc = edges.columns.get_loc("crash_count")
        for pos, n in counts.items():
            edges.iat[pos, cc] = n

    edges["crash_per_100m"] = edges["crash_count"] / (edges["length"].clip(lower=20) / 100)
    edges["crash_factor"] = (1 + config.CRASH_WEIGHT * edges["crash_per_100m"]).clip(
        upper=config.CRASH_FACTOR_CAP
    )

    # Somerville official high-crash corridors: extra factor
    corridors = load_geojson("somerville_high_crash_corridors.geojson")
    if corridors is not None and not corridors.empty:
        corridors = corridors.copy()
        corridors["cls"] = "corridor"
        matches = overlay_match(edges, corridors, radius=15)
        flagged = [i for i, p in enumerate(matches) if p is not None]
        cf = edges.columns.get_loc("crash_factor")
        cap = config.CRASH_FACTOR_CAP * config.SOMERVILLE_HIGH_CRASH_FACTOR
        for i in flagged:
            edges.iat[i, cf] = min(edges.iat[i, cf] * config.SOMERVILLE_HIGH_CRASH_FACTOR, cap)
        print(f"  {len(flagged)} edges inside Somerville high-crash corridors")

    # class multiplier, with busy-road override for painted facilities
    def edge_mult(row: "pd.Series[Any]") -> float:
        if row["road_busy"] and row["cls"] == "lane":
            return config.BUSY_ROAD_LANE_MULTIPLIER
        if row["road_busy"] and row["cls"] == "buffered":
            return config.BUSY_ROAD_BUFFERED_MULTIPLIER
        return mult(row["cls"])

    def edge_mult_solo(row: "pd.Series[Any]") -> float:
        if row["road_busy"] and row["cls"] == "lane":
            return config.SOLO_BUSY_ROAD_LANE_MULTIPLIER
        if row["road_busy"] and row["cls"] == "buffered":
            return config.SOLO_BUSY_ROAD_BUFFERED_MULTIPLIER
        return config.SOLO_CLASS_MULTIPLIER[row["cls"]]

    edges["stress_mult"] = edges.apply(edge_mult, axis=1)
    edges["stress_mult_solo"] = edges.apply(edge_mult_solo, axis=1)

    # node crossing penalties: nodes touching a busy street
    busy_nodes: set[int] = set()
    for (u, v, _k), cls, rb in zip(edges.index, edges["cls"], edges["road_busy"], strict=True):
        if cls == "busy_street" or rb:
            busy_nodes.add(u)
            busy_nodes.add(v)
    signal_nodes: set[int] = {
        n
        for n, row in nodes.iterrows()
        if row.get("highway") == "traffic_signals" or row.get("crossing") == "traffic_signals"
    }

    def node_penalty(n: int) -> float:
        if n not in busy_nodes:
            return 0.0
        if n in signal_nodes:
            return config.SIGNALIZED_BUSY_CROSSING_PENALTY_M
        return config.UNSIGNALIZED_BUSY_CROSSING_PENALTY_M

    # node elevations -> per-edge climb (positive rise along travel direction)
    print("sampling node elevations (AWS terrain tiles) ...")
    sampler = ElevationSampler()
    elev: dict[int, float] = {}
    for n, nd in G.nodes(data=True):
        e_m = sampler.elevation(float(nd["x"]), float(nd["y"]))
        elev[n] = e_m
        nd["elev"] = round(e_m, 1)

    # final weights (kids + solo), written back into the graph
    for (u, v, k), row in edges.iterrows():
        pen = 0.0
        if not (row["cls"] == "busy_street" or row["road_busy"]):
            pen = (node_penalty(u) + node_penalty(v)) / 2
        data = G.edges[u, v, k]
        data["climb"] = round(max(0.0, elev[v] - elev[u]), 2)
        data["xpen"] = round(pen, 1)
        data["road_busy"] = bool(row["road_busy"])
        data["cls"] = row["cls"]
        data["stress_mult"] = float(row["stress_mult"])
        data["crash_factor"] = float(row["crash_factor"])
        data["weight"] = float(
            row["length"] * row["stress_mult"] * row["crash_factor"] + pen
        )
        data["weight_solo"] = float(
            row["length"] * row["stress_mult_solo"] * row["crash_factor"]
            + pen * config.SOLO_PENALTY_SCALE
        )
        data["cls_source"] = row["source"]

    # keep the largest strongly connected component so routing can't dead-end
    scc = max(nx.strongly_connected_components(G), key=len)
    G = G.subgraph(scc).copy()
    print(f"final graph: {len(G.nodes)} nodes, {len(G.edges)} edges (largest SCC)")
    print("class distribution (m):")
    dist: Counter[str] = Counter()
    for _, _, d in G.edges(data=True):
        dist[d["cls"]] += d["length"]
    for cls, meters in sorted(dist.items(), key=lambda x: -x[1]):
        print(f"  {cls:16s} {meters/1000:8.1f} km")

    config.DATA_DIR.mkdir(exist_ok=True)
    with open(config.DATA_DIR / "graph.pkl", "wb") as f:
        pickle.dump(G, f)

    # display layer: one feature per undirected edge
    seen: set[tuple[int, int, float]] = set()
    feats: list[dict[str, Any]] = []
    edges_wgs = edges.to_crs("EPSG:4326")
    for (u, v, k), row in edges_wgs.iterrows():
        if not G.has_edge(u, v, k):
            continue
        key = (min(u, v), max(u, v), round(row["length"], 1))
        if key in seen:
            continue
        seen.add(key)
        # pandas gives NaN for unnamed ways; NaN is invalid JSON
        raw_name = (listy(row.get("name")) or [None])[0]
        feats.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [round(x, 6), round(y, 6)] for x, y in row.geometry.coords
                    ],
                },
                "properties": {
                    "cls": row["cls"],
                    "color": config.CLASS_COLOR[row["cls"]],
                    "name": raw_name if isinstance(raw_name, str) else None,
                    "source": row["source"],
                    "crashes": int(row["crash_count"]),
                },
            }
        )
    (config.DATA_DIR / "network.geojson").write_text(
        # allow_nan=False: fail loudly instead of emitting JSON that
        # JavaScript cannot parse (this silently blanked the map once)
        json.dumps({"type": "FeatureCollection", "features": feats}, allow_nan=False)
    )
    print(f"wrote network.geojson ({len(feats)} display edges)")


if __name__ == "__main__":
    build()
