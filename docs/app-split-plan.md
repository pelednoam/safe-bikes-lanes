# Splitting `web/src/app.ts` into small files

**Budget:** about 200 lines of code per file, not counting comments or blank
lines. `app.ts` had 4,964 code lines (6,486 with comments, 6,717 at the start of
the split); it has 4,927 (6,437) after step 0, so about 25 files at the very least. Grouping by topic instead of filling files to the brim gives
about 38, averaging about 130. A file under budget is fine; one over it is not.

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
   later module registers it in its `init`. Only the back-edges found by the survey need one
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
| `app/store.ts` | 59 | the 16 shared variables, `AVOIDABLE`, `loadSketchy` |
| `hooks.ts` (in `src/`) | 17 | the registry for the back-edges |
| `tests/appsize.test.ts` | | the size and cycle guard |

Step 0 is done. Counts are from the same counter the guard uses.

## The rest (estimated code lines)

### Core: shared state and what every module leans on (about 450)

| File | ~Lines | Holds |
|---|---|---|
| `app/data-load.ts` | 150 | load progress, `ensureRouter`, load trouble, network tiles, `showCoverage` |
| `app/sources.ts` | 80 | `getSource`, `ensureLayer`, the lazy layer files |
| `app/markers.ts` | 150 | the two markers, `setPoint`, `syncOD`, locate, `currentPosition` |
| `app/names.ts` | 80 | reverse geocoding, its cache, `nameEnd` |
| `app/avoid.ts` | 70 | the avoided types, `routePrefs`, construction avoid points |

### Planning (about 800)

| File | ~Lines | Holds |
|---|---|---|
| `app/plan-route.ts` | 180 | `requestRoute`, `requestLoop`, `beginPlan` |
| `app/plan-options.ts` | 170 | option cards, `selectOption`, `paintPanelWithRoute` |
| `app/summary.ts` | 100 | summary, ribbon, cautions, street photos |
| `app/permalink.ts` | 100 | `parseHash`, `updateHash`, restoring a plan |
| `app/route-export.ts` | 70 | GPX and cue sheet, offline download |
| `app/places.ts` | 70 | saved places, recent routes |
| `app/sketchy.ts` | 70 | marked spots, their list and popup |
| `app/shed.ts` | 50 | the reachability view |

### Search (about 640)

| File | ~Lines | Holds |
|---|---|---|
| `app/search-candidates.ts` | 130 | local, street and geocoder candidates, ranking |
| `app/search-grade.ts` | 100 | `gradeSearchResults`, regrading, the grading timer |
| `app/search-results.ts` | 130 | painting the rows, choosing one |
| `app/search-input.ts` | 120 | `attachSearch` and the input handling |
| `app/phone-search.ts` | 100 | search mode on a phone |
| `app/first-run.ts` | 60 | the first-run notice |

### The map-load closure, 685 lines in one function, cut by feature (about 950)

The closure has only 9 locals of its own, so each feature becomes an
`init…Layers()` that receives nothing but the map.

| File | ~Lines | Holds |
|---|---|---|
| `app/basemap-layers.ts` | 100 | the basemap injected at first idle, `applyBasemap` |
| `app/network-layers.ts` | 170 | the safety network, its marks, hit layers, lane map |
| `app/construction-layers.ts` | 100 | construction lines and points, the barricade icon |
| `app/route-layers.ts` | 120 | the route, ride history, the ride's own line |
| `app/poi-layers.ts` | 90 | points of interest and their stops |
| `app/hazard-layers.ts` | 70 | hazard points and taps |
| `app/hover-cards.ts` | 150 | hover and tap cards, hover state |
| `app/map-taps.ts` | 130 | `onTap`, `onMapTap`, the tap targets |
| `app/sheet.ts` | 130 | `setSheet`, `currentSheet`, `revealSheet`, scroll reset |

### Navigation (about 900)

| File | ~Lines | Holds |
|---|---|---|
| `app/nav-voice.ts` | 150 | `speak`, `vibrate`, the voice tests |
| `app/nav-banner.ts` | 150 | headline, trip line, banner, ride alerts |
| `app/nav-location.ts` | 150 | `toFix`, location errors and advice, `navStartLocation` |
| `app/nav-camera.ts` | 170 | framing, compass, animation, follow and re-centre |
| `app/nav-ride.ts` | 200 | `navOnFix`, `applyRideEffect`, reroute, replan, detour |
| `app/nav-session.ts` | 180 | `startNav`, `exitNav`, resume, arrival, saving the ride |
| `app/nav-controls.ts` | 120 | the 21 button listeners and `popstate` |
| `app/hazard-dialog.ts` | 155 | hazard reports: category, note, photo |

### The rest (about 700)

| File | ~Lines | Holds |
|---|---|---|
| `app/rides-dialog.ts` | 174 | ride history dialog |
| `app/dark-mode.ts` | 91 | night rides: dark basemap and UI |
| `app/app-info.ts` | 116 | about dialog, the in-app update check |
| `app/build-score.ts` | 120 | published weights, scoring, ranking projects |
| `app/build-whatif.ts` | 190 | `runWhatIf`, preview, clearing, real trip |
| `app/build-list.ts` | 160 | the list, project metadata and data |
| `app/build-print.ts` | 90 | `printProject`, focus |
| `app.ts` | 150 | the entry: imports, `init…()` calls in order |

## The back-edges (import cycles to cut with `hooks`)

From the survey, by function name:

- planning to navigation: `frameRoute`, `rebuildNavFromSelected`, `replanRide`
- navigation to planning: `renderOptionChips`, `renderOptions`, `selectOption`
- hazards to navigation: `hereLabel`, `showRideAlert`, `speak`, `vibrate`
- navigation to hazards: `hideClassify`
- planning to "where to build": `endWhatIf`, `showRealTrip`; and back: `beginPlan`, `selectOption`
- planning to the sheet: `revealSheet`, `showOptionsInSheet`
- planning to places: `recordRecentRoute`; places to planning: `requestRoute`
- planning to permalink: `updateHash`; permalink to planning: `requestLoop`
- search to phone search: `leaveSearchMode`; permalink to phone search: `resetPlan`

## Order of work (each line is one or two commits)

0. Foundation: done (see above). The lanes and the `Trip` join the store as the modules that use them are cut.
1. Leaves: `dark-mode`, `app-info`, `rides-dialog`, `route-export`, `places`, `sketchy`, `shed`.
2. "Where to build": the four `build-*` files.
3. Core: `sources`, `data-load`, `markers`, `names`, `avoid`.
4. Search: the six `search-*` and phone files.
5. Planning: `plan-route`, `plan-options`, `summary`, `permalink`.
6. Navigation and hazards: the eight files, with the hooks.
7. The load closure: one commit per layer file, then `hover-cards`, `map-taps`, `sheet`.
8. `app.ts` reduced to the entry.

Steps 6 and 7 are the riskiest. Re-decide there, with the real line counts.
No release tag until all of it is done and has been tried on a real phone.
