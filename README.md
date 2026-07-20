# Safe Bike Lanes — family bike router for Cambridge + Somerville, MA

Plan the **safest** bike ride from A to B — not the fastest. Built for riding
with kids: the router strongly prefers off-street paths, physically separated
bike lanes, and quiet residential streets, and will happily take a much longer
route to avoid busy streets without protection.

**Live app: https://pelednoam.github.io/safe-bikes-lanes/** — fully static,
routing runs in your browser (GitHub Pages, deployed by CI on every push).

## How it works

1. **Data pipeline** (`pipeline/`) fuses, onto an OpenStreetMap bike network:
   - **Cambridge Bike Facilities** (official city GIS — explicit protection
     classes, updated as construction finishes)
   - **MassDOT Bike Inventory** and **Bike Level of Traffic Stress** layers
   - **MassDOT IMPACT crash records** (bicyclist-involved crashes, 2021–present)
   - **Somerville high-crash corridor/intersection** layers
   - a local `data/overrides.geojson` for construction newer than any source
2. Every street segment gets a protection class (separated lane, painted lane,
   quiet street, busy street, …) and a cost multiplier — e.g. an unprotected
   busy street costs 25× its length in "kids" mode. Unsignalized crossings of
   busy streets cost extra.
3. The graph is exported to a compact `web/data/graph.json`
   (`pipeline/export_web.py`); a **TypeScript Dijkstra router** (`web/src/router.ts`)
   computes safest + shortest routes entirely in the browser (~40 ms), so the
   whole app hosts as a static site.
4. The **MapLibre** frontend (`web/`) shows the network colored by safety
   class; click or search to set start/end, drag markers to explore, toggle
   "with kids" vs "solo" weighting. Hover any street to inspect it. For each
   trip it offers up to three distinct options (Safest / Balanced / Direct),
   each **graded A–F on kid-level stress per meter** with a "Why this route?"
   panel explaining the trade-offs: what the detour buys, which protected
   corridors form the backbone, crash hotspots avoided, and any unavoidable
   compromises.
5. **Elevation** (AWS Terrain Tiles, ~14 m resolution) gives every edge a climb
   cost; a "prefer flat" toggle penalizes climbing (double on >4% grades) at
   query time, and each option card shows total climb. Two optional overlays:
   a **safety heatmap** (~100 m cells, green/yellow/red by average street
   stress) and an **elevation map** (hypsometric tints, hover for meters).
6. A **FastAPI** server (`server/`) offers the same routing as an HTTP API for
   local development and the Python end-to-end tests.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install osmnx geopandas networkx shapely fastapi 'uvicorn[standard]'

# 1. download all data sources (re-run with --refresh to update)
cd pipeline && ../.venv/bin/python fetch.py

# 2. build the routing graph (downloads OSM via Overpass on first run)
../.venv/bin/python build_graph.py && cd ..

# 3. export the browser routing graph
cd pipeline && ../.venv/bin/python export_web.py && cd ..

# 4a. serve the static app locally
python3 -m http.server -d web 8000     # or just push — CI deploys to Pages

# 4b. (optional) run the FastAPI dev server instead
.venv/bin/uvicorn app:app --app-dir server --port 8000
```

Frontend development (compiled JS is committed):

```bash
cd web && npm install && npm run build   # tsc
npm run check                            # strict type-check incl. tests
npm test                                 # vitest router tests
```

## Tuning

All safety multipliers live in `pipeline/config.py` (`CLASS_MULTIPLIER`,
crossing penalties, crash weighting). Edit, re-run `build_graph.py`, restart.

Streets that changed faster than the data sources? Add a feature to
`data/overrides.geojson` with a `class` property (e.g. `"separated"` for a
just-opened protected lane, `"busy_street"` for a closed path) — it trumps
every other source.

## Dev checks

```bash
.venv/bin/mypy               # strict typing (pipeline, server, tests)
.venv/bin/ruff check pipeline server tests
.venv/bin/python -m pytest   # unit + end-to-end routing tests
cd web && npm run check      # strict TypeScript
```

## Data licenses

OpenStreetMap © OpenStreetMap contributors (ODbL). Cambridge GIS, MassDOT/
MassGIS, and Somerville layers are public open data. Crash data: MassDOT
IMPACT. This is a personal planning tool; always use your own judgment on the
road.
