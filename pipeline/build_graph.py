"""Build the safety-weighted routing graph.

OSM (via OSMnx) provides the network geometry and base classification; official
layers (Cambridge Bike Facilities, MassDOT Bike Inventory, MassDOT LTS) and the
crash overlay adjust per-edge protection class and cost. Outputs:

  data/graph.pkl        pickled networkx MultiDiGraph with `weight` per edge
  data/network.geojson  undirected edge layer for map display
"""

import itertools
import json
import math
import os
import pickle
import time
from collections import Counter
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from typing import Any, Final

import config
import geopandas as gpd
import networkx as nx
import osmnx as ox
import pandas as pd
from elevation import ElevationSampler
from shapely.geometry import LineString, Point

METRIC_CRS: Final[str] = "EPSG:26986"  # MA mainland state plane (meters)


def _bbox() -> tuple[float, float, float, float]:
    """Config bbox, or a smaller PROFILE_BBOX='w,s,e,n' for fast profiling runs."""
    env = os.environ.get("PROFILE_BBOX")
    if env:
        w, s, e, n = (float(x) for x in env.split(","))
        return (w, s, e, n)
    return (config.BBOX_WEST, config.BBOX_SOUTH, config.BBOX_EAST, config.BBOX_NORTH)


BBOX: Final[tuple[float, float, float, float]] = _bbox()


def mem(stage: str) -> None:
    """Log current + peak resident memory at a build stage."""
    try:
        with open("/proc/self/status") as f:
            info = {k: v for k, v in (ln.split(":", 1) for ln in f if ":" in ln)}
        rss = int(info["VmRSS"].split()[0]) / 1e6
        peak = int(info["VmHWM"].split()[0]) / 1e6
        print(f"  [mem] {stage:28s} rss={rss:5.1f} GB  peak={peak:5.1f} GB", flush=True)
    except (OSError, KeyError):
        pass

ROAD_BUSY: Final[set[str]] = {
    "primary", "primary_link", "secondary", "secondary_link", "trunk", "trunk_link",
}
ROAD_MODERATE: Final[set[str]] = {"tertiary", "tertiary_link"}
PATHLIKE: Final[set[str]] = {
    "cycleway", "path", "footway", "pedestrian", "track", "bridleway", "steps",
}
# Off-street classes: an official layer drawing one of these beside a road must
# not upgrade the road (see overlay_match).
OFFSTREET: Final[frozenset[str]] = frozenset({"path", "unpaved"})
# Ways that are dirt unless someone has said otherwise.
UNSURFACED_BY_DEFAULT: Final[set[str]] = {"track", "bridleway"}
# Surfaces a child's bike does badly on. `gravel` is here and `fine_gravel` and
# `compacted` are not: in OSM, gravel is loose crushed rock, while fine_gravel
# and compacted are the packed stone dust of rail trails, which a kid rides
# like pavement. `natural` is not a documented value but is in this region's
# data (126 edges), always on woodland trails.
UNPAVED_SURFACES: Final[frozenset[str]] = frozenset({
    "unpaved", "dirt", "ground", "earth", "grass", "mud", "sand", "gravel",
    "pebblestone", "rock", "stone", "woodchips", "grass_paver", "natural", "soil",
})

ox.settings.useful_tags_way = list(
    set(ox.settings.useful_tags_way)
    | {
        "cycleway", "cycleway:left", "cycleway:right", "cycleway:both",
        "bicycle", "maxspeed", "surface", "segregated", "oneway:bicycle",
        "tracktype",
    }
)
ox.settings.useful_tags_node = ["ref", "highway", "crossing"]


def listy(v: Any) -> list[Any]:
    return v if isinstance(v, list) else [v]


def tag_values(tags: Mapping[str, Any], key: str) -> list[str]:
    """A tag's values as strings, without the None/NaN/"" that stand for
    "absent" once edges have been through a DataFrame."""
    return [str(v) for v in listy(tags.get(key)) if v is not None and v == v and v != ""]


def mult(cls: str) -> float:
    return config.CLASS_MULTIPLIER[cls]


def safer(a: str | None, b: str | None) -> str | None:
    if a is None:
        return b
    if b is None:
        return a
    return a if mult(a) <= mult(b) else b


KMH_PER_MPH: Final[float] = 1.609344


def parse_maxspeed_mph(v: Any) -> float | None:
    """The highest posted limit on an edge, in mph.

    Highest, not first: a simplified edge that merges ways with different limits
    is as stressful as its fastest part, which is what classify_osm's "worst
    part" rule promises. An explicit "km/h" is converted. Words ("walk",
    "none", "signals") and values like "US:urban" say nothing numeric and are
    skipped.

    A bare number stays mph, although OSM's default unit is km/h. Every sign in
    Massachusetts is in mph, so a bare "40" here is a mapper who left the unit
    off a 40 mph road, not a 25 mph street; 117 edges carry one. Converting
    would read those roads as calmer than their signs, the one direction a tool
    that puts children on streets must not err in. (tests/test_overlays.py has
    locked this in on purpose since it was first noticed.)
    """
    best: float | None = None
    for item in listy(v):
        if not item:
            continue
        for part in str(item).split(";"):
            words = part.strip().lower().split()
            if not words:
                continue
            number, unit = words[0], " ".join(words[1:])
            if number.endswith("mph"):
                number, unit = number[: -len("mph")], "mph"
            try:
                value = float(number)
            except ValueError:
                continue
            if unit == "mph":
                mph = value
            elif unit == "":
                mph = value  # see above: the sign says mph
            elif unit in ("km/h", "kmh", "kph"):
                mph = value / KMH_PER_MPH
            else:  # knots and anything unforeseen: not a road speed we can read
                continue
            best = mph if best is None else max(best, mph)
    return best


def parse_lanes(v: Any) -> int | None:
    """The most motor-traffic lanes any part of an edge has."""
    best: int | None = None
    for item in listy(v):
        for part in str(item).split(";"):
            try:
                n = int(float(part.strip()))
            except ValueError:
                continue
            best = n if best is None else max(best, n)
    return best


MULTILANE_MIN_LANES: Final[int] = 3


def multilane(tags: Mapping[str, Any]) -> bool:
    """A road built to move traffic, whatever its highway tag says: three or
    more motor lanes, i.e. two in at least one direction (or two plus a turn
    lane).

    Deliberately not "two on a one-way street", though that is also two in a
    direction. In this region the tag does not mean that: 4,689 one-way
    residential edges (412 km) carry lanes=2, and the ones checked by name —
    Dacia St, Bodwell St, Sagamore St in Dorchester — are narrow one-lane
    streets with parking, the parking lane counted as a lane. Escalating them
    would move 412 km of quiet streets to 8x cost on the strength of a tagging
    habit; lanes >= 3 is where the tag and the street agree.
    """
    n = parse_lanes(tags.get("lanes"))
    return n is not None and n >= MULTILANE_MIN_LANES


def rough_surface(tags: Mapping[str, Any]) -> bool:
    """Someone has tagged some part of this way with a rough surface."""
    return any(s.strip().lower() in UNPAVED_SURFACES for s in tag_values(tags, "surface"))


def offstreet_class(tags: Mapping[str, Any], hws: list[str]) -> str:
    """"path" or "unpaved" for a way that is off the street.

    `surface` was downloaded and never read, so a mud bridleway and a paved
    rail trail were both "path", the best class there is, and a family could be
    routed down a horse trail as the safest way home. Unpaved if any part is
    tagged rough (the worst part governs, as for roads), or if it is a track or
    bridleway nobody has described as surfaced: those are farm and forest
    roads unless tagged otherwise (tracktype=grade1 is the solid kind).
    """
    if rough_surface(tags):
        return "unpaved"
    if any(h in UNSURFACED_BY_DEFAULT for h in hws):
        surfaced = bool(tag_values(tags, "surface")) or "grade1" in tag_values(
            tags, "tracktype"
        )
        if not surfaced:
            return "unpaved"
    return "path"


def classify_road(tags: Mapping[str, Any]) -> str:
    """The class a way has on its own merits, before any bike facility.

    This is the price floor for painted facilities: a lane or sharrow can only
    make a street better than it already is (see facility_multiplier)."""
    hws: list[str] = [h for h in listy(tags.get("highway")) if h]

    def hw_in(group: set[str]) -> bool:
        return any(h in group for h in hws)

    if hws and all(h in PATHLIKE for h in hws):
        return offstreet_class(tags, hws)
    if hw_in(ROAD_BUSY):
        return "busy_street"
    if hw_in(ROAD_MODERATE):
        return "moderate_street"
    if hw_in({"service"}):
        return "service"
    ms = parse_maxspeed_mph(tags.get("maxspeed"))
    if ms is not None and ms > 30:
        return "moderate_street"
    if multilane(tags):
        return "moderate_street"
    return "quiet_street"


def facility_class(values: Iterable[Any]) -> str | None:
    """The protection class a set of `cycleway*` values describes, if any.

    `track` is a protected lane on this carriageway. `separate` is the opposite
    claim: the bike facility is mapped as its own way beside the road, and the
    road carries none — that way gets its own edge and its own class, and the
    road is classified as the road it is. Reading `separate` as protection put
    1,033 edge-directions (57 km) in the best class, 638 of them (35 km) bare
    arterial. `separated` is not an OSM value at all; it gets no benefit of the
    doubt."""
    cw = {str(v) for v in values if v}
    if "track" in cw:
        return "separated"
    if "buffered_lane" in cw:
        return "buffered"
    if "lane" in cw:
        return "lane"
    if {"shared_lane", "share_busway"} & cw:
        return "sharrow"
    return None


CYCLEWAY_KEYS: Final[tuple[str, ...]] = (
    "cycleway", "cycleway:left", "cycleway:right", "cycleway:both",
)


def car_oneway(tags: Mapping[str, Any]) -> bool:
    """osmnx's `oneway`: a bool (numpy's, after a DataFrame), maybe a list."""
    return any(str(o) == "True" for o in listy(tags.get("oneway")))


def bike_contraflow(tags: Mapping[str, Any]) -> bool:
    """Bikes may ride this one-way street against the traffic."""
    if "no" in tag_values(tags, "oneway:bicycle"):
        return True
    return any(
        v.startswith("opposite") for key in CYCLEWAY_KEYS for v in tag_values(tags, key)
    )


def travel_direction(tags: Mapping[str, Any]) -> str | None:
    """Whether an edge runs with ("forward") or against ("backward") the OSM
    way it came from, or None when a merged edge mixes both."""
    rev = {bool(r) for r in listy(tags.get("reversed")) if r is not None and r == r}
    if rev == {False}:
        return "forward"
    if rev == {True}:
        return "backward"
    return None


def facility_values(tags: Mapping[str, Any]) -> list[str]:
    """The `cycleway*` values that describe the side of the street this edge
    rides on.

    OSM's sides are relative to the way's direction, and traffic keeps right:
    on a two-way street cycleway:right serves riders travelling with the way
    and cycleway:left riders travelling against it. Counting both for both
    directions gave the whole street a lane that only one side has. On a
    one-way street every side serves the one direction — unless bikes may ride
    it both ways, when the left side is the contraflow lane (the usual tagging,
    with or without cycleway:left:oneway=-1). `opposite_lane`/`opposite_track`
    on `cycleway` are the older way of saying the same, and `opposite` means
    contraflow with no facility at all.
    """
    def vals(key: str) -> list[str]:
        return tag_values(tags, key)

    plain = [v for v in vals("cycleway") if not v.startswith("opposite")]
    opposite = [
        v.removeprefix("opposite").lstrip("_")
        for key in CYCLEWAY_KEYS
        for v in vals(key)
        if v.startswith("opposite")
    ]
    direction = travel_direction(tags)
    one_way = car_oneway(tags)
    contraflow = one_way and bike_contraflow(tags)
    if direction == "forward":
        out = plain + vals("cycleway:both") + vals("cycleway:right")
        if one_way and not contraflow:
            out += vals("cycleway:left")
        return out
    if direction == "backward":
        out = vals("cycleway:both") + vals("cycleway:left") + opposite
        if not one_way:
            out += plain
        return out
    # a merged edge running both ways along its parts: any facility counts, as
    # it always has (and as for roads, mixed segments are rare and short)
    return [v for key in CYCLEWAY_KEYS for v in vals(key) if not v.startswith("opposite")]


def classify_osm(tags: Mapping[str, Any]) -> tuple[str, bool]:
    """Base protection class from OSM tags alone, plus a busy-road flag.

    Conservative: when a tag is a list (simplified edge spans several ways),
    road class uses the worst part. The facility is the one on this edge's
    side of the street (facility_values)."""
    road = classify_road(tags)
    if road in OFFSTREET:
        return road, False
    busy = road == "busy_street"
    return facility_class(facility_values(tags)) or road, busy


def add_contraflow_edges(graph: nx.MultiDiGraph) -> int:
    """Give bikes the direction a one-way street allows them and cars.

    osmnx builds edge directions from `oneway` alone, so oneway:bicycle=no and
    cycleway=opposite* were downloaded and ignored: the router could not ride a
    contraflow lane it was drawing on the map, and sent families round the
    block instead. Each such edge gets its reverse, geometry flipped and marked
    `contraflow`, classified later by facility_values like any other.

    Only for an edge that is a single OSM way. osmnx merges a chain of ways
    into one edge and keeps each tag's distinct values, dropping the ways that
    lack the tag — so oneway:bicycle="no" on a merged edge cannot say whether
    every way in the chain allows contraflow, and routing a child the wrong way
    down the part that doesn't is the one mistake this must not make.
    """
    added = 0
    for u, v, _k, d in list(graph.edges(keys=True, data=True)):
        if not car_oneway(d) or isinstance(d.get("osmid"), list):
            continue
        if not bike_contraflow(d) or travel_direction(d) is None:
            continue
        existing = graph.get_edge_data(v, u, default={}).values()
        if any(e.get("osmid") == d.get("osmid") for e in existing):
            continue  # already two-way here
        back = dict(d)
        back["reversed"] = not bool(d.get("reversed"))
        back["contraflow"] = True
        if isinstance(d.get("geometry"), LineString):
            back["geometry"] = LineString(list(d["geometry"].coords)[::-1])
        graph.add_edge(v, u, **back)
        added += 1
    return added


def facility_multiplier(
    cls: str,
    road_cls: str,
    busy: bool,
    table: Mapping[str, float],
    busy_lane: float,
    busy_buffered: float,
) -> float:
    """What riding an edge of class `cls` costs per metre, for one profile.

    Two rules on top of the class table:

    On a busy road, paint buys little: a lane or buffered lane there has its own
    (higher) price, and a sharrow — a marking, not a space — buys nothing, so it
    costs what the busy road costs. It used to cost 6.0, a quarter of the bare
    arterial it is painted on.

    And paint can only help. A marked facility never costs more than the same
    street without it: a residential street was 1.4 bare, 3.0 with a painted
    lane and 6.0 with sharrows, so the router steered families off quiet streets
    because someone had improved them. `road_cls` is the street's own class
    (classify_road), and the class shown to riders stays the facility.
    """
    m = table[cls]
    if busy:
        if cls == "lane":
            m = busy_lane
        elif cls == "buffered":
            m = busy_buffered
        elif cls == "sharrow":
            m = table["busy_street"]
    return min(m, table[road_cls])


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
            if row["cls"] in OFFSTREET and not is_path:
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

def edge_schema(graph: nx.MultiDiGraph) -> list[str]:
    """The attributes present on *every* edge, asked of the graph itself.

    Stamped onto the graph so a consumer can tell a graph it can use from one
    built before the attribute it needs existed — priorities.py spent weeks
    reporting "recorded bike crashes nearby" instead of counts because it read a
    graph built before crash_count existed, and nothing said so.

    Derived rather than declared. The first version listed what the weight
    write-back adds, which omitted everything osmnx puts on an edge at creation:
    it declared `length` missing and failed the weekly refresh outright. A list
    maintained by hand is a list that disagrees with the graph.
    """
    common: set[str] | None = None
    for _u, _v, data in graph.edges(data=True):
        keys = set(data)
        common = keys if common is None else common & keys
    return sorted(common or ())


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


def newton_overlay() -> gpd.GeoDataFrame | None:
    gdf = load_geojson("newton_bike_facilities.geojson")
    if gdf is None:
        return None
    if "Status" in gdf:
        gdf = gdf[gdf["Status"] == "Existing"]  # skip Planned/Programmed
    gdf = gdf.copy()
    gdf["cls"] = gdf["FacilityType"].map(config.NEWTON_FACILITY_CLASS)
    return gdf[gdf["cls"].notna()][["geometry", "cls"]]


def everett_overlay() -> gpd.GeoDataFrame | None:
    gdf = load_geojson("everett_bike_facilities.geojson")
    if gdf is None:
        return None
    gdf = gdf.copy()
    gdf["cls"] = gdf["TYPE"].map(config.EVERETT_FACILITY_CLASS)
    return gdf[gdf["cls"].notna()][["geometry", "cls"]]


def natick_overlay() -> gpd.GeoDataFrame | None:
    gdf = load_geojson("natick_bike_facilities.geojson")
    if gdf is None:
        return None
    gdf = gdf.copy()
    gdf["cls"] = gdf["Fac_Type"].map(config.NATICK_FACILITY_CLASS)
    return gdf[gdf["cls"].notna()][["geometry", "cls"]]


def salem_overlay() -> gpd.GeoDataFrame | None:
    gdf = load_geojson("salem_bike_facilities.geojson")
    if gdf is None:
        return None
    gdf = gdf.copy()
    gdf["cls"] = gdf["TYPE"].map(config.SALEM_FACILITY_CLASS)  # In-Design -> NaN -> dropped
    return gdf[gdf["cls"].notna()][["geometry", "cls"]]


def mapc_overlay() -> gpd.GeoDataFrame | None:
    """Regional existing-facility network; class carried in `mapc_cls`."""
    gdf = load_geojson("mapc_bike_network.geojson")
    if gdf is None or "mapc_cls" not in gdf:
        return None
    gdf = gdf.copy()
    gdf["cls"] = gdf["mapc_cls"]
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

# MassDOT LTS 3-4 on a street we think is calm: one step more stressful.
LTS_ESCALATION: Final[dict[str, str]] = {
    "quiet_street": "moderate_street",
    "moderate_street": "busy_street",
}

FOOT_FILTER: Final[str] = (
    '["highway"~"footway|pedestrian|path"]["bicycle"~"yes|designated|permissive"]'
)


# Public Overpass instances time out under load, and the graph download is the one
# fetch the whole refresh cannot proceed without. On 2026-08-17 a single connect
# timeout to overpass-api.de ended that week's refresh outright: no snapshot was
# published, the site kept serving data from the week before, and the only reason
# anyone noticed was the daily check on the live site's build date.
OVERPASS_MIRRORS: Final[list[str]] = [
    "https://overpass-api.de/api",
    "https://overpass.kumi.systems/api",
    "https://lz4.overpass-api.de/api",
]


def with_overpass_retry(what: str, fetch: Callable[[], nx.MultiDiGraph]) -> nx.MultiDiGraph:
    """Try each Overpass mirror, twice round, backing off between attempts.

    Two passes rather than one: a mirror that is briefly overloaded is often fine a
    minute later, and rotating away from all three permanently would trade a
    transient failure for a certain one.
    """
    last: Exception | None = None
    attempts = [(i, url) for i in range(2) for url in OVERPASS_MIRRORS]
    for attempt, (round_no, url) in enumerate(attempts):
        ox.settings.overpass_url = url
        try:
            return fetch()
        except Exception as exc:
            last = exc
            remaining = len(attempts) - attempt - 1
            print(f"  {what}: {url} failed ({type(exc).__name__}: {exc})")
            if remaining == 0:
                break
            pause = 10 * (round_no + 1)
            print(f"  retrying in {pause}s ({remaining} attempts left)")
            time.sleep(pause)
    raise RuntimeError(f"{what}: every Overpass mirror failed — last error: {last}")


def _coord_key(x: float, y: float) -> tuple[int, int]:
    """A node's position as an exact key: 1e-7 degrees is ~1 cm, and both sides
    of the comparison are the same OSM node's stored coordinates."""
    return (round(x * 1e7), round(y * 1e7))


def _metres(coords: list[tuple[float, float]]) -> float:
    total = 0.0
    for (x1, y1), (x2, y2) in itertools.pairwise(coords):
        total += float(ox.distance.great_circle(y1, x1, y2, x2))
    return total


def connect_midblock_junctions(graph: nx.MultiDiGraph, candidates: set[Any]) -> int:
    """Join paths that meet a road partway along one of its edges.

    The bike and footpath networks are downloaded and simplified separately,
    so an OSM node where a footpath meets a road mid-block is simplified out
    of the bike graph (to the road it is just a bend) while the footpath still
    ends on it. The two then touch without connecting: the path is a dead end
    0 m from the road it joins, and the router cannot turn onto it. Measured
    on the current graph: 3,024 such junctions, 796 of them where a path ends
    (the rest are paths crossing the road mid-block, joined to each other but
    not to the road they cross).

    `candidates` are the footpath nodes the bike graph did not have. Any that
    sits on a vertex inside a bike edge's geometry is where that edge is split,
    both directions, so the road passes through the junction node; the pieces
    keep the edge's attributes with their own geometry and length.

    This, rather than one simplify over both networks: the whole-area download
    is simplified by osmnx on arrival, and holding the unsimplified graph to
    simplify once would raise a peak that is already ~11 GB.
    """
    if not candidates:
        return 0
    at: dict[tuple[int, int], Any] = {}
    for n in candidates:
        nd = graph.nodes[n]
        at[_coord_key(float(nd["x"]), float(nd["y"]))] = n
    splits: list[tuple[Any, Any, Any, list[tuple[int, Any]]]] = []
    for u, v, k, d in graph.edges(keys=True, data=True):
        geom = d.get("geometry")
        if not isinstance(geom, LineString) or u in candidates or v in candidates:
            continue
        coords = list(geom.coords)
        cuts = [
            (i, at[key])
            for i in range(1, len(coords) - 1)
            if (key := _coord_key(coords[i][0], coords[i][1])) in at
        ]
        if cuts:
            splits.append((u, v, k, cuts))
    for u, v, k, cuts in splits:
        d = graph.edges[u, v, k]
        coords = [(float(x), float(y)) for x, y in d["geometry"].coords]
        ux, uy = float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"])
        if _coord_key(ux, uy) != _coord_key(*coords[0]) and _coord_key(
            ux, uy
        ) == _coord_key(*coords[-1]):
            coords.reverse()
            cuts = [(len(coords) - 1 - i, n) for i, n in reversed(cuts)]
        stops = [(0, u), *cuts, (len(coords) - 1, v)]
        graph.remove_edge(u, v, k)
        for (i, a), (j, b) in itertools.pairwise(stops):
            piece = coords[i : j + 1]
            attrs = dict(d)
            attrs["geometry"] = LineString(piece)
            attrs["length"] = _metres(piece)
            graph.add_edge(a, b, **attrs)
    return len(splits)


def acquire_osm(bbox: tuple[float, float, float, float]) -> nx.MultiDiGraph:
    """Whole-area bike network + bike-permitted footpaths.

    Chunking the graph build was explored and rejected: per-chunk simplify
    drops degree-2 nodes inconsistently at borders (leaving connectivity gaps),
    and merging raw chunks bloats the graph with un-mergeable boundary stubs.
    So this keeps the correct whole-area download but merges footpaths IN PLACE
    (bike attributes win, matching the old nx.compose(foot, bike)) rather than
    building a third full graph — that copy was pure transient overhead."""
    G: nx.MultiDiGraph = with_overpass_retry(
        "bike network",
        lambda: ox.graph_from_bbox(
            bbox, network_type="bike", simplify=True, truncate_by_edge=True
        ),
    )
    print(f"  bike graph: {len(G.nodes)} nodes, {len(G.edges)} edges")
    mem("after bike download")
    try:
        gf = with_overpass_retry(
            "footpaths",
            lambda: ox.graph_from_bbox(
                bbox,
                custom_filter=FOOT_FILTER,
                simplify=True,
                retain_all=True,
                truncate_by_edge=True,
            ),
        )
    except Exception as e:  # footpath layer optional
        print(f"  footpath layer failed ({e}) — bike graph only")
        return G
    # add only footpath nodes/edges the bike graph lacks (bike precedence)
    new_nodes = {n for n in gf.nodes if n not in G}
    G.add_nodes_from((n, d) for n, d in gf.nodes(data=True) if n in new_nodes)
    G.add_edges_from(
        (u, v, k, d) for u, v, k, d in gf.edges(keys=True, data=True) if not G.has_edge(u, v, k)
    )
    del gf
    joined = connect_midblock_junctions(G, new_nodes)
    print(f"  joined footpaths to {joined} road edges they meet mid-block")
    return G


def build() -> None:
    mem("start")
    print("downloading OSM (bike + footpaths) ...")
    G = acquire_osm(BBOX)
    print(f"  merged graph: {len(G.nodes)} nodes, {len(G.edges)} edges")
    print(f"  added {add_contraflow_edges(G)} contraflow edges (bikes both ways)")
    mem("after download+compose")
    nodes, edges = ox.graph_to_gdfs(G)
    edges = edges.to_crs(METRIC_CRS)
    mem("after graph_to_gdfs")

    # base classification from OSM tags
    records = edges.to_dict("records")
    base = [classify_osm(t) for t in records]
    edges["cls"] = [c for c, _ in base]
    edges["road_busy"] = [b for _, b in base]
    # the street's own class, without its facility: what paint is priced against
    edges["road_cls"] = [classify_road(t) for t in records]
    edges["rough"] = [rough_surface(t) for t in records]
    del records
    edges["is_pathlike"] = edges["cls"].isin(OFFSTREET)
    edges["source"] = "osm"
    edges["lts"] = 0

    # official overlays, in increasing precedence
    for name, overlay, radius in [
        ("massdot", massdot_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("mapc", mapc_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("cambridge", cambridge_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("boston", boston_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("newton", newton_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("everett", everett_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("natick", natick_overlay(), config.FACILITY_JOIN_RADIUS_M),
        ("salem", salem_overlay(), config.FACILITY_JOIN_RADIUS_M),
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
            # An official "shared-use path" says nothing about its surface, and
            # OSM saying "mud" does: it stays unpaved. (A track with no surface
            # tag is unpaved only by default, and an official path wins there.)
            if cur == "unpaved" and edges.iloc[i]["rough"]:
                continue
            new = safer(cur, cls)
            if new != cur:
                edges.iat[i, edges.columns.get_loc("cls")] = new
                edges.iat[i, edges.columns.get_loc("source")] = name
                upgraded += 1
        print(f"  upgraded {upgraded} edges")

    mem("after facility overlays")
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
                new = LTS_ESCALATION.get(cur)
                if new:
                    edges.iat[i, edges.columns.get_loc("cls")] = new
                    escalated += 1
                # and the street under any paint: a painted lane on a street
                # MassDOT rates LTS 3 must not be priced as a quiet street
                road = edges.iloc[i]["road_cls"]
                if road in LTS_ESCALATION:
                    edges.iat[i, edges.columns.get_loc("road_cls")] = LTS_ESCALATION[road]
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
                # an override is a person saying what the street is, all of it
                edges.iat[i, edges.columns.get_loc("road_cls")] = exploded.iloc[pos]["cls"]
                edges.iat[i, edges.columns.get_loc("source")] = "override"

    # crash density
    crash_frames: list[gpd.GeoDataFrame] = []
    for year in config.IMPACT_CRASH_YEARS:
        gdf = load_geojson(f"crashes_{year}.geojson")
        if gdf is not None:
            crash_frames.append(gdf[["geometry"]])
    edges["crash_count"] = 0
    crashes_joined = 0
    if crash_frames:
        crashes = pd.concat(crash_frames, ignore_index=True)
        # The number of crash RECORDS, not the sum of per-edge counts: a crash
        # within the join radius of six edge-directions contributes six to that
        # sum, so it read 35,331 for 4,050 crashes — a number that would be
        # quoted as if it were crashes.
        crashes_joined = len(crashes)
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

    mem("after crash join")
    triples = list(zip(edges["cls"], edges["road_cls"], edges["road_busy"], strict=True))
    edges["stress_mult"] = [
        facility_multiplier(
            c, r, bool(b), config.CLASS_MULTIPLIER,
            config.BUSY_ROAD_LANE_MULTIPLIER, config.BUSY_ROAD_BUFFERED_MULTIPLIER,
        )
        for c, r, b in triples
    ]
    edges["stress_mult_solo"] = [
        facility_multiplier(
            c, r, bool(b), config.SOLO_CLASS_MULTIPLIER,
            config.SOLO_BUSY_ROAD_LANE_MULTIPLIER, config.SOLO_BUSY_ROAD_BUFFERED_MULTIPLIER,
        )
        for c, r, b in triples
    ]
    del triples

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

    mem("after elevation sampling")
    # final weights (kids + solo), written back into the graph
    for (u, v, k), row in edges.iterrows():
        pen = 0.0
        if not (row["cls"] == "busy_street" or row["road_busy"]):
            pen = (node_penalty(u) + node_penalty(v)) / 2
        data = G.edges[u, v, k]
        data["climb"] = round(max(0.0, elev[v] - elev[u]), 2)
        data["xpen"] = round(pen, 1)
        data["road_busy"] = bool(row["road_busy"])
        # exact crash count, not just the derived factor: the where-to-build
        # report quotes counts to cities, and a capped factor can't be inverted
        # back into one (crash_factor saturates at CRASH_FACTOR_CAP)
        data["crash_count"] = int(row["crash_count"])
        data["cls"] = row["cls"]
        data["road_cls"] = row["road_cls"]
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

    mem("after weight write-back")
    # keep the largest strongly connected component so routing can't dead-end;
    # prune in place rather than .copy() the whole graph (that copy was a peak)
    scc = max(nx.strongly_connected_components(G), key=len)
    G.remove_nodes_from([n for n in G if n not in scc])
    mem("after SCC")
    print(f"final graph: {len(G.nodes)} nodes, {len(G.edges)} edges (largest SCC)")
    print("class distribution (m):")
    dist: Counter[str] = Counter()
    for _, _, d in G.edges(data=True):
        dist[d["cls"]] += d["length"]
    for cls, meters in sorted(dist.items(), key=lambda x: -x[1]):
        print(f"  {cls:16s} {meters/1000:8.1f} km")

    # What this graph carries, recorded on the graph itself. Downstream analyses
    # read edge attributes written above; a graph built by older code is missing
    # some of them, and every consumer so far discovered that by silently taking
    # a fallback path. priorities.py has spent weeks reporting "recorded bike
    # crashes nearby" instead of counts because it read a graph built before
    # crash_count existed, and nothing said so.
    G.graph["edge_schema"] = edge_schema(G)
    # Records joined, and separately how many edge-directions they landed on —
    # the second is only useful for spotting a join that silently matched nothing.
    G.graph["crashes_joined"] = crashes_joined
    G.graph["crash_edge_hits"] = int(edges["crash_count"].sum())
    G.graph["built_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    G.graph["data_format"] = config.DATA_FORMAT

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
