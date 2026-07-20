# Safe Bike Lanes — family bike router for Cambridge + Somerville, MA

Plan the **safest** bike ride from A to B — not the fastest. Built for riding
with kids: the router strongly prefers off-street paths, physically separated
bike lanes, and quiet residential streets, and will happily take a much longer
route to avoid busy streets without protection.

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
3. A **FastAPI** server (`server/`) runs Dijkstra over the weighted graph and
   returns the safest route + a stress breakdown vs. the shortest route.
4. A **TypeScript + MapLibre** frontend (`web/`) shows the network colored by
   safety class; click or search to set start/end, drag markers to explore,
   toggle "with kids" vs "solo" weighting.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install osmnx geopandas networkx shapely fastapi 'uvicorn[standard]'

# 1. download all data sources (re-run with --refresh to update)
cd pipeline && ../.venv/bin/python fetch.py

# 2. build the routing graph (downloads OSM via Overpass on first run)
../.venv/bin/python build_graph.py && cd ..

# 3. run the server
.venv/bin/uvicorn app:app --app-dir server --port 8000
# open http://localhost:8000
```

Frontend development (compiled `web/app.js` is committed):

```bash
cd web && npm install && npm run build   # or: npm run check
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
