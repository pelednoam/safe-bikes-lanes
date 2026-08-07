"""Per-city pages: one city's severance, made legible.

The regional view answers "which project first" across 130 towns. A city needs
something different — its own network, its own barriers, its own numbers — and
the thing worth showing it is not a ranked list, it's the shape of the problem.

Strip a city down to the streets a child can use and the network breaks into
pieces: one large piece that reaches the rest of the region, and pockets that
don't. Colouring the pieces separately puts that on the map in a glance, which
no amount of ranking does.

How bad the split is varies, and the page says whichever is true. Somerville
turned out to be mostly connected — 178 of its 211 kid-safe kilometres are one
piece — so its page leads with the 7,255 residents who still can't reach a
school or park, and treats the 23.3 km of pockets as the specific gaps they are.
The first draft called every city an archipelago; a screenshot disagreed.

Written as a separate step from priorities.py because it needs that module's
output, and because a city page should be cheap to regenerate.
"""

from __future__ import annotations

import html
import itertools
import json
import math
import pickle
import re
from pathlib import Path
from typing import Any

import config
import networkx as nx
import priorities

WEB = config.DATA_DIR.parent / "web"
OUT = WEB / "data" / "cities"

# How many pockets get a colour of their own. Beyond this the map is confetti,
# and the rest share the tail colour at rank NAMED_POCKETS + 1 — honest enough,
# because at that size the point isn't which pocket it is, it's that it's cut
# off. Rank 0 is always the network that reaches the region, so the page's
# palette needs NAMED_POCKETS + 2 entries.
NAMED_POCKETS = 7
# A city page carries its own streets, so it stays small. Anything longer than
# this is a regional corridor that the main map is the right place for.
MAX_PROJECTS = 40

# The cities we publish. build() writes index.json from whatever it is given,
# and the Pages assembly copies one directory per entry in that index — so
# building a single city would quietly un-publish the others. Add a city here.
CITIES = ["Somerville", "Cambridge"]
# Shorter than this and a "pocket" is a driveway stub, not a stranded piece of
# neighbourhood. Applies to both the count and the total, so the page's "N km in
# M pockets" describes one set of things.
MIN_POCKET_M = 200


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def point_in_rings(pt: tuple[float, float], rings: list[list[tuple[float, float]]]) -> bool:
    """Even-odd across every ring at once.

    Not "inside any ring": these rings arrive flattened, outer boundaries and
    interior holes together, so testing them one at a time reports a point in a
    hole as inside the town. Crossing an outer ring puts you in, crossing a hole
    puts you back out, and a town made of two disjoint pieces still works
    because a point can only be inside one of them.
    """
    x, y = pt
    inside = False
    for ring in rings:
        for i in range(len(ring)):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % len(ring)]
            if (y1 > y) != (y2 > y):
                xi = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
                if x < xi:
                    inside = not inside
    return inside


def city_rings(town: str) -> list[list[tuple[float, float]]]:
    for name, rings in priorities.load_towns():
        if name.lower() == town.lower():
            return rings
    return []


def bbox_of(rings: list[list[tuple[float, float]]]) -> tuple[float, float, float, float]:
    xs = [p[0] for ring in rings for p in ring]
    ys = [p[1] for ring in rings for p in ring]
    return (min(xs), min(ys), max(xs), max(ys))


def midpoint(coords: list[tuple[float, float]]) -> tuple[float, float]:
    """The point halfway along a line, by length.

    coords[len // 2] is the middle *vertex*, which is a different thing: OSM
    puts vertices where a street bends, so a long straight run with a cluster of
    curves at one end has its middle vertex down at that end. Since this is what
    decides which town a street belongs to, the error lands on boundary streets
    — exactly the ones a town-by-town page argues about.
    """
    if len(coords) < 2:
        return coords[0]
    pairs = list(itertools.pairwise(coords))
    spans = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in pairs]
    half = sum(spans) / 2
    run = 0.0
    for (a, b), span in zip(pairs, spans, strict=True):
        if run + span >= half:
            t = (half - run) / span if span else 0.0
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        run += span
    return coords[-1]


def segment_props(data: dict[str, Any]) -> dict[str, Any]:
    """What the page needs to explain one street, matching the route planner's
    own card: the class, who says so, and whether anyone has crashed there."""
    return {
        "name": priorities._street_key(data)[0],
        "cls": str(data.get("cls", "")),
        "source": str(data.get("cls_source", "")),
        "crashes": int(data["crash_count"]) if "crash_count" in data else None,
    }


def build_city(town: str, graph: nx.MultiDiGraph) -> dict[str, Any]:
    """Everything one city's page needs, in one file it can fetch."""
    rings = city_rings(town)
    if not rings:
        raise SystemExit(f"no boundary for {town} — is towns.geojson fetched?")
    west, south, east, north = bbox_of(rings)

    def inside(lon: float, lat: float) -> bool:
        if not (west <= lon <= east and south <= lat <= north):
            return False
        return point_in_rings((lon, lat), rings)

    island_of, island_m = priorities.safe_islands(graph)
    # -1 is also the sentinel for "no island" below, so a graph with no kid-safe
    # streets at all would make every unclassified street rank 0 and read as
    # "connected to the region" on the page. Use a value no island id can take.
    biggest_global = max(island_m, key=lambda i: island_m[i], default=-2)

    # First pass: how much of each island lies in THIS city. Ranking islands by
    # their global size put every Somerville pocket in the same bucket — they're
    # all tiny next to a 1,422 km region — so the map showed two colours and the
    # archipelago the page exists to show didn't appear. Rank them locally.
    local_m: dict[int, float] = {}
    members: list[tuple[int, int, dict[str, Any]]] = []
    seen: set[tuple[int, int, int]] = set()
    for u, v, k, data in graph.edges(keys=True, data=True):
        eid = (min(u, v), max(u, v), k)
        if eid in seen:
            continue
        seen.add(eid)
        coords = priorities.edge_coords(graph, u, v, data)
        mid = midpoint(coords)
        if not inside(mid[0], mid[1]):
            continue
        members.append((u, v, data))
        if priorities.is_kid_safe(data):
            iid = island_of.get(u, island_of.get(v, -1))
            local_m[iid] = local_m.get(iid, 0.0) + float(data["length"])

    pockets = sorted(
        ((iid, m) for iid, m in local_m.items() if iid != biggest_global),
        key=lambda kv: kv[1],
        reverse=True,
    )
    # Below this a "pocket" is a driveway stub or a mapping artefact, not a
    # piece of network anyone rides. Counted and measured as one set.
    real_pockets = [(i, m) for i, m in pockets if m >= MIN_POCKET_M]
    # 0 is always the network that reaches the rest of the region; 1..N are this
    # city's own cut-off pockets, biggest first
    rank_of: dict[int, int] = {biggest_global: 0}
    for i, (iid, _m) in enumerate(pockets):
        rank_of[iid] = min(i + 1, NAMED_POCKETS + 1)

    safe_feats: list[dict[str, Any]] = []
    barrier_feats: list[dict[str, Any]] = []
    safe_m = 0.0
    for u, v, data in members:
        coords = priorities.edge_coords(graph, u, v, data)
        line = [[round(x, 6), round(y, 6)] for x, y in coords]
        if priorities.is_kid_safe(data):
            iid = island_of.get(u, island_of.get(v, -1))
            safe_m += float(data["length"])
            safe_feats.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": line},
                    "properties": {
                        # the palette keys off the rank, not the id: ids are
                        # arbitrary and change between builds, ranks don't
                        "isle": rank_of.get(iid, NAMED_POCKETS + 1),
                        # how much of it is in this city, which is what a
                        # resident is looking at — not the regional figure
                        "isle_km": round(local_m.get(iid, 0.0) / 1000, 1),
                        # enough for the page to explain the street itself, in
                        # the same words the route planner uses
                        **segment_props(data),
                    },
                }
            )
        else:
            barrier_feats.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": line},
                    "properties": segment_props(data),
                }
            )

    # Exact membership, not substring: `towns` is a comma-joined list, and in
    # Massachusetts "Reading" is inside "North Reading", "Andover" inside
    # "North Andover", "Boylston" inside "West Boylston". A substring test puts
    # the neighbour's projects on this city's page, which is the one thing the
    # page promises not to do. (city_rings already matches exactly.)
    def in_town(feat: dict[str, Any]) -> bool:
        listed = str(feat["properties"].get("towns", "")).split(",")
        return any(t.strip().lower() == town.lower() for t in listed)

    matching = [
        f
        for f in json.loads((WEB / "data" / "priorities.geojson").read_text())["features"]
        if in_town(f)
    ]
    projects = matching[:MAX_PROJECTS]

    access_path = WEB / "data" / "access.geojson"
    cells: list[dict[str, Any]] = []
    residents = 0.0
    served = 0.0
    if access_path.exists():
        for cell in json.loads(access_path.read_text())["features"]:
            ring = cell["geometry"]["coordinates"][0]
            # average every vertex, not the first four: those are the corners
            # only for the rectangles the exporter happens to emit today, and a
            # clipped or reprojected cell would be assigned to the wrong town
            pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            if not inside(cx, cy):
                continue
            cells.append(cell)
            people = cell["properties"].get("residents")
            if people:
                # a cell with people but no coverage figure counts as unserved
                # rather than aborting the build
                pct = cell["properties"].get("pct_served", 0)
                residents += float(people)
                served += float(people) * float(pct) / 100.0

    meta = json.loads((WEB / "data" / "priorities_meta.json").read_text())
    return {
        "slug": slugify(town),
        "name": town,
        "built": meta.get("built"),
        "bbox": [round(west, 5), round(south, 5), round(east, 5), round(north, 5)],
        "stats": {
            "safe_km": round(safe_m / 1000, 1),
            # the split that matters to someone who lives here: how much of the
            # kid-safe network can you leave the neighbourhood on, and how much
            # is stranded in pockets
            "connected_km": round(local_m.get(biggest_global, 0.0) / 1000, 1),
            # one set of pockets, counted and measured the same way. These two
            # numbers appear in a single sentence ("33 km stranded in 38
            # pockets"), and summing all of them while counting only the ones
            # over MIN_POCKET_M described two different sets.
            "pocket_km": round(sum(m for _i, m in real_pockets) / 1000, 1),
            "pockets": len(real_pockets),
            "biggest_pocket_km": (
                round(real_pockets[0][1] / 1000, 1) if real_pockets else 0.0
            ),
            # what this city has, and how much of it the page shows. Reporting
            # only the truncated count told a city it had 40 candidates when it
            # had more.
            "projects": len(matching),
            "projects_shown": len(projects),
            "residents": round(residents) if residents else None,
            # the count itself, not a percentage the page has to multiply back
            # out: `round(residents * round(pct) / 100)` reconstructed "7,225
            # people" from a whole-number 9%, which is four significant digits
            # of precision nothing ever computed (the true value could be
            # anywhere from ~6,800 to ~7,600).
            "stranded": round(residents - served) if residents else None,
            "stranded_pct": round(100 * (1 - served / residents)) if residents else None,
            # the assumption behind every one of those numbers, carried with
            # them so the page can't state a different budget than was measured
            "budget_km": round(config.ACCESS_BUDGET_M / 1000, 1),
        },
        "boundary": {"type": "MultiPolygon", "coordinates": [[ring] for ring in rings]},
        "islands": {"type": "FeatureCollection", "features": safe_feats},
        "barriers": {"type": "FeatureCollection", "features": barrier_feats},
        "projects": {"type": "FeatureCollection", "features": projects},
        "access": {"type": "FeatureCollection", "features": cells},
        "population_is_headcount": bool(meta.get("population", {}).get("is_headcount")),
        # the regional limits, plus the one this page introduces by cutting a
        # region up along a town line: a resident count assembled from grid
        # cells is not the census figure, and the page names the city next to
        # it, so it has to say so
        "limits": [
            *meta.get("limits", []),
            "Residents are counted by assigning each population grid cell to the"
            " town its centre falls in, so a cell straddling the line counts"
            " wholly one way. The total is close to the census count for the"
            " town but is not it.",
        ],
    }


# Kept out of the template so the source can wrap without putting line breaks
# inside the attribute value, which is what search results and link previews show.
DESCRIPTION = (
    "Where new bike infrastructure would do the most good in {name}: the streets a "
    "child can actually use, the barriers that cut them apart, and the projects that would "
    "join them up."
)

PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{name} — where to build for family biking</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="{description}">
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<link rel="stylesheet" href="../city.css">
<script>window.__CITY__ = "{slug}";</script>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
</head>
<body>
<div id="map"></div>
<main id="panel">
  <p class="kicker">Where to build</p>
  <h1 id="city-name">{name}</h1>
  <p class="lede" id="lede"></p>
  <div class="figures" id="figures"></div>

  <h2>Layers</h2>
  <div class="layers">
    <label class="layer"><input type="checkbox" id="show-islands" checked>
      <span class="swatch line" style="background:#1a9850"></span>
      Streets a child can use, coloured by which piece they belong to</label>
    <label class="layer"><input type="checkbox" id="show-barriers" checked>
      <span class="swatch line" style="background:#d73027"></span>
      The streets that cut those pieces apart</label>
    <label class="layer"><input type="checkbox" id="show-projects" checked>
      <span class="swatch line" style="background:#111619"></span>
      Candidate projects</label>
    <label class="layer"><input type="checkbox" id="show-access">
      <span class="swatch" style="background:#d73027;opacity:.5"></span>
      Who can't reach a school or park</label>
  </div>

  <h2>What to build first</h2>
  <div id="projects"></div>

  <div class="note">
    <details class="limits">
      <summary>How this was worked out, and what it doesn't mean</summary>
      <p>Every street is given a protection class from OpenStreetMap plus the
      city, MassDOT and MAPC facility layers. Keep only what a child can ride —
      paths, separated lanes, buffered lanes and quiet streets — and what's left
      falls into disconnected pieces. Candidate projects are the hostile streets
      that would join two of them, scored on the network they'd connect, how
      much closer they'd bring people to schools, playgrounds and libraries,
      recorded bike crashes, and residents who'd gain a safe route at all.</p>
      <ul id="limits-list"></ul>
    </details>
    <p>Data built <span id="built">—</span>. Part of the
    <a href="../">family bike route planner</a>.</p>
  </div>
</main>
<script type="module" src="../city.js"></script>
</body>
</html>
"""


def write_page(slug: str, name: str) -> Path:
    """A directory per city, so the URL is /somerville rather than ?city=."""
    if slug == "":
        # slugify strips everything non-alphanumeric, so a name like "—" gives
        # "". WEB / "" is WEB, and the page would then be written straight over
        # the route planner's own web/index.html.
        raise SystemExit(f"{name!r} has no usable slug — refusing to write a page")
    directory = WEB / slug
    directory.mkdir(parents=True, exist_ok=True)
    page = directory / "index.html"
    # the name reaches a title, an <h1> and a content="…" attribute; it comes
    # from a MassGIS layer today, but nothing here should depend on that
    safe = html.escape(name, quote=True)
    description = DESCRIPTION.format(name=safe)
    page.write_text(PAGE_TEMPLATE.format(slug=slug, name=safe, description=description))
    return page


def build(towns: list[str]) -> None:
    with open(config.DATA_DIR / "graph.pkl", "rb") as fh:
        graph: nx.MultiDiGraph = pickle.load(fh)
    OUT.mkdir(parents=True, exist_ok=True)
    index: list[dict[str, Any]] = []
    for town in towns:
        data = build_city(town, graph)
        path = OUT / f"{data['slug']}.json"
        path.write_text(json.dumps(data, separators=(",", ":")))
        page = write_page(data["slug"], data["name"])
        size = path.stat().st_size / 1e6
        stats = data["stats"]
        print(
            f"{data['name']}: {stats['safe_km']} km kid-safe — "
            f"{stats['connected_km']} km connected to the region, "
            f"{stats['pocket_km']} km stranded in {stats['pockets']} pockets "
            f"(biggest {stats['biggest_pocket_km']} km); "
            f"{stats['projects']} projects, {size:.1f} MB -> {page.parent.name}/"
        )
        index.append({"slug": data["slug"], "name": data["name"], **stats})
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    listed = ", ".join(c["slug"] for c in index)
    print(f"index.json lists {len(index)} cit{'y' if len(index) == 1 else 'ies'}: {listed}")
    if len(index) < len(CITIES):
        print(f"  note: {len(CITIES)} are published — the rest will drop off the site")


if __name__ == "__main__":
    import sys

    build(sys.argv[1:] or CITIES)
