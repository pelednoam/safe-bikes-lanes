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
4. The **MapLibre + TypeScript** frontend (`web/`) uses a Google-Maps-style
   flow — search or tap for *where to*, routing from your current location by
   default; a peek/half/full draggable bottom sheet on phones; map layers
   behind a floating button; and tappable route-alternative chips (labeled by
   safety **grade**, not ETA — safety stays the hero). It shows the network colored by
   safety class (dashed where a facility is known from OSM only); click or
   search to set start/end, drag markers to explore. Three **rider profiles**
   (young kids / older kids / solo) are computed client-side from raw edge
   data. Each trip offers up to three distinct options (Safest / Balanced /
   Direct), **graded A–F on kid-level stress per meter**, with a "Why this
   route?" panel, a **route ribbon** (stress colors + elevation profile +
   busy-crossing marks), Street View links at caution spots, **GPX download**,
   and a printable **cue sheet**.
5. **Elevation** (AWS Terrain Tiles, ~14 m resolution) gives every edge a climb
   cost; a "prefer flat" toggle penalizes climbing (double on >4% grades) at
   query time. Overlays: **safety heatmap**, **elevation map**, **kid stops**
   (playgrounds, ice cream, libraries, water, restrooms from OSM), and **safe
   crossings** (signalized crossings of busy streets — the gateways between
   low-stress islands).
6. **Explore modes**: the **Reach map** floods from any point and shows
   everything reachable within a "perceived distance" comfort budget — the
   low-stress island around your home. The **Loop planner** builds a round
   trip of a chosen length with a kid stop halfway, returning a different way.
7. **Personal feedback**: right-click any street to mark it sketchy — routes
   avoid it from then on (stored locally, removable from the panel).
8. The app is a **PWA** (installable, works offline once loaded), and a
   **monthly GitHub Action** re-pulls every data source, rebuilds, and
   redeploys automatically so new bike lanes appear without manual work.
9. A **FastAPI** server (`server/`) offers the same routing as an HTTP API for
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

## Android app (Capacitor)

The same code ships as an Android APK via a thin Capacitor wrapper
(`web/android/`): the web bundle plus data layers and a local MapLibre copy
are packaged into the app (fully offline after install), the screen stays on
while the app is open, and location permission is requested on first launch.

Build: GitHub Actions → "Build Android APK" → download the artifact and
install it on the phone (allow installs from unknown sources), or push a tag
like `app-v1` to attach the APK to a release. Local builds work too with an
Android SDK: `cd web && npm run app:sync && cd android && ./gradlew assembleDebug`.

## Lane QA (aerial audit)

`pipeline/aerial_audit.py` samples facility corridors (OSM-only segments
first) and compares MassGIS 15 cm orthoimagery across vintages (2023 vs 2025):
green-paint / white-marking pixel ratios per site, flagging changes and
painted facilities with no visible markings (shadowed sites report "unclear").
`pipeline/review_page.py` renders the worklist with side-by-side crops at
`/data/review/` on the site. Heuristic flags for human review — confirm via
the linked street-level photos, record real changes in
`data/overrides.geojson`. Run on demand (imagery is static between vintages;
tiles cache under `data/raw/aerial/`).

## Dev checks

```bash
.venv/bin/mypy               # strict typing (pipeline, server, tests)
.venv/bin/ruff check pipeline server tests
.venv/bin/python -m pytest   # unit + end-to-end routing tests
cd web && npm run check      # strict TypeScript
cd web && npm run e2e         # Playwright browser tests (real app + graph)
cd web && npm run e2e:native  # emulated Capacitor WebView (native-only paths)
```

## Data licenses

OpenStreetMap © OpenStreetMap contributors (ODbL). Cambridge GIS, MassDOT/
MassGIS, and Somerville layers are public open data. Crash data: MassDOT
IMPACT. This is a personal planning tool; always use your own judgment on the
road.
