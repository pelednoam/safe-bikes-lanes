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
import json
import math
import pickle
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import config
import networkx as nx

# ---------------------------------------------------------------------------
# geometry helpers (kept local: the pipeline's other modules use geopandas for
# joins, but this one walks the graph and only needs distances and midpoints)
# ---------------------------------------------------------------------------

_M_PER_DEG_LAT = 110_540.0


def _m_per_deg_lon(lat: float) -> float:
    return 111_320.0 * math.cos(math.radians(lat))


def meters_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Planar distance in metres, good to well under a metre at this latitude."""
    dx = (a[0] - b[0]) * _m_per_deg_lon((a[1] + b[1]) / 2)
    dy = (a[1] - b[1]) * _M_PER_DEG_LAT
    return math.hypot(dx, dy)


# ---------------------------------------------------------------------------
# candidates
# ---------------------------------------------------------------------------


@dataclass
class Candidate:
    """One buildable thing: a run of street, or a single crossing."""

    pid: str
    name: str
    kind: str  # "corridor" | "crossing"
    cls: str
    length_m: float
    edges: list[tuple[int, int, int]] = field(default_factory=list)
    nodes: list[int] = field(default_factory=list)
    parts: list[list[tuple[float, float]]] = field(default_factory=list)
    crashes: int = 0
    crashes_known: bool = True
    crash_pressure: float = 0.0
    towns: list[str] = field(default_factory=list)

    # filled in by the analyses
    islands: list[int] = field(default_factory=list)
    join_m: float = 0.0  # safe metres joined by building this
    join_names: list[str] = field(default_factory=list)
    dest_unlocked: int = 0
    pop_gaining: float = 0.0
    resident_m_saved: float = 0.0
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
        if self.kind == "crossing":
            return config.UNIT_COST_PER_M["crossing"]
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
    island_m: dict[int, float] = defaultdict(float)
    for iid, comp in enumerate(nx.connected_components(safe)):
        for n in comp:
            island_of[n] = iid
        sub = safe.subgraph(comp)
        island_m[iid] = sum(float(d["length"]) for _, _, d in sub.edges(data=True))
    return island_of, dict(island_m)


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
    unsafe = nx.Graph()
    for u, v, k, data in graph.edges(keys=True, data=True):
        if is_kid_safe(data):
            continue
        unsafe.add_edge(u, v, key=k, data=data)

    # group edges by street identity, then split each group into connected runs
    by_street: defaultdict[tuple[str, str], list[tuple[int, int, int]]] = defaultdict(list)
    for u, v, d in unsafe.edges(data=True):
        by_street[_street_key(d["data"])].append((u, v, d["key"]))

    candidates: list[Candidate] = []
    for (name, cls), edges in sorted(by_street.items()):
        run = nx.Graph()
        run.add_edges_from((u, v) for u, v, _k in edges)
        edge_key = {(min(u, v), max(u, v)): k for u, v, k in edges}
        for comp in nx.connected_components(run):
            sub = run.subgraph(comp)
            length = 0.0
            crashes = 0
            crashes_known = True
            pressure = 0.0
            parts: list[list[tuple[float, float]]] = []
            members: list[tuple[int, int, int]] = []
            for u, v in sub.edges():
                k = edge_key[(min(u, v), max(u, v))]
                data = graph.get_edge_data(u, v, k) or graph.get_edge_data(v, u, k)
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
            if length < config.CANDIDATE_MIN_M or length > config.CANDIDATE_MAX_M:
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
            cand.join_m = round(min(real[0][1], real[1][1]), 1)
            cand.join_names = [f"{real[0][1] / 1000:.1f} km", f"{real[1][1] / 1000:.1f} km"]
        else:
            cand.join_m = 0.0


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
    for cand in candidates:
        if not cand.coords:
            continue
        probes = [cand.coords[0], cand.coords[len(cand.coords) // 2], cand.coords[-1]]
        found: list[str] = []
        for probe in probes:
            for town, rings in towns:
                if any(_in_ring(probe, ring) for ring in rings):
                    if town not in found:
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


def summary_sentence(cand: Candidate) -> str:
    """The project in words. Everything here traces to an exported field —
    nothing is rounded up into a claim the numbers don't support."""
    bits: list[str] = []
    where = f"{cand.length_m:.0f} m of {cand.name}"
    if cand.towns:
        where += f" ({', '.join(cand.towns)})"
    today = CLASS_WORDS.get(cand.cls, cand.cls.replace("_", " "))
    bits.append(f"{where} — today {today}")
    if cand.join_m > 0:
        joined = " and ".join(cand.join_names) if cand.join_names else ""
        bits.append(
            f"connects {joined} of kid-safe streets"
            if joined
            else f"unlocks {cand.join_m / 1000:.1f} km of kid-safe streets"
        )
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
                    "dest_unlocked": cand.dest_unlocked,
                    "pop_gaining": round(cand.pop_gaining, 1),
                    "resident_m_saved": round(cand.resident_m_saved, 1),
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
                    cand.dest_unlocked, f"{cand.pop_gaining:.0f}",
                    f"{cand.resident_m_saved:.0f}", f"{cand.cost_proxy:.0f}",
                    cand.group_size,
                    summary_sentence(cand),
                ]
            )


def build(limit: int | None = None) -> list[Candidate]:
    """Run the analysis over the built graph and write the outputs."""
    with open(config.DATA_DIR / "graph.pkl", "rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    print(f"graph: {len(graph.nodes)} nodes, {len(graph.edges)} edges")

    island_of, island_m = safe_islands(graph)
    big = sorted(island_m.values(), reverse=True)[:5]
    print(
        f"kid-safe islands: {len(island_m)} "
        f"(largest: {', '.join(f'{m / 1000:.1f} km' for m in big)})"
    )

    candidates = find_candidates(graph)
    print(f"candidates: {len(candidates)} unsafe corridors within length bounds")

    score_severance(candidates, island_of, island_m)
    joined = sum(1 for c in candidates if c.join_m > 0)
    print(f"  {joined} of them would join two or more kid-safe islands")

    assign_towns(candidates, load_towns())
    group_alternatives(candidates)
    score_all(candidates)
    candidates.sort(key=lambda c: c.score, reverse=True)
    if limit is not None:
        candidates = candidates[:limit]

    out_dir = config.DATA_DIR
    write_csv(out_dir / "priorities.csv", candidates)
    # The map layer carries the top slice: all 5,675 candidates came to ~7 MB,
    # heavier than the display network the app loads by viewport. The CSV keeps
    # every one of them, and the cap is stated rather than implied.
    shown = candidates[: config.PRIORITY_MAP_N]
    (out_dir / "priorities.geojson").write_text(
        json.dumps(to_geojson(shown), separators=(",", ":"), allow_nan=False)
    )
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


if __name__ == "__main__":
    build()
