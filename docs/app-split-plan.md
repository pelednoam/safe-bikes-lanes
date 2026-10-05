# Splitting `web/src/app.ts` into small files

**Budget:** about 200 lines of code per file, not counting comments or blank
lines. `app.ts` had 4,964 code lines (6,486 with comments, 6,717 at the start of
the split); it has 113 (157) after every step: the split is done. Grouping by topic instead of filling files to the brim has
given 69 modules in `src/app/`. A file under budget is fine; one over it is not.

The numbers below were counted on 2026-10-02 from the file as it stands
(sections are `app.ts`'s own `// ----` headers). They are estimates until a
module is cut, and each commit should correct them here.

## Rules

1. **Move code verbatim**, one group per commit, no behaviour change. The
   compiler lists every reference that breaks; fix the imports, nothing else.
2. **The budget is enforced, not hoped for.** A unit test (`tests/appsize.test.ts`)
   counts code lines in `src/app/*.ts` and fails above 220; the same test fails
   on an import cycle inside `src/app/`. Both land before the big moves.
3. **Cycles are cut with `src/hooks.ts`**, a small typed registry (outside
   `src/app/` because it is pure and tested, so it counts toward coverage): a
   module that would import a later one calls `hooks.x(...)` instead, and the
   later module registers it in its `init`. In practice `app/links.ts` holds the
   hooks and `app.ts` sets them in one block right after its imports for as long
   as the function is still there, so nothing at start-up can call one too early. Only the back-edges found by the survey need one
   (below), about a dozen functions.
4. **Shared state lives in `app/store.ts`.** 51 of the 82 top-level variables are
   used in one section only and move with it. The 16 used from three or more
   sections (`start`, `end`, `navActive`, `profileId`, `preferFlat`, `sketchyMarks`,
   `pois`, `fromCurrent`, `mapillaryToken`, `walkMaxM`, `avoidTypes`, `shedMode`,
   `routerReady`, `activeField`, `hazards`, `loopParams`) become one typed object.
5. **Each module has an `init…()`** that `app.ts` calls in today's order, since
   things register at import time (the load closure, listeners) and order matters.
6. **Gate before every push, and read it:** type-check, `test:coverage` (exit
   code and the threshold lines, not only the test count), build, and all
   browser suites; rerun load timeouts at `--workers=3`; then check the deploy.
7. `src/app/` is excluded from coverage like `app.ts` (wiring). A module with
   pure logic gets unit tests and, when it has no DOM, moves out to `src/`.

## Done

| File | Code lines | What |
|---|---|---|
| `app/started.ts` | 3 | the start flag and error reporting, imported first |
| `app/classes.ts` | 131 | class widths, marks, swatches, construction icon |
| `app/dom.ts` | 8 | `el`, `emptyFC` |
| `app/map.ts` | 29 | the map and its controls |
| `app/store.ts` | 75 | the shared variables, `AVOIDABLE`, `loadSketchy` |
| `app/links.ts` | 27 | the hooks other modules call; each set by the init of the module that owns the function (app.ts for the four still in it) |
| `app/services.ts` | 14 | the routing worker, basemap, trip, lanes, `dataReady` (runs at import) |
| `app/sources.ts` | 32 | `getSource`, `ensureLayer`, the lazily loaded layer files |
| `app/data-load.ts` | 175 | manifest, network tiles, construction, points of interest, progress |
| `app/dark-mode.ts` | 84 | night rides: the dark basemap and UI |
| `app/avoid.ts` | 89 | what the router avoids; bumps the grade revision |
| `app/names.ts` | 79 | reverse geocoding and the name cache |
| `app/markers.ts` | 80 | the trip's markers, setting a point, the rider's position |
| `app/sketchy.ts` | 75 | marked spots, their list and popup |
| `app/places.ts` | 109 | saved places, recent routes, backup |
| `app/shed.ts` | 59 | the reach map |
| `app/rides-dialog.ts` | 111 | ride history dialog; recovering an interrupted ride |
| `app/app-info.ts` | 125 | about dialog, build stamp, the street-photo token |
| `app/route-export.ts` | 79 | GPX, cue sheet, offline download |
| `app/app-update.ts` | 85 | APK update check, service worker |
| `app/taps.ts` | 20 | what a tap on a map layer opens: the registry |
| `app/build-state.ts` | 53 | where-to-build data and its typed state |
| `app/build-score.ts` | 85 | published weights, scoring, ranking, repainting the layer |
| `app/build-whatif.ts` | 131 | `runWhatIf`, `endWhatIf`, `clearWhatIf`, `showRealTrip` |
| `app/build-list.ts` | 177 | loading the projects, the list, `focusProject` |
| `app/build-print.ts` | 67 | `printProject` |
| `app/build-controls.ts` | 87 | the panel's listeners and map taps |
| `app/search-candidates.ts` | 94 | local, street and geocoder answers |
| `app/search-view.ts` | 31 | the list as it is on screen, and drawing it |
| `app/search-results.ts` | 75 | rows, choosing one, clearing the list |
| `app/search-grade.ts` | 111 | a letter for the route to each candidate |
| `app/search-input.ts` | 115 | the two boxes: typing, keys |
| `app/phone-search.ts` | 56 | the sheet giving way to the keyboard; the From-field buttons |
| `app/sheet.ts` | 112 | the bottom sheet: heights, dragging, revealing options |
| `app/plan-route.ts` | 177 | asking for a route: start, planning, errors, planning between two picked points |
| `app/plan-loop.ts` | 105 | a round trip: its limits, planning it |
| `app/plan-options.ts` | 155 | the options: cards, chips, choosing one, painting the panel |
| `app/plan-controls.ts` | 59 | reset, swap and the round-trip button |
| `app/summary.ts` | 111 | the route's summary, ribbon, cautions, street-photo preview |
| `app/permalink.ts` | 115 | the link to this trip: write, read, share |
| `app/nav-state.ts` | 57 | navigation's shared state, the ride engine and loop legs |
| `app/nav-voice.ts` | 118 | spoken guidance: the queue, the three voices, the test, the buzz |
| `app/nav-banner.ts` | 60 | the headline, trip line, banner, alert strip, the ride's question, the stops menu |
| `app/nav-location.ts` | 94 | the GPS fix, permission, signal lost, starting the watch |
| `app/nav-camera.ts` | 166 | the dot and view eased toward each fix, framing a route |
| `app/nav-ride.ts` | 182 | the engine's effects: re-plan, rejoin, speak; saving the ride |
| `app/nav-session.ts` | 180 | starting, exiting, arriving, detours, resuming |
| `app/nav-controls.ts` | 131 | the ride's buttons, hazard report from the bike, the back button |
| `app/units-pref.ts` | 45 | the units preference: labels, limits, re-rendering what shows a distance |
| `newest.ts` (in `src/`) | 29 | run a job so only the newest result is applied (the hazard read) |
| `app/hazard-dialog.ts` | 191 | hazard reports: the dialog, reading them, the one-tap report from the bike |
| `app/hazard-blocked.ts` | 100 | "blocked ahead": mark it closed ahead of the rider, re-plan, say honestly what came of it |
| `app/basemap-layers.ts` | 33 | the basemap at first idle, the aerial photos, the terrain; `whenIdle` |
| `app/overlay-layers.ts` | 88 | the area overlays (heat, lanes, elevation), flat and as towers; the crossings gateways |
| `app/network-layers.ts` | 128 | the safety network: lines, marks, hit layer, hover highlight; the street names |
| `app/route-layers.ts` | 78 | the reach map, alternatives, the route and its marks, the part ridden, the history |
| `app/construction-layers.ts` | 56 | construction lines and points, and their card |
| `app/hazard-layers.ts` | 67 | the hazard points and their card |
| `app/build-layers.ts` | 74 | where-to-build on the map |
| `app/poi-layers.ts` | 27 | points of interest |
| `app/hover-state.ts` | 8 | the hover popup, the street card, `dropHoverCard` |
| `app/hover-cards.ts` | 127 | hover and tap cards for dots and areas |
| `app/hover-segment.ts` | 73 | hovering a street or the route; marking it sketchy |
| `app/layer-data.ts` | 26 | what the layers are filled with at load; the link the page opened with |
| `app/map-taps.ts` | 84 | what a tap on the map does, and the long press that marks a street sketchy |
| `app/first-run.ts` | 45 | the first-run card on a phone |
| `app/layer-toggles.ts` | 104 | the layer switches: network, points of interest, overlays, 3D, construction, reset |
| `app/rider-prefs.ts` | 49 | who is riding, the hills, how far to walk, the streets to avoid |
| `app/page-chrome.ts` | 39 | the Escape key and the legend |
| `app/test-hooks.ts` | 14 | what the browser tests reach the page through |
| `hooks.ts` (in `src/`) | 17 | the registry the hooks are made with |
| `tests/appsize.test.ts` | | the size and cycle guard |

Steps 0, 1, 2 ("where to build"), 4 (search), 5 (planning), 6 (navigation and hazards), 7 (the load closure) and 8 (the entry point) are done, and the core pieces the leaves needed (the old step 3's
`sources`, `data-load`, `markers`, `names`, `avoid`). Counts are from the same counter
the guard uses. `app.ts` is down to 113 code lines (157 with comments).

## The entry point

`app.ts` is the imports, the `init…()` calls in the order they must run, and the map's `load`
handler, which calls the layer modules in the order the layers are stacked. Nothing else.

## The back-edges (import cycles to cut with `hooks`)

From the survey, by function name:

- planning to navigation: `frameRoute`, `rebuildNavFromSelected`, `replanRide` (hooks)
- navigation to planning: `renderOptionChips`, `renderOptions`, `selectOption`
- hazards to navigation: `hereLabel`, `showRideAlert`, `speak`, `vibrate`
- navigation to hazards: `hideClassify`
- planning to "where to build": `endWhatIf`, `showRealTrip`; and back: `beginPlan`, `selectOption`
- planning to the sheet: `revealSheet`, `showOptionsInSheet`
- planning to places: `recordRecentRoute`; places to planning: `requestRoute`
- planning to permalink: `updateHash` (hook); permalink to planning: `requestLoop`
- search to phone search: `leaveSearchMode`; search view to search results: `chooseSearchRow`,
  `saveSearchRow`; permalink to plan controls: `resetPlan` (hook)

## Order of work (each line is one or two commits)

0. Foundation: done (see above). The lanes and the `Trip` join the store as the modules that use them are cut.
1. Leaves: done (with the core pieces they needed, below).
2. "Where to build": done (six `build-*` files and `taps`).
3. Core: `sources`, `data-load`, `markers`, `names`, `avoid` done with step 1; the rest of the state section (taps and hover, the lets used by the planner) goes with its users.
4. Search: done (five `search-*` files, `phone-search`, and `sheet`, which phone search needed).
5. Planning: done (`plan-route`, `plan-loop`, `plan-options`, `plan-controls`, `summary`, `permalink`).
6. Navigation and hazards: the eight files, with the hooks.
7. The load closure: done (eight `*-layers`, three `hover-*` and `layer-data`: twelve files).
8. `app.ts` reduced to the entry: done (map-taps, first-run, layer-toggles, rider-prefs, page-chrome, test-hooks).

Steps 6 and 7 are the riskiest. Re-decide there, with the real line counts.
No release tag until all of it is done and has been tried on a real phone.
