"""Where to build next: rank candidate bike-infrastructure projects.

The router answers "what is the safest way for us to get there". A city asks a
harder question: given a fixed budget, *where* does new protection do the most
good? This module answers it from the graph we already build.

The central idea is **severance**. Take only the streets a kid can actually use
(protection multiplier at or below `SAFE_MULT_MAX`) and the network falls apart
into islands: a quiet grid here, a path there, cut off from each other by a
few hundred metres of arterial. Those cut points are the cheapest wins, and
they are invisible on a coverage map — a lane-mileage overlay shows a
neighbourhood as well served right up to the moment you try to leave it.

The unit of output is a **corridor** — a contiguous run of one street at one
class — because that is what gets designed, funded and built. An edge is not a
project.

Scores are comparative, not absolute: they answer "which of these first", never
"how good is this". Every component is exported raw so the reader can disagree
with the weighting and re-sort.
"""

from __future__ import annotations

import csv
import datetime
import json
import math
import os
import pickle
import time
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

import config
import networkx as nx
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from shapely import STRtree
from shapely.geometry import MultiPolygon, Point, Polygon

# ---------------------------------------------------------------------------
# candidates
# ---------------------------------------------------------------------------


@dataclass
class Candidate:
    """One buildable thing: a run of street, or a single crossing."""

    pid: str
    name: str
    kind: str  # "corridor" | "spot_fix"
    cls: str
    length_m: float
    edges: list[tuple[int, int, int]] = field(default_factory=list)
    nodes: list[int] = field(default_factory=list)
    parts: list[list[tuple[float, float]]] = field(default_factory=list)
    crashes: int = 0
    crashes_known: bool = True
    signalized: bool = False
    crash_pressure: float = 0.0
    towns: list[str] = field(default_factory=list)

    # filled in by the analyses
    islands: list[int] = field(default_factory=list)
    small_island: int = -1  # the side a build would connect: the smaller of the two
    join_m: float = 0.0  # safe metres joined by building this
    join_names: list[str] = field(default_factory=list)
    # Whether the larger side is the region-wide network. If it is, its size is
    # not worth printing: "connects 1422.0 km and 96.5 km" states the total
    # kid-safe mileage of 76 towns, which tells a reader nothing and reads as an
    # error next to a city page's own 262 km.
    joins_region: bool = False
    gain_km: str = ""  # the side that gains, as words — not join_names[1]
    dest_unlocked: int = 0
    pop_gaining: float = 0.0
    resident_m_saved: float = 0.0
    # Whether the accessibility pass actually ran. Without it those three fields
    # are zero, and a zero in a column called "residents gaining access" reads as
    # "this project helps nobody" rather than "not measured yet".
    access_computed: bool = False
    # whether pop_gaining is people or a street-length proxy, so the sentence
    # this project prints can't imply a headcount that wasn't counted
    pop_is_headcount: bool = False
    score: float = 0.0
    components: dict[str, float] = field(default_factory=dict)
    group: str = ""
    group_size: int = 1

    @property
    def crashes_per_km(self) -> float:
        return self.crashes / max(self.length_m, 50.0) * 1000.0

    @property
    def crash_signal(self) -> float:
        """What the score uses. Exact counts per km when the graph carries them;
        otherwise the crash factor the router already applies, which says a
        street has a history without inventing a number for it."""
        return self.crashes_per_km if self.crashes_known else self.crash_pressure

    @property
    def coords(self) -> list[tuple[float, float]]:
        """Every vertex, for probing towns and picking a label point. Not a
        drawable line — see `parts`."""
        return [pt for part in self.parts for pt in part]

    @property
    def cost_proxy(self) -> float:
        if self.kind == "spot_fix":
            return config.UNIT_COST_PER_M["spot_fix"]
        return self.length_m * config.UNIT_COST_PER_M[config.UPGRADE_CLASS]


def is_kid_safe(data: dict[str, Any]) -> bool:
    """Whether a kid can be sent along this edge unaccompanied by an adult's nerve."""
    return float(data.get("stress_mult", 99.0)) <= config.SAFE_MULT_MAX


def edge_coords(graph: nx.MultiDiGraph, u: int, v: int, data: dict[str, Any]) -> list[
    tuple[float, float]
]:
    geom = data.get("geometry")
    if geom is not None:
        return [(float(x), float(y)) for x, y in geom.coords]
    return [
        (float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"])),
        (float(graph.nodes[v]["x"]), float(graph.nodes[v]["y"])),
    ]


def safe_islands(graph: nx.MultiDiGraph) -> tuple[dict[int, int], dict[int, float]]:
    """Connected components of the kid-safe subgraph.

    Returns (node -> island id, island id -> safe metres). Undirected: a
    one-way protected lane still connects the two ends of a neighbourhood for
    this purpose, and one-way pairs would otherwise split into separate islands.
    """
    safe = nx.Graph()
    safe.add_nodes_from(graph.nodes)
    for u, v, data in graph.edges(data=True):
        if is_kid_safe(data):
            length = float(data["length"])
            if safe.has_edge(u, v):
                safe[u][v]["length"] = min(safe[u][v]["length"], length)
            else:
                safe.add_edge(u, v, length=length)

    island_of: dict[int, int] = {}
    island_m: dict[int, float] = {}
    for iid, comp in enumerate(nx.connected_components(safe)):
        sub = safe.subgraph(comp)
        metres = sum(float(d["length"]) for _, _, d in sub.edges(data=True))
        if metres <= 0:
            # a node with no kid-safe edge at all. Counting these as islands
            # inflated the headline: 44,643 "islands" was really 34,734, with
            # 9,909 bare junctions padding it out.
            continue
        for n in comp:
            island_of[n] = iid
        island_m[iid] = metres
    return island_of, island_m


def _street_key(data: dict[str, Any]) -> tuple[str, str]:
    name = data.get("name")
    if isinstance(name, list):
        name = name[0] if name else ""
    if not isinstance(name, str):
        name = ""
    return (name, str(data.get("cls", "")))


def find_candidates(graph: nx.MultiDiGraph) -> list[Candidate]:
    """Unsafe streets, grouped into corridors by (name, class) connectivity.

    Two runs of Beacon St separated by a protected stretch are two candidates,
    not one — they are separate projects, and merging them would inflate both
    the cost and the claimed benefit.
    """
    # Group by street identity, then split each group into connected runs.
    # Deduplicated on (endpoints, key) so the two directions of a two-way street
    # count once, while two parallel ways between the same junctions both count —
    # an earlier simple-Graph pass collapsed those into one and lost their length.
    seen: set[tuple[int, int, int]] = set()
    by_street: defaultdict[tuple[str, str], list[tuple[int, int, int]]] = defaultdict(list)
    for u, v, k, data in graph.edges(keys=True, data=True):
        if is_kid_safe(data):
            continue
        eid = (min(u, v), max(u, v), k)
        if eid in seen:
            continue
        seen.add(eid)
        by_street[_street_key(data)].append((u, v, k))

    candidates: list[Candidate] = []
    for (name, cls), edges in sorted(by_street.items()):
        run = nx.MultiGraph()
        for u, v, k in edges:
            run.add_edge(u, v, key=(u, v, k))
        for comp in nx.connected_components(run):
            sub = run.subgraph(comp)
            length = 0.0
            crashes = 0
            crashes_known = True
            pressure = 0.0
            parts: list[list[tuple[float, float]]] = []
            members: list[tuple[int, int, int]] = []
            for _a, _b, key in sub.edges(keys=True):
                u, v, k = key
                data = graph.get_edge_data(u, v, k)
                if data is None:
                    continue
                seg_m = float(data["length"])
                length += seg_m
                if "crash_count" in data:
                    crashes += int(data["crash_count"])
                else:
                    crashes_known = False
                # length-weighted mean of the factor the router already applies
                pressure += (float(data.get("crash_factor", 1.0)) - 1.0) * seg_m
                members.append((u, v, k))
                # one part per edge: the edges of a corridor come out of the
                # graph in arbitrary order, so concatenating them into a single
                # LineString drew a zig-zag between disjoint pieces
                parts.append(edge_coords(graph, u, v, data))
            if not members:
                continue
            # The lower bound is applied after severance scoring, not here: a
            # 12 m link between two islands is the cheapest real project there
            # is, and this filter was throwing exactly those away unmeasured.
            if length < config.CROSSING_MIN_M or length > config.CANDIDATE_MAX_M:
                continue
            candidates.append(
                Candidate(
                    pid=f"c{len(candidates):05d}",
                    name=name or "unnamed street",
                    kind="corridor",
                    cls=cls,
                    length_m=round(length, 1),
                    edges=members,
                    nodes=sorted(comp),
                    parts=parts,
                    crashes=crashes,
                    crashes_known=crashes_known,
                    signalized=any(
                        graph.nodes[n].get("highway") == "traffic_signals"
                        or graph.nodes[n].get("crossing") == "traffic_signals"
                        for n in comp
                    ),
                    crash_pressure=round(pressure / max(length, 1.0), 4),
                )
            )
    return candidates


def score_severance(
    candidates: list[Candidate],
    island_of: dict[int, int],
    island_m: dict[int, float],
) -> None:
    """How much kid-safe network each candidate would join together.

    The gain is the *smaller* of the two largest islands it touches, not their
    sum. Summing was the first thing tried and it ranked nothing: the region has
    one 1,422 km island, so every candidate that grazed it claimed 1,422 km,
    2,588 projects tied at the same score, and a 39 m stub outranked a real
    missing link. Connecting a stub to a continent unlocks the stub — the
    marginal gain is what was previously unreachable, which is the min.
    """
    biggest = max(island_m, key=lambda i: island_m[i], default=-1)
    for cand in candidates:
        seen: dict[int, float] = {}
        for n in cand.nodes:
            iid = island_of.get(n)
            if iid is None:
                continue
            seen[iid] = island_m.get(iid, 0.0)
        # islands worth naming: ignore stubs (a single driveway is not a network)
        real = sorted(
            ((iid, m) for iid, m in seen.items() if m >= 200.0),
            key=lambda kv: kv[1],
            reverse=True,
        )
        cand.islands = [iid for iid, _ in real]
        if len(real) >= 2:
            cand.small_island = min(real[0], real[1], key=lambda kv: kv[1])[0]
            cand.join_m = round(min(real[0][1], real[1][1]), 1)
            big, small = max(real[0], real[1], key=lambda kv: kv[1]), min(
                real[0], real[1], key=lambda kv: kv[1]
            )
            # named explicitly rather than by position: the sentence depends on
            # which side gains, and reading that off real[0]/real[1] silently
            # inverts the claim the day the sort order changes
            cand.join_names = [miles(big[1]), miles(small[1])]
            cand.gain_km = miles(small[1])
            cand.joins_region = big[0] == biggest
        else:
            cand.join_m = 0.0


def _ring_bbox(ring: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return (min(xs), min(ys), max(xs), max(ys))


def classify_and_prune(candidates: list[Candidate]) -> list[Candidate]:
    """Split spot fixes out from corridors, and drop the short noise.

    A short hostile link between two kid-safe islands isn't a corridor project.
    It's one location — a signal, a beacon, a protected crossing, a few metres of
    separation — and often the thing a city can actually do this year.

    It is not called a crossing. That would assert a treatment this geometry
    can't support: a 39 m segment carrying the arterial's own name means riding
    39 m *along* the arterial, not across it. What the data supports is that the
    link is short, hostile, and load-bearing; which of those treatments fits is a
    designer's call.

    Short links that join nothing are what the length floor was for: driveway
    stubs and kerb cuts.
    """
    kept: list[Candidate] = []
    spot_fixes = 0
    dropped = 0
    for cand in candidates:
        joins = cand.join_m > 0
        if cand.length_m < config.CANDIDATE_MIN_M and not joins:
            dropped += 1
            continue
        if joins and cand.length_m <= config.SPOT_FIX_MAX_M and not cand.signalized:
            cand.kind = "spot_fix"
            spot_fixes += 1
        kept.append(cand)
    print(
        f"  {spot_fixes} of them are spot fixes (one location, not a corridor); "
        f"dropped {dropped} short links that join nothing"
    )
    return kept


def load_towns() -> list[tuple[str, list[list[tuple[float, float]]]]]:
    """Town polygons as (name, rings). Empty when the source wasn't fetched."""
    path = config.RAW_DIR / "towns.geojson"
    if not path.exists():
        return []
    fc = json.loads(path.read_text())
    out: list[tuple[str, list[list[tuple[float, float]]]]] = []
    for feat in fc.get("features", []):
        town = str(feat.get("properties", {}).get("town", "")).strip()
        geom = feat.get("geometry") or {}
        polys: list[Any]
        if geom.get("type") == "Polygon":
            polys = [geom["coordinates"]]
        elif geom.get("type") == "MultiPolygon":
            polys = geom["coordinates"]
        else:
            continue
        rings = [[(float(x), float(y)) for x, y in poly[0]] for poly in polys if poly]
        if town and rings:
            out.append((town, rings))
    return out


def _in_ring(pt: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    """Ray casting. Only outer rings are tested — a project inside a town's
    lake or enclave is still in that town for reporting purposes."""
    x, y = pt
    inside = False
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
            if x < xi:
                inside = not inside
    return inside


def assign_towns(
    candidates: list[Candidate],
    towns: list[tuple[str, list[list[tuple[float, float]]]]],
) -> None:
    """Tag each candidate with the town(s) its midpoint and ends fall in."""
    if not towns:
        return
    # bbox per ring first: 5,675 candidates x 137 towns x every ring vertex is
    # the slowest thing here, and a bbox rejects nearly all of it
    boxed = [
        (town, [(ring, _ring_bbox(ring)) for ring in rings])
        for town, rings in towns
    ]
    for cand in candidates:
        coords = cand.coords
        if not coords:
            continue
        probes = [coords[0], coords[len(coords) // 2], coords[-1]]
        found: list[str] = []
        for probe in probes:
            x, y = probe
            for town, rings in boxed:
                if town in found:
                    continue
                for ring, (x0, y0, x1, y1) in rings:
                    if x0 <= x <= x1 and y0 <= y <= y1 and _in_ring(probe, ring):
                        found.append(town)
                        break
        cand.towns = found


def normalise(values: list[float]) -> list[float]:
    """Scale to 0..1 on a log curve, strictly monotone.

    Two earlier attempts both destroyed the ranking, in opposite directions.
    Dividing by a percentile and clamping tied the top 5% at 1.0 — on real data
    that was 284 projects sharing one score, so the list didn't rank where
    ranking matters most. A plain percentile index also truncates to the
    *minimum* on short lists, which zeroed every project in a small town.

    A log curve fixes both: the tail can't flatten the field (a 500:1 outlier
    compresses to about 2.5:1) and distinct inputs always give distinct outputs,
    so ties in the output mean ties in the evidence.
    """
    if not values:
        return []
    top = max(values)
    if top <= 0:
        return [0.0 for _ in values]
    scale = math.log1p(top)
    return [math.log1p(max(0.0, v)) / scale for v in values]


def group_alternatives(candidates: list[Candidate]) -> None:
    """Tag candidates that are different ways to cross the same gap.

    A divided arterial, or one street split by an intersection node, produces
    two 68 m candidates with identical descriptions — they crossed the same
    barrier between the same two islands. They are alternatives, not two
    independent wins, and two identical-looking rows at the top of a ranked list
    is the fastest way to lose a reader's trust. They stay listed separately
    (they are separate builds, and a city may prefer one), but carry a group so
    the report can collapse them.

    Not merged into one project: summing their lengths would bill both and claim
    the connection twice.
    """
    groups: defaultdict[str, list[Candidate]] = defaultdict(list)
    for cand in candidates:
        if len(cand.islands) < 2:
            # Nothing to be an alternative *to*: with no island pair, every
            # same-named candidate would have grouped together and reported
            # unrelated streets in different towns as each other's options.
            cand.group = cand.pid
        else:
            pair = "-".join(str(i) for i in sorted(cand.islands[:2]))
            cand.group = f"{cand.name}|{cand.cls}|{pair}"
        groups[cand.group].append(cand)
    for members in groups.values():
        for cand in members:
            cand.group_size = len(members)


def score_all(candidates: list[Candidate]) -> None:
    """Composite score from the components each analysis filled in."""
    w = config.PRIORITY_WEIGHTS
    sever = normalise([c.join_m / max(c.length_m, 25.0) for c in candidates])
    crash = normalise([c.crash_signal for c in candidates])
    access = normalise([c.resident_m_saved for c in candidates])
    coverage = normalise([c.pop_gaining for c in candidates])
    for cand, sv, cr, ac, cv in zip(candidates, sever, crash, access, coverage, strict=True):
        cand.components = {
            "severance": round(sv, 4),
            "crash": round(cr, 4),
            "access": round(ac, 4),
            "coverage": round(cv, 4),
        }
        cand.score = round(
            w["severance"] * sv + w["crash"] * cr + w["access"] * ac + w["coverage"] * cv,
            4,
        )


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------


# What the street is today, in words a council meeting would use.
CLASS_WORDS: dict[str, str] = {
    "busy_street": "no bike facility on a busy road",
    "moderate_street": "no bike facility",
    "sharrow": "shared-lane markings only",
    "lane": "a painted bike lane",
    "buffered": "a buffered lane",
    "service": "a service road",
    "quiet_street": "a quiet street",
    "separated": "a separated lane",
    "path": "an off-street path",
}


MI_PER_M = 1 / 1609.344


def miles(m: float) -> str:
    """A distance as an American reader expects it.

    These sentences are read by residents and city staff in Massachusetts and
    end up on a printed one-pager, so they are written in miles and feet. The
    app's own numbers follow a preference the rider sets; this prose can't,
    because it is generated once and shipped as data — a trade made knowingly,
    since the audience is the same either way.
    """
    ft = m * 3.280839895
    # feet up to 1000, then miles: a 180 m block is "590 ft" to a reader and
    # "0.1 mi" to nobody
    return f"{round(ft):,.0f} ft" if ft < 1000 else f"{m * MI_PER_M:.1f} mi"


def summary_sentence(cand: Candidate) -> str:
    """The project in words. Everything here traces to an exported field —
    nothing is rounded up into a claim the numbers don't support."""
    bits: list[str] = []
    where = f"{miles(cand.length_m)} of {cand.name}"
    if cand.towns:
        where += f" ({', '.join(cand.towns)})"
    today = CLASS_WORDS.get(cand.cls, cand.cls.replace("_", " "))
    if cand.kind == "spot_fix":
        # says where and how big, and leaves the treatment to a designer
        spot = f"a spot fix on {cand.name}"
        if cand.towns:
            spot += f" ({', '.join(cand.towns)})"
        bits.append(f"{spot} — {miles(cand.length_m)} of it, today {today}")
    else:
        bits.append(f"{where} — today {today}")
    if cand.join_m > 0:
        # gain_km in the guard, not just in the sentence: the three fields are
        # independent attributes with nothing tying them together, and a
        # candidate with joins_region set but no gain_km rendered "connects  of
        # kid-safe streets to the region-wide network" — a public claim with a
        # hole in it, where reading join_names[1] at least raised IndexError.
        # Name the side that gains, then what it joins. "connects 486.3 km and
        # 18.7 km" makes the reader work out which number is the point, and puts
        # a network's region-wide extent beside a city page's own figure for the
        # same streets — the confusion the 1,422 km wording had, one level down.
        if cand.joins_region and cand.gain_km:
            # name the side that actually gains. The other side is every
            # kid-safe street in the region, and printing its mileage next to a
            # city's own read like a typo for the city's figure.
            bits.append(
                f"connects {cand.gain_km} of kid-safe streets to the region-wide network"
            )
        elif cand.gain_km and cand.join_names:
            bits.append(
                f"connects {cand.gain_km} of kid-safe streets"
                f" to a {cand.join_names[0]} network"
            )
        else:
            bits.append(f"unlocks {miles(cand.join_m)} of kid-safe streets")
    if cand.access_computed and (cand.dest_unlocked or cand.pop_gaining > 0):
        reach: list[str] = []
        if cand.dest_unlocked:
            thing = "school, playground or library" if cand.dest_unlocked == 1 else (
                "schools, playgrounds and libraries"
            )
            # "reaches 35 schools" was the first wording and it overclaimed: the
            # 35 are what sits on the network being joined, most already
            # reachable by the people already on it. What the project does is
            # open that network to the other side.
            reach.append(f"opens a network with {cand.dest_unlocked} {thing} on it")
        if cand.pop_gaining > 0 and cand.pop_is_headcount:
            # this one is measured directly: people who cross from "nothing in
            # reach" to "in reach" when the corridor is rebuilt
            reach.append(f"about {cand.pop_gaining:,.0f} residents gain a safe route")
        elif cand.pop_gaining > 0:
            reach.append("more homes gain a safe route")
        if reach:
            bits.append("; ".join(reach))
    if cand.crashes_known and cand.crashes:
        plural = "es" if cand.crashes != 1 else ""
        bits.append(f"{cand.crashes} bike crash{plural} since 2021")
    elif not cand.crashes_known and cand.crash_pressure > 0:
        # an older graph build carries only the capped factor, which cannot be
        # inverted into a count — say there is a history, don't invent a number
        bits.append("recorded bike crashes nearby")
    return "; ".join(bits)


def to_geojson(candidates: list[Candidate]) -> dict[str, Any]:
    feats: list[dict[str, Any]] = []
    for cand in candidates:
        feats.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "MultiLineString",
                    "coordinates": [
                        [[round(x, 6), round(y, 6)] for x, y in part]
                        for part in cand.parts
                    ],
                },
                "properties": {
                    "pid": cand.pid,
                    "name": cand.name,
                    "kind": cand.kind,
                    "cls": cand.cls,
                    "towns": ", ".join(cand.towns),
                    "length_m": cand.length_m,
                    "crashes": cand.crashes if cand.crashes_known else None,
                    "crashes_per_km": (
                        round(cand.crashes_per_km, 2) if cand.crashes_known else None
                    ),
                    "crash_pressure": cand.crash_pressure,
                    "join_m": cand.join_m,
                    # Which network the far side is. Without it the web page can
                    # say only "the network on the other side of this gap": it
                    # cannot tell a link into the region-wide network from one
                    # between two local pockets, and guessing from join_m would
                    # credit local joins with a region-wide claim.
                    "joins_region": cand.joins_region,
                    "dest_unlocked": cand.dest_unlocked if cand.access_computed else None,
                    "pop_gaining": (
                        round(cand.pop_gaining, 1) if cand.access_computed else None
                    ),
                    "resident_m_saved": (
                        round(cand.resident_m_saved, 1) if cand.access_computed else None
                    ),
                    "cost_proxy": round(cand.cost_proxy),
                    "score": cand.score,
                    "group": cand.group,
                    "group_size": cand.group_size,
                    "summary": summary_sentence(cand),
                    **{f"c_{k}": v for k, v in cand.components.items()},
                },
            }
        )
    return {"type": "FeatureCollection", "features": feats}


CSV_COLUMNS = (
    "rank", "pid", "name", "towns", "kind", "current_class", "length_m",
    "score", "join_m", "crashes", "crashes_per_km", "dest_unlocked",
    "pop_gaining", "resident_m_saved", "cost_proxy_usd", "alternatives", "summary",
)


def write_csv(path: Any, candidates: list[Candidate]) -> None:
    with open(path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(CSV_COLUMNS)
        for rank, cand in enumerate(candidates, start=1):
            writer.writerow(
                [
                    rank, cand.pid, cand.name, ", ".join(cand.towns) or "-", cand.kind,
                    cand.cls, f"{cand.length_m:.0f}", f"{cand.score:.4f}",
                    f"{cand.join_m:.0f}",
                    cand.crashes if cand.crashes_known else "",
                    f"{cand.crashes_per_km:.2f}" if cand.crashes_known else "",
                    cand.dest_unlocked if cand.access_computed else "",
                    f"{cand.pop_gaining:.0f}" if cand.access_computed else "",
                    f"{cand.resident_m_saved:.0f}" if cand.access_computed else "",
                    f"{cand.cost_proxy:.0f}",
                    cand.group_size,
                    summary_sentence(cand),
                ]
            )


# Edge attributes this analysis reads. A graph without them is not a graph this
# can measure — see require_usable_graph().
NEEDED_EDGE_ATTRS: Final[frozenset[str]] = frozenset(
    {"length", "cls", "stress_mult", "crash_factor", "crash_count"}
)


def require_usable_graph(graph: nx.MultiDiGraph) -> None:
    """Refuse a graph built before the attributes this analysis reads existed.

    This is the check that was missing. graph.pkl carried every attribute except
    crash_count, because it was built before that write-back landed; the analysis
    ran happily, took its honest "we don't know the counts" fallback on all 5,685
    candidates, and published a ranking with one of its four criteria resting on a
    derived proxy. A fallback for missing *data* is right. Silently using it for
    missing *code* output is not, so this fails loudly instead.
    """
    stamped = graph.graph.get("edge_schema")
    missing: set[str]
    if stamped is not None:
        missing = set(NEEDED_EDGE_ATTRS) - set(stamped)
    else:
        # An older graph carries no stamp, so ask the edges. Intersecting across a
        # sample rather than checking one edge: an attribute absent everywhere is
        # a stale graph, while one absent from a single odd edge is not.
        missing = set(NEEDED_EDGE_ATTRS)
        for _u, _v, data in list(graph.edges(data=True))[:200]:
            missing &= set(NEEDED_EDGE_ATTRS) - set(data)
            if not missing:
                break
    if missing:
        raise SystemExit(
            "graph.pkl is missing edge attributes this analysis reads: "
            f"{', '.join(sorted(missing))}. It was built by an older "
            "build_graph.py — re-run `python build_graph.py` before this. "
            "(Refusing rather than falling back: the fallback is for data the "
            "sources didn't have, not for a stale graph.)"
        )


def build(limit: int | None = None) -> list[Candidate]:
    """Run the analysis over the built graph and write the outputs."""
    with open(config.DATA_DIR / "graph.pkl", "rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    require_usable_graph(graph)
    print(f"graph: {len(graph.nodes)} nodes, {len(graph.edges)} edges")

    island_of, island_m = safe_islands(graph)
    big = sorted(island_m.values(), reverse=True)[:5]
    substantial = sum(1 for m in island_m.values() if m >= 200)
    print(
        f"kid-safe islands: {len(island_m)} ({substantial} of 200 m or more) "
        f"(largest: {', '.join(miles(m) for m in big)})"
    )

    candidates = find_candidates(graph)
    print(f"candidates: {len(candidates)} unsafe corridors within length bounds")

    score_severance(candidates, island_of, island_m)
    joined = sum(1 for c in candidates if c.join_m > 0)
    print(f"  {joined} of them would join two or more kid-safe islands")
    candidates = classify_and_prune(candidates)

    assign_towns(candidates, load_towns())
    group_alternatives(candidates)

    # accessibility: what each candidate would put in reach, and for whom
    net = Network(graph)
    pop, pop_is_real = node_population(graph, net)
    if not pop_is_real:
        print(
            "  no census layer — weighting by residential street length instead; "
            "resident counts are reported as a proxy, not as people"
        )
    destinations = destination_nodes(graph, net)
    print(
        f"  {len(destinations)} destinations (schools, playgrounds, libraries), "
        f"{pop.sum():,.0f} {'residents' if pop_is_real else 'proxy weight'} on the network"
    )
    started = time.monotonic()
    before = score_accessibility(
        graph, candidates, net, pop, destinations, island_of, pop_is_real
    )
    print(
        f"  measured all {len(candidates)} candidates in "
        f"{time.monotonic() - started:.0f}s (no screening needed)"
    )
    stranded = float(np.sum(pop[before >= config.ACCESS_BUDGET_M]))
    stranded_pct = 100 * stranded / max(float(pop.sum()), 1.0)
    print(
        f"  today {stranded:,.0f} of {pop.sum():,.0f} ({stranded_pct:.0f}%) have no "
        f"school, playground or library within {miles(config.ACCESS_BUDGET_M)} of "
        "perceived distance (unsafe streets are priced in, not banned)"
    )

    score_all(candidates)
    candidates.sort(key=lambda c: c.score, reverse=True)
    if limit is not None:
        candidates = candidates[:limit]

    # web/data, not data/: that is what publish-data.sh tars into the release
    # asset the site and the APK both extract. Writing to data/ would have left
    # the app's layer with nothing to load in production.
    out_dir = config.DATA_DIR.parent / "web" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    export_coverage(graph, net, pop, before, pop_is_real, out_dir)
    write_csv(out_dir / "priorities.csv", candidates)
    # The map layer carries a slice: all 5,670 candidates came to ~7 MB, heavier
    # than the display network the app loads by viewport. The CSV keeps every one.
    shown = select_for_map(candidates)
    (out_dir / "priorities.geojson").write_text(
        json.dumps(to_geojson(shown), separators=(",", ":"), allow_nan=False)
    )
    export_spot_fixes(out_dir, shown)
    write_meta(out_dir, candidates, shown_count=len(shown), islands=island_m,
               destinations=len(destinations), pop=pop, pop_is_real=pop_is_real,
               stranded=stranded, stranded_pct=stranded_pct,
               graph_meta=graph.graph)
    dropped = len(candidates) - len(shown)
    print(
        f"wrote priorities.csv ({len(candidates)} projects) and "
        f"priorities.geojson (top {len(shown)}"
        + (f"; {dropped} lower-scoring left to the CSV)" if dropped else ")")
    )
    seen_groups: set[str] = set()
    shown_top = 0
    for cand in candidates:
        if cand.group in seen_groups:
            continue
        seen_groups.add(cand.group)
        alts = f" (+{cand.group_size - 1} alt)" if cand.group_size > 1 else ""
        print(f"  {cand.score:.3f}  {summary_sentence(cand)}{alts}")
        shown_top += 1
        if shown_top == 10:
            break
    return candidates




# ---------------------------------------------------------------------------
# accessibility: what a project would put in reach, and for whom
#
# One multi-source Dijkstra from every destination, on the transposed graph,
# gives each node its perceived cost to the *nearest* school, playground or
# library. That single array answers two of the four criteria: how much closer a
# project brings people to somewhere worth going, and how many people can't
# reach anywhere at all today.
# ---------------------------------------------------------------------------


class Network:
    """The graph as a sparse matrix, with the bookkeeping to re-cost one
    corridor at a time and put it back."""

    def __init__(self, graph: nx.MultiDiGraph) -> None:
        self.index: dict[int, int] = {n: i for i, n in enumerate(graph.nodes)}
        # Parallel arcs collapse to the cheapest: for a shortest path only the
        # best one can ever matter, and coo->csr would otherwise SUM them.
        best: dict[tuple[int, int], float] = {}
        for u, v, data in graph.edges(data=True):
            key = (self.index[u], self.index[v])
            w = float(data["weight"])
            if key not in best or w < best[key]:
                best[key] = w
        n = len(self.index)
        rows = np.fromiter((k[0] for k in best), dtype=np.int32, count=len(best))
        cols = np.fromiter((k[1] for k in best), dtype=np.int32, count=len(best))
        data_arr = np.fromiter(best.values(), dtype=np.float64, count=len(best))
        # transposed: distance FROM every node TO the nearest source
        self.matrix = coo_matrix((data_arr, (cols, rows)), shape=(n, n)).tocsr()
        # where each arc's weight lives in the CSR data array, so a candidate can
        # be re-costed in place instead of rebuilding a 887k-arc matrix each time
        indptr = self.matrix.indptr
        starts = np.repeat(np.arange(n, dtype=np.int32), np.diff(indptr))
        self.pos: dict[tuple[int, int], int] = {
            (int(a), int(b)): i
            for i, (a, b) in enumerate(zip(starts, self.matrix.indices, strict=True))
        }

    def node_count(self) -> int:
        return len(self.index)

    def cost_to_nearest(self, sources: list[int]) -> np.ndarray:
        """Perceived metres from every node to its nearest source."""
        if not sources:
            return np.full(self.node_count(), np.inf)
        result: np.ndarray = dijkstra(
            self.matrix, indices=np.asarray(sources, dtype=np.int32), min_only=True
        )
        return result

    def apply_weights(self, weights: dict[int, float]) -> dict[int, float]:
        """Set arc weights in place, returning the old ones to restore with.

        In place because the alternative is rebuilding an 887k-arc matrix per
        candidate, which costs more than the search it feeds.
        """
        previous = {slot: float(self.matrix.data[slot]) for slot in weights}
        for slot, weight in weights.items():
            self.matrix.data[slot] = weight
        return previous


def upgraded_weights(
    graph: nx.MultiDiGraph, net: Network, cand: Candidate
) -> dict[int, float]:
    """What the candidate's arcs would cost once built.

    Modelled as the target class's multiplier on its true length, dropping the
    crash factor and the crossing penalty — those are what the build addresses,
    and carrying them would credit a protected lane with the danger it removes.
    """
    mult = config.CLASS_MULTIPLIER[config.UPGRADE_CLASS]
    out: dict[int, float] = {}
    for u, v, k in cand.edges:
        data = graph.get_edge_data(u, v, k)
        if data is None:
            continue
        weight = float(data["length"]) * mult
        iu, iv = net.index.get(u), net.index.get(v)
        if iu is None or iv is None:
            continue
        for key in ((iv, iu), (iu, iv)):
            slot = net.pos.get(key)
            if slot is not None:
                out[slot] = weight
    return out


def load_population() -> list[tuple[int, Any]]:
    """Census block groups as (people, shapely polygon). Empty when unfetched."""
    path = config.RAW_DIR / "population.geojson"
    if not path.exists():
        return []
    fc = json.loads(path.read_text())
    out: list[tuple[int, Any]] = []
    for feat in fc.get("features", []):
        pop = int(feat.get("properties", {}).get("pop", 0) or 0)
        geom = feat.get("geometry") or {}
        if geom.get("type") != "MultiPolygon":
            continue
        polys = [
            Polygon(ring[0])
            for ring in geom.get("coordinates", [])
            if ring and len(ring[0]) >= 4
        ]
        if not polys:
            continue
        shape = polys[0] if len(polys) == 1 else MultiPolygon(polys)
        out.append((pop, shape))
    return out


def node_population(graph: nx.MultiDiGraph, net: Network) -> tuple[np.ndarray, bool]:
    """People per graph node, and whether it is real census data.

    A block group's residents are spread over the nodes inside it rather than
    dropped at its centroid: a centroid can easily land on the far side of the
    very arterial whose severance we are measuring, which would credit or blame
    the wrong project.

    Falls back to residential street length when the census layer is missing —
    the same shape of answer, but a proxy, and the caller relabels every output
    that says "residents" so nothing claims to have counted people it didn't.
    """
    weights = np.zeros(net.node_count(), dtype=np.float64)
    blocks = load_population()
    if not blocks:
        # deduplicated: a two-way street is two directed edges, and counting
        # both doubled every proxy weight
        seen: set[tuple[int, int, int]] = set()
        for u, v, k, data in graph.edges(keys=True, data=True):
            if not is_kid_safe(data):
                continue
            eid = (min(u, v), max(u, v), k)
            if eid in seen:
                continue
            seen.add(eid)
            half = float(data["length"]) / 2.0
            for n in (u, v):
                i = net.index.get(n)
                if i is not None:
                    weights[i] += half
        return weights, False

    node_ids = list(graph.nodes)
    points = [Point(float(graph.nodes[n]["x"]), float(graph.nodes[n]["y"])) for n in node_ids]
    tree = STRtree(points)
    unplaced = 0
    for pop, shape in blocks:
        if pop <= 0:
            continue
        inside = tree.query(shape, predicate="covers")
        if len(inside) == 0:
            # a block group with no street node in it (water, or a sparse
            # boundary sliver): give its people to the closest node rather than
            # dropping them from the analysis
            nearest = tree.nearest(shape.centroid)
            if nearest is None:
                unplaced += pop
                continue
            inside = np.asarray([nearest])
        share = pop / len(inside)
        for j in inside:
            i = net.index.get(node_ids[int(j)])
            if i is not None:
                weights[i] += share
    if unplaced:
        print(f"  warning: {unplaced} residents could not be placed on the network")
    return weights, True


def destination_nodes(graph: nx.MultiDiGraph, net: Network) -> list[int]:
    """Graph nodes nearest to each school, playground and library."""
    path = config.RAW_DIR / "pois.geojson"
    if not path.exists():
        return []
    fc = json.loads(path.read_text())
    node_ids = list(graph.nodes)
    points = [Point(float(graph.nodes[n]["x"]), float(graph.nodes[n]["y"])) for n in node_ids]
    tree = STRtree(points)
    out: set[int] = set()
    for feat in fc.get("features", []):
        if feat.get("properties", {}).get("kind") not in config.DESTINATION_KINDS:
            continue
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates")
        if geom.get("type") != "Point" or not coords:
            continue
        j = tree.nearest(Point(float(coords[0]), float(coords[1])))
        if j is None:
            continue
        i = net.index.get(node_ids[int(j)])
        if i is not None:
            out.add(i)
    return sorted(out)


def score_accessibility(
    graph: nx.MultiDiGraph,
    candidates: list[Candidate],
    net: Network,
    pop: np.ndarray,
    destinations: list[int],
    island_of: dict[int, int],
    pop_is_real: bool = False,
) -> np.ndarray:
    """Measure every candidate against the network as it stands.

    Returns the baseline cost-to-nearest-destination array, which the coverage
    layer reuses. Each candidate gets:

      resident_m_saved  people x perceived metres they'd save reaching somewhere
      pop_gaining       people who cross from "nowhere in reach" to "in reach"
      dest_unlocked     destinations sitting in the smaller island it connects
    """
    budget = config.ACCESS_BUDGET_M
    clamp = budget * config.ACCESS_CLAMP_MULT
    before = np.minimum(net.cost_to_nearest(destinations), clamp)
    was_stranded = before >= budget

    # destinations per island, for "what does connecting this side reach"
    dest_per_island: defaultdict[int, int] = defaultdict(int)
    reverse = {i: n for n, i in net.index.items()}
    for d in destinations:
        iid = island_of.get(reverse[d])
        if iid is not None:
            dest_per_island[iid] += 1

    for cand in candidates:
        upgrade = upgraded_weights(graph, net, cand)
        if not upgrade:
            continue
        previous = net.apply_weights(upgrade)
        after = np.minimum(net.cost_to_nearest(destinations), clamp)
        net.apply_weights(previous)

        saved = np.maximum(before - after, 0.0)
        cand.resident_m_saved = float(np.dot(pop, saved))
        cand.pop_gaining = float(np.sum(pop[was_stranded & (after < budget)]))
        if cand.small_island >= 0:
            cand.dest_unlocked = dest_per_island.get(cand.small_island, 0)
        cand.access_computed = True
        cand.pop_is_headcount = pop_is_real
    return before


def export_coverage(
    graph: nx.MultiDiGraph,
    net: Network,
    pop: np.ndarray,
    before: np.ndarray,
    pop_is_real: bool,
    out_dir: Path,
) -> None:
    """Where people can't reach a school or park safely, as map cells.

    The ranked list says what to build; this says who is stuck today, which is
    the question a council member asks about their own ward.
    """
    cell = config.ACCESS_CELL_DEG
    budget = config.ACCESS_BUDGET_M
    acc: defaultdict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0, 0.0])
    for node, i in net.index.items():
        weight = float(pop[i])
        if weight <= 0:
            continue
        key = (
            math.floor(float(graph.nodes[node]["x"]) / cell),
            math.floor(float(graph.nodes[node]["y"]) / cell),
        )
        bucket = acc[key]
        bucket[0] += weight
        if before[i] < budget:
            bucket[1] += weight

    feats: list[dict[str, Any]] = []
    for (cx, cy), (total, served) in sorted(acc.items()):
        if total <= 0:
            continue
        share = served / total
        west, south = cx * cell, cy * cell
        feats.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [round(west, 5), round(south, 5)],
                            [round(west + cell, 5), round(south, 5)],
                            [round(west + cell, 5), round(south + cell, 5)],
                            [round(west, 5), round(south + cell, 5)],
                            [round(west, 5), round(south, 5)],
                        ]
                    ],
                },
                "properties": {
                    "pct_served": round(100 * share),
                    "residents": round(total) if pop_is_real else None,
                    # what the number means, carried with the data so a reader
                    # can't mistake a street-length proxy for a headcount
                    "weight_kind": "residents" if pop_is_real else "residential_street_m",
                    "band": "good" if share >= 0.8 else "partial" if share >= 0.4 else "poor",
                },
            }
        )
    path = out_dir / "access.geojson"
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
    )
    stuck = sum(1 for f in feats if f["properties"]["band"] == "poor")
    print(f"wrote access.geojson ({len(feats)} cells, {stuck} poorly served)")




def select_for_map(candidates: list[Candidate]) -> list[Candidate]:
    """Which projects go into the map layer the app can re-sort.

    Not simply the top N by our own weighting. The app's sliders re-rank what
    it was given, so a reader who moves everything onto crash history would
    never see the streets that actually top that list — they'd be outside the
    slice, invisibly. Each component gets a guaranteed quota, then the composite
    order fills the rest.
    """
    limit = config.PRIORITY_MAP_N
    quota = max(1, limit // 8)
    pinned: dict[str, Candidate] = {}
    # every spot fix, always. They're the cheapest things on the list and there
    # are a few dozen of them; making them compete for slots against
    # kilometre-long corridors left a third of them off the map for no gain.
    for cand in candidates:
        if cand.kind == "spot_fix":
            pinned[cand.pid] = cand
    for comp in ("severance", "access", "crash", "coverage"):
        ranked = sorted(candidates, key=lambda c: c.components.get(comp, 0.0), reverse=True)
        for cand in ranked[:quota]:
            pinned[cand.pid] = cand
    out = list(pinned.values())
    from_quota = len(out)
    for cand in candidates:  # already in composite order
        if len(out) >= limit:
            break
        if cand.pid not in pinned:
            out.append(cand)
    out.sort(key=lambda c: c.score, reverse=True)
    spots = sum(1 for c in out if c.kind == "spot_fix")
    print(
        f"  map layer: {len(out)} projects ({spots} spot fixes, all of them; "
        f"{from_quota - spots} more because they top a single measure, "
        "the rest by overall score)"
    )
    return out


def export_spot_fixes(out_dir: Path, candidates: list[Candidate]) -> None:
    """Spot fixes as points.

    They're in priorities.geojson too — that stays the one list — but 14 metres
    of line is invisible at the zoom a city looks at, and these are the cheapest
    projects on it. A point can be seen.
    """
    feats: list[dict[str, Any]] = []
    for cand in candidates:
        if cand.kind != "spot_fix" or not cand.coords:
            continue
        mid = cand.coords[len(cand.coords) // 2]
        feats.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(mid[0], 6), round(mid[1], 6)],
                },
                "properties": {
                    "pid": cand.pid,
                    "name": cand.name,
                    "towns": ", ".join(cand.towns),
                    "score": cand.score,
                    "length_m": cand.length_m,
                    "summary": summary_sentence(cand),
                },
            }
        )
    (out_dir / "severance.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
    )
    print(f"wrote severance.geojson ({len(feats)} spot fixes on the map)")


def write_meta(
    out_dir: Path,
    candidates: list[Candidate],
    *,
    shown_count: int,
    islands: dict[int, float],
    destinations: int,
    pop: np.ndarray,
    pop_is_real: bool,
    stranded: float,
    stranded_pct: float,
    graph_meta: Mapping[str, Any] | None = None,
) -> None:
    """Where every number in this module came from, and what it doesn't mean.

    A city will be asked "where did that figure come from" the first time it
    quotes one, and a ranking whose provenance lives only in a git history is
    not usable in that room. The app reads this for its methodology note and
    the export packet prints it.
    """
    meta = {
        "built": datetime.datetime.now(datetime.UTC).isoformat()[:10],
        "candidates": len(candidates),
        "mapped": shown_count,
        "islands": {
            "fragments": len(islands),
            "substantial": sum(1 for m in islands.values() if m >= 200),
            "largest_km": [round(m / 1000, 1) for m in sorted(islands.values(), reverse=True)[:5]],
        },
        "destinations": destinations,
        "destination_kinds": list(config.DESTINATION_KINDS),
        "population": {
            "total": round(float(pop.sum())),
            "source": (
                "US Census 2020 block groups (POP100), spread over the street nodes"
                " inside each block group"
                if pop_is_real
                else "PROXY: residential street length, because the census layer"
                " was unavailable — figures are not headcounts"
            ),
            "is_headcount": pop_is_real,
        },
        "access": {
            "budget_m": config.ACCESS_BUDGET_M,
            "budget_note": (
                "perceived metres, which is real distance times the street's stress"
                " multiplier — about 2.5 km on a path or 1.8 km on quiet streets,"
                " roughly 15 minutes at a young-kids pace"
            ),
            "stranded": round(stranded),
            "stranded_pct": round(stranded_pct),
        },
        "model": {
            "kid_safe_max_multiplier": config.SAFE_MULT_MAX,
            "kid_safe_note": (
                "path, separated, buffered, quiet and service streets. A painted"
                " lane (3.0) is deliberately excluded: it is not a route for an"
                " eight-year-old"
            ),
            # The years the crash counts cover. The web page used to print
            # "since 2021" from a literal of its own, which would have misdated
            # the figure the first year this list changed.
            "crash_years": list(config.IMPACT_CRASH_YEARS),
            # 0 means the crash join found nothing, which is not the same as "no
            # street here had a crash": the pages have to be able to tell those
            # apart, and so does the publish gate.
            "crashes_joined": (graph_meta or {}).get("crashes_joined"),
            "upgrade_class": config.UPGRADE_CLASS,
            "upgrade_note": (
                "a candidate is costed as if rebuilt to this class, dropping its"
                " crash factor and crossing penalty — those are what the build"
                " addresses"
            ),
            "weights": dict(config.PRIORITY_WEIGHTS),
        },
        # What produced this file. The publish gate and the live-site health check
        # read these: a snapshot with no edge_schema came from a pipeline older
        # than the graph stamp, which is how a stale graph got published once.
        "provenance": {
            "graph_edge_schema": (graph_meta or {}).get("edge_schema"),
            "graph_built_at": (graph_meta or {}).get("built_at"),
            "graph_data_format": (graph_meta or {}).get("data_format"),
            "crashes_joined": (graph_meta or {}).get("crashes_joined"),
            "built_in_ci": bool(os.environ.get("GITHUB_ACTIONS")),
        },
        "limits": [
            "Scores are comparative within this run, not absolute: they answer"
            " which of these first, never how good this is.",
            "Benefit figures are model output, not measurement. They assume"
            " people ride the safest available route and that a rebuilt street"
            " reaches the target class along its whole length.",
            "Severance gain counts the smaller of the two networks a project"
            " joins, so connecting a stub to the region-wide network is credited"
            " with the stub.",
            "The cost column is an order-of-magnitude proxy (length times a unit"
            " rate), not an estimate: real costs move by an order of magnitude"
            " with drainage, parking removal and signals.",
            "Crash counts come from MassDOT IMPACT 2021-2026 and reflect"
            " reported crashes on streets people already ride, which is not the"
            " same as danger on streets they avoid.",
        ],
    }
    (out_dir / "priorities_meta.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote priorities_meta.json ({'census' if pop_is_real else 'proxy'} population)")


if __name__ == "__main__":
    build()
