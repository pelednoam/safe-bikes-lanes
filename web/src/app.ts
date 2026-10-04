// Frontend for the family bike router. Routing runs fully in the browser
// (see router.ts); class colors mirror pipeline/config.py.
import "./app/started.js";
import { reportCaught } from "./report.js";
import { links } from "./app/links.js";
import { AVOIDABLE, store } from "./app/store.js";
import { CLASS_MARKS, CONSTRUCTION_SWATCH, MARK_INK, NETWORK_MARK_LAYERS, POI_META, RIBBON_PATTERNS, classSwatch, classWidth, constructionIcon } from "./app/classes.js";
import { el, emptyFC } from "./app/dom.js";
// the map is built by importing this: app/map.js
import { map, scaleBar } from "./app/map.js";
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent, MapMouseEvent, Marker, Popup } from "maplibre-gl";

import { maplibregl } from "./maplibre.js";
import { CLASS_COLORS } from "./weights.gen.js";
import type { NativeFix } from "./native.js";
import { askForRideNotifications, isNativeApp, keepScreenOn, lastNativeSpeechError, locationAdvice, minimizeApp, nativeSpeak, nativeStopSpeech, onAndroidBack, rideLocationState, startBackgroundWatcher, stopBackgroundWatcher, webVoiceCount } from "./native.js";
import { CLASS_LABELS, clearPhotoCache, FACILITY_CLASSES, nearestMapillary, GRADE_COLORS, GRADE_TEXT } from "./segment.js";
import type { Maneuver } from "./nav.js";
import { distM, sunsetTime } from "./nav.js";
import { type LoopLeg, navDistText, RideEngine, type RideEffect } from "./ride.js";
import type { HazardCategory, HazardReport } from "./hazards.js";
import {
  addHazard,
  buildReportText,
  downscalePhoto,
  getHazardPhoto,
  HAZARD_LABELS,
  listHazards,
  removeHazard,
  setHazardCategory,
} from "./hazards.js";
import { RideRecorder, saveRide, stashInProgress, takeInProgress } from "./rides.js";
import { dataSource } from "./data.js";
import { PROFILES } from "./router.js";
import {
  distVoice,
  fmtDist,
  fmtClimb,
  fmtDistTight,
  fmtSpeedRound,
  fromMeters,
  getUnits,
  lengthVoice,
  setUnits,
  toMeters,
  unitName,
  unitShort,
} from "./units.js";
import { Lane, type Ticket } from "./planner.js";
import { type ComponentChild, h, render } from "preact";
import { type Headline, NavHeadline, NavTripLine, type TripLine } from "./ui/NavBanner.js";
import { OptionCards } from "./ui/OptionCards.js";
import { Cautions, ClassBar, ClassKey, Ribbon, WhyList } from "./ui/RouteSummary.js";
import { chipViews, paintChip } from "./chips.js";
import { SegmentCardView } from "./ui/SegmentCard.js";
import { PhotoUrls } from "./photourls.js";
import {
  BlockCard,
  cardElement,
  ConstructionCard,
  constructionProps,
  CrossingCard,
  ElevationCard,
  HazardCard,
  PlaceCard,
  textOf,
} from "./ui/MapCards.js";
import { type SpeakPriority, SpeechQueue } from "./speech.js";
import { loopRejoinPoint, payloadLength, rejoinOption } from "./rejoin.js";
import { decodePlan, encodePlan } from "./permalink.js";
import { readItem, removeItem, writeItem } from "./storage.js";
import { ScreenLock, type WakeLockApi } from "./lifecycle.js";
import type { ProtectionClass, RouteOption, RouteSummary } from "./types.js";
import { routeLane, routing, trip } from "./app/services.js";
import { applyBasemap, initDarkMode } from "./app/dark-mode.js";
import { ensureLayer, getSource } from "./app/sources.js";
import { announce, constructionReady, dataProgress, ensureRouter, initDataLoad, manifestReady, networkReady, poisData, poisReady, refreshNetworkTiles, showStage } from "./app/data-load.js";
import { initRidesDialog, renderRides } from "./app/rides-dialog.js";
import { initAppInfo } from "./app/app-info.js";
import { initRouteExport } from "./app/route-export.js";
import { computeShed, exitShedMode, initShed } from "./app/shed.js";
import { applyAvoidPoints, initAvoid, routePrefs, syncAvoidSummary } from "./app/avoid.js";
import { autoNamed, nameEnd } from "./app/names.js";
import { currentPosition, initMarkers, makeMarker, setPoint, syncOD } from "./app/markers.js";
import { initSketchy, openSketchyPopup, renderSketchy, saveSketchy } from "./app/sketchy.js";
import { initPlaces, recordRecentRoute, renderPlacesAndRecent } from "./app/places.js";
import { initAppUpdate, initServiceWorker, swReload } from "./app/app-update.js";
import { TAP_ORDER, type TapTarget, onTap, tapTargets } from "./app/taps.js";
import { build } from "./app/build-state.js";
import { clearWhatIf, endWhatIf, showRealTrip } from "./app/build-whatif.js";
import { ensureBuildMeta } from "./app/build-list.js";
import { initBuildControls } from "./app/build-controls.js";
import { clearSearchResults, initSearchResults } from "./app/search-results.js";
import { dropGrading, initSearchGrade, regradeVisible } from "./app/search-grade.js";
import { initPhoneSearch, leaveSearchMode } from "./app/phone-search.js";
import { initSearchInput } from "./app/search-input.js";
import { SHEET_HALF, initSheet, revealSheet, sheetLayout, showOptionsInSheet } from "./app/sheet.js";

// The functions other modules call through src/app/links.ts, set before anything at
// start-up runs. Seven are function declarations in this module, so they exist from
// the moment it runs; the two inits set the hooks of the modules that moved
// (regradeVisible, and the search list's chooseSearchRow and saveSearchRow). Set later,
// by their modules' own inits, and called only by a click: renderSketchy (a backup
// restore) and leaveSearchMode (a tap on a search row, Enter in a search box).
links.dropHoverCard.set(dropHoverCard);
links.requestRoute.set(requestRoute);
links.planBetween.set(planBetween);
links.openHazardDialog.set(openHazardDialog);
links.beginPlan.set(beginPlan);
links.refreshHazards.set(refreshHazards);
links.selectOption.set(selectOption);
initSearchGrade();
initSearchResults();

// The saved hazards and marks reach the router once the routing data is in. Not part
// of the chain that says routing is ready, so a failure here can't take routing down
// with it; but a plan waits for it (avoidPointsSent), or the first route of a session
// could be drawn through a hazard the rider reported, and never planned again.
const avoidReady: Promise<void> = manifestReady
  .then(() => refreshHazards())
  .catch((err: unknown) => reportCaught("error", err));

/** Wait for the saved hazards and marks to reach the router, for a moment at most: a
 * device store that hangs must not stop every route. */
async function avoidPointsSent(): Promise<void> {
  await Promise.race([avoidReady, new Promise<void>((resolve) => window.setTimeout(resolve, 3000))]);
}


// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** How long a round trip can be, in the units the rider types in. The field's
 * own min/max are advice a browser doesn't enforce on typing: Firebase Test
 * Lab's explorer typed 44,303 and then 57,773 miles, and both were taken. A
 * loop's corridor reaches half its length in every direction, so an absurd one
 * would try to pull in every routing tile there is. Round numbers per unit
 * system, not one limit converted: "31.1 mi" can't be both what the message
 * says and what the check allows. */
const LOOP_LIMITS: Record<"imperial" | "metric", [min: number, max: number]> = {
  imperial: [0.5, 30],
  metric: [1, 50],
};


// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let hoverPopup: Popup | null = null;
/** The street card the hover popup shows (src/ui/SegmentCard.tsx). */
const segmentCard = new SegmentCardView();
/** Take the hover card down for a click card of the same thing. Both open on a
 * desktop tap — the pointer is over it — and two cards over one spot is noise;
 * the click card is the one with a close button, so it stays. */
function dropHoverCard(): void {
  hoverPopup?.remove();
  hoverPopup = null;
}

let hazardPendingLoc: [number, number] | null = null;
let hazardPhoto: Blob | null = null;

let pendingSelect: RouteOption["id"] | null = null;

initDataLoad();

initAvoid();


// ── what the ends are called ──────────────────────────────────────────────
// A permalink (or a tap on the map) sets a destination that has no name, and
// the field sat empty: the trip was drawn but the panel couldn't say where to,
// and the voice announced "you have arrived" at nowhere in particular. Ask
// Nominatim once per spot, remember the answer, and never make routing wait
// for it — a name is a nicety, the route is the product.


// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/** What went wrong, in words for a parent rather than for whoever wrote the
 * router. Its messages ("start and end snap to the same intersection", "no
 * path found", "failed to load routing tiles: TypeError: Failed to fetch")
 * reached the screen as they were. The router keeps its own wording, which its
 * tests and logs rely on; this only decides what is shown. */
function plainError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // the round trip's own messages are already written for people
  if (/try another distance/i.test(raw)) return `${raw.charAt(0).toUpperCase()}${raw.slice(1)}.`;
  if (/same intersection/i.test(raw)) {
    return (
      "The start and the destination are the same spot. " +
      "Pick a destination a little further away."
    );
  }
  if (/no path found|no route/i.test(raw)) {
    return (
      "There's no way to ride between these two points on the streets we have mapped. " +
      "Try a spot on a nearby street for either end."
    );
  }
  if (/too far from the mapped/i.test(raw)) {
    return (
      "That spot is too far from any street we have mapped. " +
      "Pick a point on or next to a street."
    );
  }
  if (/isn't mapped|unmapped/i.test(raw)) {
    return (
      "This area isn't mapped for routing yet — the map covers Cambridge, Somerville " +
      "and the towns around them."
    );
  }
  if (/fetch|network|load|TypeError/i.test(raw)) {
    return "Couldn't download the map needed for this route. Check your connection and try again.";
  }
  console.warn("route failed", err);
  return "Something went wrong planning this route. Try again, or pick a slightly different spot.";
}

/** Take the route options for a new plan. Whatever was planning before is now
 * stale and will not write its answer; the loading line is this plan's to show
 * or not, so an abandoned plan's spinner is taken down here rather than left for
 * a request that has returned without drawing anything. */
function beginPlan(): Ticket {
  const ticket = routeLane.begin();
  // A hypothetical trip belongs to the ends and settings it was asked about.
  // The real trip goes back on screen, not just out of memory: forgotten, the
  // proposed lane's routes stayed up whenever this plan stopped short or
  // failed, and ▶ Navigate rode a lane that doesn't exist.
  const real = build.whatIfReal;
  endWhatIf();
  if (real !== null) showRealTrip(real);
  el<HTMLDivElement>("loading").style.display = "none";
  return ticket;
}

/** Where the rider is, as the start, once a location wait is over. Null when
 * the wait was superseded or withdrawn (Reset, a newer plan) — the start is then
 * not this plan's to set. Someone else may have put a start down while we
 * waited, the load-time locate or a tap on the map; that one stands, rather
 * than a second pin going down on top of it. */
async function locateStart(ticket: Ticket, onFail: string): Promise<Marker | null> {
  if (store.start !== null) return store.start;
  showStage("Finding your location…");
  let here: [number, number];
  try {
    here = await currentPosition();
  } catch {
    if (ticket.stale()) return null;
    el<HTMLDivElement>("loading").style.display = "none";
    const errBox = el<HTMLDivElement>("error");
    errBox.textContent = onFail;
    errBox.style.display = "block";
    return null;
  }
  if (ticket.stale()) return null;
  if (store.start === null) {
    store.start = makeMarker(here, "#2b83ba", "start");
    syncOD();
  }
  return store.start;
}

async function requestRoute(): Promise<void> {
  // Mid-ride, a re-plan is a way on from here. Marking a sketchy street,
  // filing a hazard or dragging a pin all end up here, and used to re-plan the
  // whole trip from the start pin — which navigation then switched to, telling
  // a rider a mile down the road to go back to the beginning.
  if (store.navActive) {
    void replanRide();
    return;
  }
  const ticket = beginPlan();
  if (!store.end) return;
  await manifestReady;
  await avoidPointsSent();
  if (ticket.stale()) return;
  const errBox = el<HTMLDivElement>("error");
  errBox.style.display = "none";
  const loading = el<HTMLDivElement>("loading");
  if (!store.start) {
    if (!store.fromCurrent) return;
    const located = await locateStart(
      ticket,
      "Couldn't find where you are. Type a start in \u201cYour location\u201d, tap 🗺 to " +
        "pick it on the map, or allow location access.",
    );
    if (located === null) return;
  }
  showStage("Loading the map around your route…");
  const progress = (done: number, total: number): void => {
    // only once there are enough for the count to mean something
    if (total > 4 && !ticket.stale()) {
      showStage("Loading the map around your route…", `${done} of ${total}`);
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Reset, or a newer plan, while we yielded: both ends may be gone
  if (ticket.stale() || !store.start || !store.end) return;
  try {
    const s = store.start.getLngLat();
    const d = store.end.getLngLat();
    const a: [number, number] = [s.lng, s.lat];
    const b: [number, number] = [d.lng, d.lat];
    // load the tiles along the corridor, then route; a safe route can detour
    // well outside the straight A–B box, so widen the loaded area once if the
    // first attempt finds nothing.
    const route = (): Promise<RouteOption[]> => {
      showStage("Finding the safest way…");
      return routing.plan(a, b, routePrefs());
    };
    // Computed into a local and only published once this plan is known to be
    // the current one: `options` is what the cards, the chips and navigation
    // all read, and an abandoned plan must not have written it.
    let found: RouteOption[] = [];
    // a narrow corridor first — it covers ordinary detours and keeps a long
    // trip from pulling a big slice of the map; the retry below widens it
    let mapped = await ensureRouter([a, b], 1200, 1, progress);
    if (ticket.stale()) return;
    try {
      if (!mapped) throw new Error("unmapped");
      found = await route();
      if (!found.length) throw new Error("no route");
    } catch {
      if (ticket.stale()) return;
      mapped = await ensureRouter([a, b], 5000, 2, progress);
      if (ticket.stale()) return;
      if (!mapped) throw new Error("this area isn't mapped for routing yet");
      found = await route();
    }
    const fallback = found[0];
    if (!fallback) throw new Error("no route found");
    if (!trip.publish(ticket, found)) return;
    // an A-to-B trip replaces a round trip, and its stop
    store.poiMarker?.remove();
    store.poiMarker = null;
    store.loopParams = null;
    const wanted = pendingSelect;
    pendingSelect = null;
    selectOption(wanted !== null && trip.options.some((o) => o.id === wanted) ? wanted : fallback.id);
    recordRecentRoute([s.lng, s.lat], [d.lng, d.lat]);
    revealSheet();
    frameRoute(fallback);
  } catch (err) {
    if (ticket.stale()) return;
    store.poiMarker?.remove();
    store.poiMarker = null;
    store.loopParams = null;
    trip.clear();
    renderOptions();
    clearOptionChips();
    errBox.textContent = plainError(err);
    errBox.style.display = "block";
  } finally {
    // a newer plan owns the loading line now; hiding it would hide theirs
    if (!ticket.stale()) loading.style.display = "none";
  }
}

async function requestLoop(): Promise<void> {
  if (store.navActive) return; // a new round trip is not something to swap in mid-ride
  const ticket = beginPlan();
  await manifestReady;
  await avoidPointsSent();
  if (ticket.stale()) return;
  const errBox = el<HTMLDivElement>("error");
  errBox.style.display = "none";
  // the distance first: an impossible one shouldn't ask for the rider's
  // location before saying so
  const typed = Number(el<HTMLInputElement>("loop-dist").value);
  if (!Number.isFinite(typed) || typed <= 0) {
    errBox.textContent = `How far would you like to ride? Enter a distance in ${unitName()}.`;
    errBox.style.display = "block";
    return;
  }
  const [loopMin, loopMax] = LOOP_LIMITS[getUnits()];
  if (typed < loopMin || typed > loopMax) {
    errBox.textContent =
      `A round trip can be ${loopMin} to ${loopMax} ${unitShort()} long. ` +
      "How far would you like to ride?";
    errBox.style.display = "block";
    return;
  }
  const targetM = toMeters(typed);
  if (!store.start) {
    // A round trip starts where you are, so find that rather than refusing.
    // Telling someone to "click the map to set a start point first" is asking
    // them to do work the app can do, in answer to a button they just pressed.
    const located = await locateStart(
      ticket,
      "Couldn't get your location — tap 🗺 next to the start field to pick where the ride begins.",
    );
    if (located === null) return;
  }
  await poisReady;
  if (ticket.stale()) return;
  const km = targetM / 1000;
  const kind = el<HTMLSelectElement>("loop-stop").value;
  // null is "no stop wanted" — the router picks a turnaround geometrically,
  // because sometimes the point is just to be out. An empty list is different:
  // it means the stop they asked for has none near enough, which is an error.
  const candidates =
    kind === "none" ? null : kind === "any" ? store.pois : store.pois.filter((p) => p.properties.kind === kind);
  const loading = el<HTMLDivElement>("loading");
  showStage("Loading the map around you…");
  const progress = (done: number, total: number): void => {
    if (total > 4 && !ticket.stale()) {
      showStage("Loading the map around you…", `${done} of ${total}`);
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (ticket.stale() || !store.start) return;
  try {
    const s = store.start.getLngLat();
    // a loop can range out to roughly half its length from the start
    const mapped = await ensureRouter([[s.lng, s.lat]], targetM / 2, 2, progress);
    if (ticket.stale()) return;
    if (!mapped) throw new Error("this area isn't mapped for routing yet");
    showStage(`Finding a ${fmtDistTight(targetM)} loop…`);
    const { option, poi, more } = await routing.loopRoute(
      [s.lng, s.lat],
      targetM,
      candidates,
      store.profileId,
      store.preferFlat,
    );
    if (ticket.stale()) return;
    store.end?.remove();
    store.end = null;
    // a choice of loops, not a verdict: the runner-ups go in the same option
    // cards the point-to-point router uses, so picking between them is the
    // gesture the rider already knows
    if (!trip.publish(ticket, [option, ...more.map((m) => m.option)])) return;
    store.loopParams = { km, kind };
    selectOption("loop");
    store.poiMarker?.remove();
    store.poiMarker = null;
    if (poi !== null) {
      // no marker on a ride with no stop: the loop is the whole of it
      store.poiMarker = new maplibregl.Marker({ color: "#e67e22" })
        .setLngLat(poi.geometry.coordinates)
        .addTo(map);
      const meta = POI_META[poi.properties.kind];
      store.poiMarker.getElement().title =
        `${meta?.emoji ?? ""} ${poi.properties.name || meta?.label || "stop"}`;
    }
  } catch (err) {
    if (ticket.stale()) return;
    errBox.textContent = plainError(err);
    errBox.style.display = "block";
  } finally {
    if (!ticket.stale()) loading.style.display = "none";
  }
}

/** The badges on the map, one per option (src/chips.ts), kept across
 * repaints and updated in place: a badge the keyboard is on stays the element
 * it is on. */
const optionChips = new Map<RouteOption["id"], Marker>();
function clearOptionChips(): void {
  for (const chip of optionChips.values()) chip.remove();
  optionChips.clear();
}

function renderOptionChips(): void {
  const views = chipViews(trip.options, trip.selectedId, GRADE_COLORS, GRADE_TEXT);
  const listed = new Set(views.map((v) => v.id));
  for (const [id, chip] of optionChips) {
    if (listed.has(id)) continue;
    chip.remove();
    optionChips.delete(id);
  }
  for (const v of views) {
    let chip = optionChips.get(v.id);
    if (chip === undefined) {
      const badge = document.createElement("div");
      // reachable and pressable from a keyboard, like the cards they mirror
      badge.tabIndex = 0;
      badge.setAttribute("role", "button");
      badge.addEventListener("click", (ev: Event) => {
        ev.stopPropagation();
        selectOption(v.id);
      });
      badge.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        ev.stopPropagation();
        selectOption(v.id);
      });
      chip = new maplibregl.Marker({ element: badge }).setLngLat(v.at).addTo(map);
      optionChips.set(v.id, chip);
    } else {
      chip.setLngLat(v.at);
    }
    paintChip(chip.getElement(), v);
  }
}

/** Takes the pending panel paint's listeners off. A superseded paint used to
 * return from its own check before removing them, so every option switched
 * past before its line was drawn left a render handler behind — running
 * queryRenderedFeatures on every frame for the rest of the session. */
let cancelPanelPaint: (() => void) | null = null;

/** Run the panel's DOM writes once the route line is actually on the map.
 *
 * The line goes through MapLibre's worker (parse, re-tile, render) while the
 * summary is a synchronous DOM write, so putting both in one task painted the
 * numbers a frame or two before the route appeared — planners read the gap as
 * the app having routed somewhere else and then corrected itself. */
function paintPanelWithRoute(paint: () => void): void {
  cancelPanelPaint?.(); // the newest selection is the only one to paint
  let done = false;
  let renders = 0;
  let parsed = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    map.off("render", onRender);
    map.off("sourcedata", onData);
    window.clearTimeout(soft);
    window.clearTimeout(hard);
    if (cancelPanelPaint === stop) cancelPanelPaint = null;
    window.__panelPaintsWaiting = (window.__panelPaintsWaiting ?? 1) - 1;
  };
  const fire = (): void => {
    if (done) return;
    stop();
    paint();
  };
  const onData = (): void => {
    if (map.isSourceLoaded("route")) parsed = true;
  };
  // "the source is loaded" is not "the line is drawn" — the frame after parsing
  // is the one that draws it. Waiting for rendered geometry is the real signal;
  // a route that lands off-screen has none, so a couple of frames after the
  // data parsed counts as the map having had its chance.
  const onRender = (): void => {
    renders++;
    if (map.getLayer("route") === undefined) return;
    if (map.queryRenderedFeatures(undefined, { layers: ["route"] }).length > 0) fire();
    else if (parsed && renders > 2) fire();
  };
  map.on("sourcedata", onData);
  map.on("render", onRender);
  window.__panelPaintsWaiting = (window.__panelPaintsWaiting ?? 0) + 1;
  // a map that isn't rendering at all (hidden tab, no WebGL) must not hold the
  // numbers hostage; a busy one gets until the hard stop to draw
  const soft = window.setTimeout(() => {
    if (renders === 0) fire();
  }, 600);
  const hard = window.setTimeout(fire, 3000);
  cancelPanelPaint = stop;
}

function selectOption(id: RouteOption["id"]): void {
  // While navigating, guidance follows its own copy of the track. Swapping the
  // drawn route underneath (a mid-ride hazard mark re-plans) would show one
  // line while the voice read another, so keep them in step.
  const wasNavigating = store.navActive;
  if (!trip.select(id)) return;
  const chosen = trip.selected as RouteOption;
  getSource("route").setData(chosen.payload.geojson as GeoJSON.GeoJSON);
  const altFeatures = trip.options
    .filter((o) => o.id !== id)
    .flatMap((o) => o.payload.geojson.features);
  getSource("alts").setData({
    type: "FeatureCollection",
    features: altFeatures,
  } as GeoJSON.GeoJSON);
  // the permalink is written now, not with the panel: a reload a beat after
  // routing used to lose the trip
  updateHash();
  paintPanelWithRoute(() => {
    renderOptions();
    renderOptionChips();
    showSummary(chosen);
    showOptionsInSheet();
    const s = chosen.payload.summary;
    announce(
      `${chosen.label} route, grade ${chosen.grade}: ${fmtDist(s.meters)}, ${s.minutes} min, ` +
        `${s.pct_protected}% protected.` +
        (trip.options.length > 1 ? ` ${trip.options.length} route options.` : ""),
    );
  });
  if (wasNavigating && store.navActive) {
    // keep the spoken guidance on the line that is actually drawn
    rebuildNavFromSelected();
  }
}

/** The card to give focus back to once the cards are rebuilt. */
let optionToFocus: RouteOption["id"] | null = null;

function renderOptions(): void {
  const box = el<HTMLDivElement>("options");
  box.style.display = trip.options.length === 0 ? "none" : "block";
  // One choice among several: a radio group to assistive tech, and walked with
  // the arrow keys. They were click-only divs, so a keyboard could not pick
  // Balanced or Direct at all.
  box.setAttribute("role", "radiogroup");
  box.setAttribute("aria-label", "Route options");
  const focusId = optionToFocus;
  optionToFocus = null;
  render(
    h(OptionCards, {
      options: trip.options,
      selectedId: trip.selectedId,
      focusId,
      gradeColors: GRADE_COLORS,
      gradeText: GRADE_TEXT,
      onSelect: (id, keepFocus) => {
        // the cards are redrawn when the panel repaints; keep the focus with
        // the choice rather than dropping it on the page
        if (keepFocus) optionToFocus = id;
        selectOption(id);
      },
      // hovering a card previews that route on the map; leaving puts the
      // chosen one back
      onPreview: (o) => {
        const shown = o ?? trip.selected;
        if (shown) getSource("route").setData(shown.payload.geojson as GeoJSON.GeoJSON);
      },
    }),
    box,
  );
}

// ---------------------------------------------------------------------------
// summary + ribbon + cautions
// ---------------------------------------------------------------------------

/** The kinds whose map mark the ribbon repeats (see CLASS_MARKS). */
const RIBBON_MARKED: ReadonlySet<string> = new Set(CLASS_MARKS.map((m) => m.cls));

function renderRibbon(option: RouteOption): void {
  render(
    h(Ribbon, {
      segs: option.payload.ribbon ?? [],
      colors: CLASS_COLORS,
      labels: CLASS_LABELS,
      marked: RIBBON_MARKED,
      patterns: RIBBON_PATTERNS,
      climb: fmtClimb,
    }),
    el<HTMLDivElement>("ribbon"),
  );
}

function showSummary(option: RouteOption): void {
  const s: RouteSummary = option.payload.summary;
  el<HTMLDivElement>("summary").style.display = "block";
  el<HTMLElement>("s-dist").textContent = fmtDist(s.meters);
  el<HTMLElement>("s-time").textContent =
    `~${s.minutes} min` + ((s.walk_m ?? 0) > 0 ? ` · 🚶 ${fmtDist(s.walk_m ?? 0)}` : "");
  el<HTMLElement>("s-prot").textContent = `${s.pct_protected}%`;
  el<HTMLElement>("s-quiet").textContent = `${s.pct_quiet}%`;
  el<HTMLElement>("s-detour").textContent =
    s.shortest_meters === undefined || (s.detour_pct ?? 0) <= 0
      ? "same"
      : `+${s.detour_pct}% (${fmtDist(s.shortest_meters)})`;
  const parts = (Object.entries(s.by_class_m) as [ProtectionClass, number][]).map(([cls, meters]) => ({
    cls,
    meters,
  }));
  const breakdown = { parts, colors: CLASS_COLORS, labels: CLASS_LABELS };
  render(h(ClassBar, breakdown), el<HTMLDivElement>("classbar"));
  render(
    h(ClassKey, { ...breakdown, swatch: (cls: ProtectionClass) => classSwatch(cls, 22, 12) }),
    el<HTMLDivElement>("class-key"),
  );
  renderRibbon(option);
  render(
    h(Cautions, {
      cautions: s.cautions,
      labels: CLASS_LABELS,
      photos: store.mapillaryToken !== "",
      onPhoto: (lon: number, lat: number) => void showMapillaryPreview(lon, lat),
    }),
    el<HTMLDivElement>("cautions"),
  );
  const explanation = s.explanation ?? [];
  el<HTMLDetailsElement>("why").style.display = explanation.length > 0 ? "block" : "none";
  render(h(WhyList, { reasons: explanation }), el<HTMLUListElement>("why-list"));

  // daylight check: warn when the ride would end near or after sunset
  const sunsetBox = el<HTMLDivElement>("sunset");
  const arrival = new Date(Date.now() + s.minutes * 60_000);
  const sunset = sunsetTime(new Date(), 42.383, -71.105);
  const marginMin = (sunset.getTime() - arrival.getTime()) / 60_000;
  if (marginMin < 30) {
    const sunsetLocal = sunset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    sunsetBox.textContent =
      marginMin < 0
        ? `🌅 this ride ends after sunset (${sunsetLocal}) — lights on, and try dark mode`
        : `🌅 sunset at ${sunsetLocal} — you'd arrive with ~${Math.round(marginMin)} min of light`;
    sunsetBox.style.display = "block";
  } else {
    sunsetBox.style.display = "none";
  }
}

// ---------------------------------------------------------------------------
// Mapillary street-level photo previews (free client token; CC BY-SA imagery)
// ---------------------------------------------------------------------------

let segPhotoTimer: number | undefined;

async function showMapillaryPreview(lon: number, lat: number): Promise<void> {
  try {
    // the same "nearest, and near enough to be here" rule the street card uses;
    // this used to keep its own narrow-box, newest-wins copy
    const newest = await nearestMapillary(
      lon,
      lat,
      store.mapillaryToken,
      "id,thumb_1024_url,captured_at,computed_geometry",
    );
    const box = document.createElement("div");
    if (newest?.thumb_1024_url) {
      const img = document.createElement("img");
      img.src = newest.thumb_1024_url;
      img.style.cssText = "max-width:260px;border-radius:6px;display:block";
      box.appendChild(img);
      const when = document.createElement("small");
      when.textContent =
        newest.captured_at !== undefined
          ? `📷 ${new Date(newest.captured_at).toLocaleDateString()} · `
          : "";
      box.appendChild(when);
    } else {
      box.textContent = "no street-level photos here — ";
    }
    const link = document.createElement("a");
    link.href = `https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=17`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "open in Mapillary";
    box.appendChild(link);
    new maplibregl.Popup({ maxWidth: "290px" }).setLngLat([lon, lat]).setDOMContent(box).addTo(map);
    map.flyTo({ center: [lon, lat], zoom: 16.5 });
  } catch {
    window.open(`https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=17`, "_blank");
  }
}

// GPX, cue sheet and the offline map download: app/route-export.ts

initRouteExport();


// ---------------------------------------------------------------------------
// URL hash permalinks: #s=lon,lat&e=lon,lat&m=profile&f=1
// ---------------------------------------------------------------------------

/** The hash this page last wrote or read, so a hashchange can tell a link
 * pasted in from the page's own bookkeeping. */
let lastHash = "";

function lngLatOf(m: Marker): [number, number] {
  const p = m.getLngLat();
  return [p.lng, p.lat];
}

function updateHash(): void {
  const hash = encodePlan({
    // "from where you are" stays that, for whoever opens the link
    start: store.start === null ? null : store.fromCurrent ? "here" : lngLatOf(store.start),
    end: store.loopParams === null && store.end !== null ? lngLatOf(store.end) : null,
    loop: store.loopParams,
    profile: store.profileId,
    flat: store.preferFlat,
    walkM: store.walkMaxM,
    avoid: [...store.avoidTypes],
    option:
      trip.selectedId === "safest" || trip.selectedId === "balanced" || trip.selectedId === "direct"
        ? trip.selectedId
        : null,
  });
  if (hash === null) return;
  lastHash = hash;
  // history.state kept: mid-ride this entry is the one the ride pushed
  history.replaceState(history.state, "", `#${hash}`);
}

function parseHash(): void {
  lastHash = window.location.hash.replace(/^#/, "");
  const link = decodePlan(window.location.hash);
  if (link.profile !== null) {
    store.profileId = link.profile;
    const radio = document.querySelector<HTMLInputElement>(
      `input[name=profile][value=${link.profile}]`,
    );
    if (radio) radio.checked = true;
  }
  if (link.flat) {
    store.preferFlat = true;
    el<HTMLInputElement>("prefer-flat").checked = true;
  }
  if (link.walkM !== null) {
    store.walkMaxM = link.walkM;
    el<HTMLSelectElement>("walk-max").value = String(store.walkMaxM);
  }
  if (link.avoid !== null) {
    const valid = new Set(AVOIDABLE.map(([c]) => c as string));
    store.avoidTypes = new Set(link.avoid.filter((t) => valid.has(t)) as ProtectionClass[]);
    for (const [cls] of AVOIDABLE) {
      el<HTMLInputElement>(`avoid-${cls}`).checked = store.avoidTypes.has(cls);
    }
    syncAvoidSummary();
  }
  if (link.option !== null) pendingSelect = link.option;
  const s = link.start;
  if (s !== null && link.loop !== null) {
    // shared loop: restore controls, place the start, and re-plan it
    el<HTMLInputElement>("loop-dist").value = String(
      Math.round(fromMeters(link.loop.km * 1000) * 10) / 10,
    );
    el<HTMLSelectElement>("loop-stop").value = link.loop.kind;
    if (s !== "here") {
      store.fromCurrent = false;
      // one start pin, even if the load-time locate put one down already
      if (store.start) store.start.setLngLat(s);
      else store.start = makeMarker(s, "#2b83ba", "start");
    }
    syncOD();
    void requestLoop();
    return;
  }
  // "here" leaves the start as the rider's own location, found when routing
  if (s !== null && s !== "here") setPoint("start", s);
  if (link.end) setPoint("end", link.end);
}

// A link pasted into a tab that already has the app open changes only the
// hash, which reloads nothing: the old trip stayed on screen and the link did
// nothing at all. Follow it — unless it is this page's own write coming back
// (see lastHash), or a ride is under way, which a link does not replace.
window.addEventListener("hashchange", () => {
  const now = window.location.hash.replace(/^#/, "");
  if (now === lastHash || store.navActive) return;
  resetPlan(false);
  parseHash();
});

// share: Web Share API on mobile, clipboard elsewhere
el<HTMLButtonElement>("share").addEventListener("click", () => {
  const url = window.location.href;
  const btn = el<HTMLButtonElement>("share");
  const flash = (text: string): void => {
    const prev = btn.textContent;
    btn.textContent = text;
    window.setTimeout(() => {
      btn.textContent = prev;
    }, 1500);
  };
  if (typeof navigator.share === "function") {
    void navigator.share({ title: "Family bike route", url }).catch(() => undefined);
    return;
  }
  void navigator.clipboard
    .writeText(url)
    .then(() => {
      flash("✓ copied");
    })
    .catch(() => {
      window.prompt("copy this link:", url);
    });
});

// planning between two points picked from a list; saved places and recent
// routes are in app/places.ts

function planBetween(s: [number, number], e: [number, number]): void {
  store.fromCurrent = false;
  syncOD();
  if (store.start) store.start.setLngLat(s);
  else store.start = makeMarker(s, "#2b83ba", "start");
  if (store.end) store.end.setLngLat(e);
  else store.end = makeMarker(e, "#d7191c", "end");
  nameEnd("start");
  nameEnd("end");
  void requestRoute();
}


// the reach map: app/shed.ts

initShed();


// ---------------------------------------------------------------------------
// layers + interaction wiring
// ---------------------------------------------------------------------------

/**
 * Run `fn` once the browser is idle, or after `timeout` regardless.
 *
 * requestIdleCallback is missing on iOS Safari, which is exactly where this app
 * runs as an installed PWA, so the fallback is not academic: without it the
 * basemap would simply never appear on an iPhone.
 */
function whenIdle(fn: () => void, timeout = 3000): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout });
  } else {
    window.setTimeout(fn, 1200);
  }
}

map.on("load", () => {
  // The basemap: Protomaps' light and dark looks over our own basemap.pmtiles,
  // as vector layers, injected once per theme and thereafter toggled by
  // visibility (see basemap.ts and applyBasemap).
  //
  // Label-free is not a separate tile set but the same layers with the label
  // ones hidden, which is what ride mode wants: raster tiles rotate as
  // pictures, so with the map turned to the heading the baked-in labels ride
  // upside-down and slide off their own streets. The names come back as a real
  // symbol layer (see "street-labels"), which MapLibre keeps upright at any
  // bearing.
  //
  // Only the theme in use is added; applyBasemap adds the other the first time
  // someone switches. The insert point is resolved then, by which time
  // everything added below is on the map — so the basemap lands under it
  // rather than over the route.
  //
  // Deferred to the browser's first idle moment rather than run inline. The
  // basemap is decoration and the safety network is the product, so the ninety
  // vector layers wait their turn behind the app's own tiles. It is worth about
  // two tenths of a second on time-to-usable here — small, but free, and the
  // right way round. requestIdleCallback's own timeout is what guarantees it
  // still happens on a busy phone.
  whenIdle(() => applyBasemap());
  // MassGIS 2023 15-cm orthoimagery (free tile service)
  map.addSource("massgis-aerial", {
    type: "raster",
    tiles: [
      "https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/orthos2023/MapServer/tile/{z}/{y}/{x}",
    ],
    tileSize: 256,
    attribution: "MassGIS 2023 orthoimagery",
  });
  map.addLayer({
    id: "aerial",
    type: "raster",
    source: "massgis-aerial",
    layout: { visibility: "none" },
  });
  // terrain DEM: the same AWS terrarium tiles the pipeline samples
  map.addSource("dem", {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 13,
  });
  // area overlays (hidden until toggled) sit under the street/route lines;
  // each has a flat (2D) and an extruded (3D) variant
  map.addSource("heatmap", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "heatmap",
    type: "fill",
    source: "heatmap",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.35,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
  });
  map.addLayer({
    id: "heatmap-3d",
    type: "fill-extrusion",
    source: "heatmap",
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-opacity": 0.65,
      // danger towers: cell height = average kid-stress × 25 m
      "fill-extrusion-height": ["*", ["coalesce", ["get", "stress"], 1], 25],
    },
  });
  map.addSource("lanemap", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "lanemap",
    type: "fill",
    source: "lanemap",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.45,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
  });
  map.addLayer({
    id: "lanemap-3d",
    type: "fill-extrusion",
    source: "lanemap",
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-opacity": 0.7,
      // towers of infrastructure: 0.4 m per meter of facility in the cell
      "fill-extrusion-height": ["*", ["coalesce", ["get", "fac_m"], 0], 0.4],
    },
  });
  map.addSource("elevmap", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "elevmap",
    type: "fill",
    source: "elevmap",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.45,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
  });
  map.addLayer({
    id: "elevmap-3d",
    type: "fill-extrusion",
    source: "elevmap",
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-opacity": 0.75,
      // exaggerate 4x so the ~50 m hills read clearly
      "fill-extrusion-height": ["*", ["coalesce", ["get", "elev"], 0], 4],
    },
  });
  map.addSource("network", {
    type: "geojson",
    data: emptyFC(),
    generateId: true,
  });
  // dark halo under the network lines — only over aerial imagery, where
  // colored lines otherwise vanish against bright pavement
  map.addLayer({
    id: "network-casing",
    type: "line",
    source: "network",
    layout: { visibility: "none" },
    paint: {
      "line-color": "#111111",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.2, 16, 7.5],
      "line-opacity": 0.85,
    },
  });
  // facilities confirmed by an official source (or non-facility classes): solid
  map.addLayer({
    id: "network",
    type: "line",
    source: "network",
    filter: [
      "any",
      ["!", ["in", ["get", "cls"], ["literal", FACILITY_CLASSES]]],
      ["!=", ["get", "source"], "osm"],
    ],
    paint: {
      "line-color": ["get", "color"],
      "line-width": classWidth(1.2, 3.5),
      "line-opacity": 0.75,
    },
  });
  // facilities known only from OSM (not yet in official layers): dashed
  map.addLayer({
    id: "network-unconfirmed",
    type: "line",
    source: "network",
    filter: [
      "all",
      ["in", ["get", "cls"], ["literal", FACILITY_CLASSES]],
      ["==", ["get", "source"], "osm"],
    ],
    paint: {
      "line-color": ["get", "color"],
      "line-width": classWidth(1.2, 3.5),
      "line-opacity": 0.75,
      "line-dasharray": [2, 1.4],
    },
  });
  // each class's mark, over its line (see CLASS_MARKS). From z13: below that a
  // street is a hairline and a pattern on it is noise.
  for (const m of CLASS_MARKS) {
    map.addLayer({
      id: `network-mark-${m.id}`,
      type: "line",
      source: "network",
      minzoom: 13,
      filter: ["==", ["get", "cls"], m.cls],
      layout: m.round ? { "line-cap": "round" } : {},
      paint: {
        "line-color": MARK_INK,
        "line-width": classWidth(1.2, 3.5, m.scale),
        "line-dasharray": m.dash,
        "line-opacity": 0.75,
      },
    });
  }
  // invisible hit layer: every street stays hoverable/right-clickable even
  // when the network display is toggled off or covered by other layers
  map.addLayer({
    id: "network-hit",
    type: "line",
    source: "network",
    paint: {
      "line-color": "#000000",
      "line-opacity": 0.02,
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 8, 16, 15],
    },
  });
  // hover highlight: bright halo + boosted core for the segment under the cursor
  // hover highlight driven by feature-state (GPU-side, no per-move re-filter):
  // opacity is 0 for every segment except the one with {hover:true}
  const hoverOn = ["case", ["boolean", ["feature-state", "hover"], false], 1, 0];
  map.addLayer({
    id: "network-hover-halo",
    type: "line",
    source: "network",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 7, 16, 12],
      "line-opacity": ["*", hoverOn, 0.9] as unknown as number,
    },
  });
  map.addLayer({
    id: "network-hover-core",
    type: "line",
    source: "network",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 7],
      "line-opacity": hoverOn as unknown as number,
    },
  });
  map.addSource("shed", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "shed",
    type: "line",
    source: "shed",
    paint: { "line-color": "#2563eb", "line-width": 2.5, "line-opacity": 0.8 },
  });
  map.addSource("alts", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "alts",
    type: "line",
    source: "alts",
    paint: {
      "line-color": "#777",
      "line-width": 3,
      "line-dasharray": [2, 2],
      "line-opacity": 0.7,
    },
  });
  map.addSource("route", { type: "geojson", data: emptyFC(), generateId: true });
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#1440a0", "line-width": 9, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "route",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 5 },
  });
  // the same marks on the route itself, which is drawn in the same colours
  for (const m of CLASS_MARKS) {
    map.addLayer({
      id: `route-mark-${m.id}`,
      type: "line",
      source: "route",
      filter: ["all", ["==", ["get", "cls"], m.cls], ["!=", ["get", "walk"], true]],
      layout: { "line-join": "round", ...(m.round ? { "line-cap": "round" as const } : {}) },
      paint: {
        "line-color": MARK_INK,
        "line-width": Math.min(9, 5 * m.scale),
        "line-dasharray": m.dash,
      },
    });
  }
  // walking stretches: white dashes over the route line
  map.addLayer({
    id: "route-walk",
    type: "line",
    source: "route",
    filter: ["==", ["get", "walk"], true],
    paint: { "line-color": "#ffffff", "line-width": 2.5, "line-dasharray": [1.5, 1.5] },
  });
  // the part already ridden, greyed over the coloured route so how far you've
  // come reads at a glance while navigating
  map.addSource("route-done", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "route-done",
    type: "line",
    source: "route-done",
    layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
    paint: { "line-color": "#8a8f98", "line-width": 6, "line-opacity": 0.85 },
  });
  map.addSource("construction", { type: "geojson", data: emptyFC() });
  // Barricade tape — black and white, which nothing else on the map is. As
  // orange dashes it read as a route, in a colour between the palette's amber
  // and red. (See constructionIcon for the points.)
  map.addLayer({
    id: "construction-lines-base",
    type: "line",
    source: "construction",
    filter: ["!=", ["geometry-type"], "Point"],
    paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "construction-lines",
    type: "line",
    source: "construction",
    filter: ["!=", ["geometry-type"], "Point"],
    paint: { "line-color": "#111619", "line-width": 6, "line-dasharray": [1, 1] },
  });
  const barricade = constructionIcon();
  if (barricade !== null) map.addImage("construction-icon", barricade, { pixelRatio: 2 });
  map.addLayer({
    id: "construction-pts",
    type: "symbol",
    source: "construction",
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      "icon-image": "construction-icon",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      // small from afar, where there are a hundred and seventy of them
      "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 14, 0.85, 16, 1.2],
    },
  });
  for (const layer of ["construction-lines", "construction-pts"] as const) {
    onTap(layer, (e: MapLayerMouseEvent) => {
      dropHoverCard();
      const f = e.features?.[0];
      if (!f) return;
      // The same card as the hover's (src/ui/MapCards.tsx), drawn as text:
      // every field comes from a city permit feed or MassDOT's work-zone API,
      // and this one once set them as HTML unescaped while the hover escaped
      // them, the kind of gap that survives because the two look alike.
      const p = f.properties as Record<string, unknown>;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setDOMContent(
          cardElement(
            h(ConstructionCard, constructionProps(p)),
          ),
        )
        .addTo(map);
    });
  }
  map.addSource("hazardpts", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "hazardpts",
    type: "circle",
    source: "hazardpts",
    paint: {
      "circle-radius": 7,
      "circle-color": "#e67e22",
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
  onTap("hazardpts", (e: MapLayerMouseEvent) => {
    dropHoverCard();
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as {
      id?: string;
      category?: HazardCategory;
      note?: string;
      t?: number;
      hasPhoto?: boolean;
    };
    if (props.id === undefined) return;
    const box = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = `⚠ ${props.category !== undefined ? HAZARD_LABELS[props.category] : "hazard"}`;
    box.appendChild(title);
    if (props.note) {
      const note = document.createElement("div");
      note.textContent = props.note;
      box.appendChild(note);
    }
    const when = document.createElement("small");
    when.textContent = props.t !== undefined ? new Date(props.t).toLocaleDateString() : "";
    box.appendChild(when);
    if (props.hasPhoto) {
      const img = document.createElement("img");
      img.style.cssText = "max-width:200px;display:block;border-radius:6px;margin:6px 0";
      void getHazardPhoto(props.id).then((blob) => {
        if (blob) img.src = URL.createObjectURL(blob);
      });
      box.appendChild(img);
    }
    const rm = document.createElement("button");
    rm.textContent = "✕ remove";
    const popup = new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(box).addTo(map);
    rm.addEventListener("click", () => {
      if (props.id === undefined) return;
      void removeHazard(props.id).then(() => {
        popup.remove();
        void refreshHazards().then(() => requestRoute());
      });
    });
    box.appendChild(rm);
  });
  map.addSource("history", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "history",
    type: "line",
    source: "history",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#8b5cf6", "line-width": 4, "line-opacity": 0.8 },
  });
  map.addSource("gateways", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "gateways",
    type: "circle",
    source: "gateways",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#1a9850",
      "circle-stroke-width": 2.5,
    },
  });
  // Street names, drawn from the safety network rather than the basemap, so
  // they stay upright and on their street when the map turns to the heading.
  // Only shown while navigating: the planning view has the basemap's own
  // labels, which cover more than our network does.
  map.addLayer({
    id: "street-labels",
    type: "symbol",
    source: "network",
    filter: ["all", ["has", "name"], ["!=", ["get", "name"], ""]],
    minzoom: 14,
    layout: {
      visibility: "none",
      "symbol-placement": "line",
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 14, 11.5, 17, 14],
      // keep names off tight corners, and don't repeat them every few metres
      "text-max-angle": 35,
      "symbol-spacing": 260,
      "text-padding": 3,
      "text-letter-spacing": 0.01,
    },
    paint: {
      "text-color": "#1d2430",
      "text-halo-color": "rgba(255,255,255,0.92)",
      "text-halo-width": 1.7,
      "text-halo-blur": 0.3,
    },
  });
  // ── where-to-build (cities, not riders) ──────────────────────────────
  // Coverage first, underneath: it's the backdrop the projects are answers to.
  map.addSource("access", { type: "geojson", data: emptyFC() });
  // beforeId: at 35% opacity over the network and route this washed out the
  // safety colours it exists to explain. It's a backdrop.
  map.addLayer(
    {
    id: "access",
    type: "fill",
    source: "access",
    layout: { visibility: "none" },
    paint: {
      "fill-color": [
        "match",
        ["get", "band"],
        "good", "#1a9850",
        "partial", "#fee08b",
        "#d73027",
      ],
      "fill-opacity": 0.35,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
    },
    "network-casing",
  );
  map.addSource("build", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "build",
    type: "line",
    source: "build",
    layout: { visibility: "none", "line-cap": "round" },
    paint: {
      // width and colour both track the score, so the map and the ranked list
      // can't disagree about which project is the big one
      "line-color": [
        "interpolate",
        ["linear"],
        ["get", "score"],
        0, "#8e9aa4",
        0.3, "#f39c12",
        0.6, "#d7191c",
      ],
      "line-width": ["interpolate", ["linear"], ["get", "score"], 0, 2.5, 0.8, 8],
      "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "build-selected",
    type: "line",
    source: "build",
    filter: ["==", ["get", "pid"], ""],
    layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": "#1440a0", "line-width": 11, "line-opacity": 0.45 },
  });
  // Running the mouse down the list should show where each one is without
  // losing the one you picked. Magenta because it appears nowhere else on this
  // map — the safety palette owns every other strong colour here.
  map.addLayer({
    id: "build-hover",
    type: "line",
    source: "build",
    filter: ["==", ["get", "pid"], ""],
    layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": "#e6007e", "line-width": 9, "line-opacity": 0.9 },
  });
  // Spot fixes, as points. They're in the projects layer too, but 14 m of line
  // is invisible at the zoom a city looks at, and these are the cheapest
  // projects on the list.
  map.addSource("crossings", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "crossings",
    type: "circle",
    source: "crossings",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "score"], 0, 4, 0.8, 9],
      "circle-color": "#d7191c",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-opacity": 0.95,
    },
  });
  map.addSource("pois", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "pois",
    type: "circle",
    source: "pois",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 5,
      "circle-color": [
        "match",
        ["get", "kind"],
        "playground", POI_META["playground"]?.color ?? "#e67e22",
        "ice_cream", POI_META["ice_cream"]?.color ?? "#e84393",
        "library", POI_META["library"]?.color ?? "#8e44ad",
        "water", POI_META["water"]?.color ?? "#2980b9",
        "restroom", POI_META["restroom"]?.color ?? "#7f8c8d",
        "#666",
      ],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1.5,
    },
  });

  // hover tooltips on every dot layer (clicks keep their richer popups);
  // src/ui/MapCards.tsx draws them
  const placeCard = (p: Record<string, unknown>, withKind: boolean): ComponentChild => {
    const kind = typeof p["kind"] === "string" ? p["kind"] : "";
    const meta = POI_META[kind];
    const name = textOf(p["name"]);
    return h(PlaceCard, {
      emoji: meta?.emoji ?? "📍",
      name: name || (meta?.label ?? "stop"),
      kind: withKind && name !== "" ? (meta?.label ?? "") : "",
    });
  };
  const constructionCard = (p: Record<string, unknown>): ComponentChild =>
    h(ConstructionCard, constructionProps(p));
  const hazardPhotoId = (p: Record<string, unknown>): string | null =>
    (p["hasPhoto"] === true || p["hasPhoto"] === "true") && textOf(String(p["id"] ?? "")) !== ""
      ? String(p["id"])
      : null;
  const hoverCards: Record<string, (props: Record<string, unknown>) => ComponentChild> = {
    pois: (p) => placeCard(p, true),
    gateways: () => h(CrossingCard, {}),
    hazardpts: (p) => {
      const cat = typeof p["category"] === "string" ? (p["category"] as HazardCategory) : null;
      const id = hazardPhotoId(p);
      return h(HazardCard, {
        label: cat !== null ? HAZARD_LABELS[cat] : "hazard",
        note: textOf(p["note"]),
        when: typeof p["t"] === "number" ? new Date(p["t"]).toLocaleDateString() : null,
        photo: id !== null ? hazardPhotos.get(id) : null,
      });
    },
    "construction-pts": constructionCard,
    "construction-lines": constructionCard,
  };
  for (const [layer, card] of Object.entries(hoverCards)) {
    map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as Record<string, unknown>;
      const content = cardElement(card(props));
      hoverPopup?.remove();
      hoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 10,
      })
        .setLngLat(e.lngLat)
        .setDOMContent(content)
        .addTo(map);
      // hazard photos live in IndexedDB: read once, then drawn from memory
      const photoId = layer === "hazardpts" ? hazardPhotoId(props) : null;
      if (photoId !== null) {
        void hazardPhotos.ensure(photoId).then((arrived) => {
          if (arrived && content.isConnected) render(card(props), content);
        });
      }
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      hoverPopup?.remove();
      hoverPopup = null;
    });
  }

  // gateways have no click popup of their own — give phones (no hover) one
  onTap("gateways", (e: MapLayerMouseEvent) => {
    dropHoverCard();
    new maplibregl.Popup({ offset: 10 })
      .setLngLat(e.lngLat)
      .setDOMContent(cardElement(h(CrossingCard, {})))
      .addTo(map);
  });

  // hover inspection on the network and the planned route: highlight the
  // segment and show a safety card
  let hoverStateId: number | string | null = null;
  let lastHoverKey: string | null = null;
  const clearHoverState = (): void => {
    if (hoverStateId !== null) {
      map.setFeatureState({ source: "network", id: hoverStateId }, { hover: false });
      hoverStateId = null;
    }
  };
  const setHoverState = (id: number | string | undefined): void => {
    if (id === hoverStateId) return;
    clearHoverState();
    if (id !== undefined) {
      map.setFeatureState({ source: "network", id }, { hover: true });
      hoverStateId = id;
    }
  };
  for (const layer of ["network-hit", "route"]) {
    map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "crosshair";
      const f = e.features?.[0];
      if (!f) return;
      // only rebuild when the segment under the cursor actually changes
      const key = `${layer}:${String(f.id)}`;
      if (key === lastHoverKey) return;
      lastHoverKey = key;
      if (layer !== "route") setHoverState(f.id as number | string | undefined);
      else clearHoverState();
      const props = f.properties as {
        cls?: ProtectionClass;
        name?: string;
        crashes?: number;
        source?: string;
      };
      // "right-click" means nothing on a phone
      const hint = window.matchMedia("(hover: none)").matches
        ? "press and hold to mark as sketchy"
        : "right-click to mark as sketchy";
      segmentCard.show(props, [h("br", null), h("small", null, hint)], store.mapillaryToken !== "");
      if (!hoverPopup) {
        hoverPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
        hoverPopup.addTo(map);
      }
      // the same element each time: the card is drawn into it, not replaced
      hoverPopup.setLngLat(e.lngLat).setDOMContent(segmentCard.el);
      if (store.mapillaryToken !== "") {
        window.clearTimeout(segPhotoTimer);
        const popup = hoverPopup;
        const { lng, lat } = e.lngLat;
        // debounce: only fetch once the cursor rests on a segment
        segPhotoTimer = window.setTimeout(() => {
          segmentCard.loadPhoto(lng, lat, store.mapillaryToken, () => popup === hoverPopup);
        }, 300);
      }
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      clearHoverState();
      lastHoverKey = null;
      hoverPopup?.remove();
      hoverPopup = null;
    });
    // right-click (desktop) marks a segment as personally sketchy;
    // touch devices use long-press (wired below)
    map.on("contextmenu", layer, (e: MapLayerMouseEvent) => {
      e.preventDefault();
      openSketchyPopup([e.lngLat.lng, e.lngLat.lat]);
    });
  }

  onTap(
    "pois",
    (e: MapLayerMouseEvent) => {
      dropHoverCard();
      const f = e.features?.[0];
      if (!f) return;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setDOMContent(cardElement(placeCard(f.properties as Record<string, unknown>, false)))
        .addTo(map);
    },
    true,
  );

  map.on("mousemove", "lanemap", (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as { fac_m?: number; prot_m?: number };
    if (props.fac_m === undefined) return;
    hoverPopup?.remove();
    hoverPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setDOMContent(
        cardElement(
          h(BlockCard, { facilityM: Number(props.fac_m) || 0, protectedM: Number(props.prot_m) || 0 }),
        ),
      )
      .addTo(map);
  });
  map.on("mouseleave", "lanemap", () => {
    hoverPopup?.remove();
    hoverPopup = null;
  });
  map.on("mousemove", "elevmap", (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as { elev?: number };
    if (props.elev === undefined) return;
    hoverPopup?.remove();
    hoverPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setDOMContent(cardElement(h(ElevationCard, { elevM: Number(props.elev) || 0 })))
      .addTo(map);
  });
  map.on("mouseleave", "elevmap", () => {
    hoverPopup?.remove();
    hoverPopup = null;
  });

  void refreshHazards();

  // data layers come through the resolver: bundled on the web, freshest of
  // bundle-vs-website in the app (cached per build). The display network loads
  // by viewport (see refreshNetworkTiles); only POIs (needed by the loop
  // planner) load eagerly here; the heavy heatmap/elevation/lane overlays load
  // the first time their toggle is turned on (see ensureLayer).
  void poisData
    .then((d) => {
      // the same collection the loop planner reads (see poisData)
      if (d) (map.getSource("pois") as GeoJSONSource).setData(d as unknown as GeoJSON.GeoJSON);
    })
    .catch(() => undefined)
    .finally(() => dataProgress());
  void networkReady.then(() => refreshNetworkTiles()).finally(() => dataProgress());
  void constructionReady
    .then(() => {
      if (store.constructionFC) {
        (map.getSource("construction") as GeoJSONSource).setData(
          store.constructionFC as unknown as GeoJSON.GeoJSON,
        );
      }
    })
    .finally(() => dataProgress());

  parseHash();
});

map.on("click", (e: MapMouseEvent) => {
  onMapTap(e);
});

/** The one answer to a tap on the map, in order:
 *  1. the ride's stops menu is open: put it away. During a ride that is all the
 *     tap does. It must not also offer to throw the ride away, whatever it
 *     happened to land on.
 *  2. it landed on something to read (TAP_ORDER): open the most specific one,
 *     and stop there, unless that thing is also a destination.
 *  3. the reach map is open: flood from here.
 *  4. riding: ask before trading the ride for a trip to here.
 *  5. otherwise it sets the start or the destination. */
function onMapTap(e: MapMouseEvent): void {
  if (el<HTMLButtonElement>("nav-stops").getAttribute("aria-expanded") === "true") {
    stopsOpen(false);
    if (store.navActive) return;
  }
  // not "=== visible": a layer that never sets it is visible, and reads undefined
  const live = TAP_ORDER.filter(
    (id) =>
      tapTargets.has(id) &&
      map.getLayer(id) !== undefined &&
      map.getLayoutProperty(id, "visibility") !== "none",
  );
  if (live.length > 0) {
    const hits = map.queryRenderedFeatures(e.point, { layers: [...live] });
    const top = live.find((id) => hits.some((f) => f.layer.id === id));
    if (top !== undefined) {
      const target = tapTargets.get(top) as TapTarget;
      const features = hits.filter((f) => f.layer.id === top);
      target.open(Object.assign(e, { features }) as MapLayerMouseEvent);
      if (!target.alsoSetsPoint) return;
    }
  }
  if (store.shedMode) {
    store.shedCenter = [e.lngLat.lng, e.lngLat.lat];
    void computeShed();
    return;
  }
  // Mid-ride the map is for looking at, not re-planning: a stray tap on the
  // handlebars used to silently swap the route out from under the rider.
  if (store.navActive) {
    askDuringRide(
      "End this ride and route to the spot you tapped instead?",
      () => {
        exitNav();
        setPoint("end", e.lngLat);
        syncOD();
        void requestRoute();
      },
    );
    return;
  }
  if (store.activeField === "start") {
    setPoint("start", e.lngLat);
    store.activeField = "end";
  } else {
    setPoint("end", e.lngLat);
  }
}

let pressTimer: number | undefined;
const canvas = map.getCanvas();
canvas.addEventListener("touchstart", (e: TouchEvent) => {
  if (e.touches.length !== 1) return;
  const touch = e.touches[0];
  if (!touch) return;
  const rect = canvas.getBoundingClientRect();
  const px: [number, number] = [touch.clientX - rect.left, touch.clientY - rect.top];
  pressTimer = window.setTimeout(() => {
    const hits = map.queryRenderedFeatures(px, {
      layers: ["network-hit", "route"].filter((l) => map.getLayer(l)),
    });
    if (hits.length > 0) {
      const lngLat = map.unproject(px);
      openSketchyPopup([lngLat.lng, lngLat.lat]);
    }
  }, 600);
});
for (const evt of ["touchend", "touchmove", "touchcancel"] as const) {
  canvas.addEventListener(evt, () => {
    window.clearTimeout(pressTimer);
  });
}

initSheet();

/** Remembered once dismissed; a phone that has seen it once does not again. */
const FIRST_RUN_KEY = "firstRunSeen";

/** The first-run card on a phone (see #first-run in index.html): what the app
 * is for, what the line colours and marks mean, and who is riding — the one
 * choice that changes every route, which otherwise sat below the fold. */
(function initFirstRun(): void {
  let seen = false;
  try {
    seen = localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    /* private mode: show it, it just won't be remembered */
  }
  if (seen || !sheetLayout.matches) return;
  const card = el<HTMLElement>("first-run");
  for (const slot of card.querySelectorAll<HTMLElement>("[data-swatch]")) {
    slot.innerHTML = classSwatch(slot.dataset["swatch"] as ProtectionClass, 28, 12);
  }
  const who = [...card.querySelectorAll<HTMLButtonElement>("[data-profile]")];
  const sync = (): void => {
    const current = document.querySelector<HTMLInputElement>("input[name=profile]:checked")?.value;
    for (const b of who) b.setAttribute("aria-pressed", String(b.dataset["profile"] === current));
  };
  for (const b of who) {
    b.addEventListener("click", () => {
      const radio = document.querySelector<HTMLInputElement>(
        `input[name=profile][value="${b.dataset["profile"] ?? ""}"]`,
      );
      if (radio === null || radio.checked) return;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
    });
  }
  // the same choice made in the panel shows here too
  for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=profile]")) {
    radio.addEventListener("change", sync);
  }
  sync();
  el<HTMLButtonElement>("first-run-ok").addEventListener("click", () => {
    card.hidden = true;
    try {
      localStorage.setItem(FIRST_RUN_KEY, "1");
    } catch {
      /* private mode */
    }
  });
  card.hidden = false;
})();

// search on a phone: app/phone-search.ts
initPhoneSearch();

initPlaces();

/** Clear the trip: pins, options, drawn route — and the link, unless the
 * link is what is being followed. */
function resetPlan(clearLink = true): void {
  // withdraw anything still planning: it would otherwise finish and draw the
  // trip just cleared back onto an empty map
  routeLane.cancel();
  // and a plan that has finished but not yet painted its panel: the paint waits
  // for the line to draw (up to 3 s), and a Reset in that gap got its summary
  // put back over the empty map
  cancelPanelPaint?.();
  el<HTMLDivElement>("loading").style.display = "none";
  store.start?.remove();
  store.end?.remove();
  store.poiMarker?.remove();
  store.start = store.end = store.poiMarker = null;
  store.loopParams = null;
  endWhatIf();
  clearOptionChips();
  store.fromCurrent = true;
  store.activeField = "end";
  el<HTMLInputElement>("from-field").classList.remove("picking");
  el<HTMLInputElement>("from-field").value = "";
  clearSearchResults();
  syncOD();
  trip.clear();
  renderOptions();
  getSource("route").setData(emptyFC());
  getSource("alts").setData(emptyFC());
  el<HTMLDivElement>("summary").style.display = "none";
  el<HTMLDivElement>("error").style.display = "none";
  if (!clearLink) return;
  lastHash = "";
  history.replaceState(history.state, "", "#");
}

el<HTMLButtonElement>("reset").addEventListener("click", () => resetPlan());

el<HTMLButtonElement>("swap").addEventListener("click", () => {
  if (!store.start || !store.end) return;
  const s = store.start.getLngLat();
  store.start.setLngLat(store.end.getLngLat());
  store.end.setLngLat(s);
  // the names swap with the pins, or the fields describe the trip backwards
  const from = el<HTMLInputElement>("from-field");
  const to = el<HTMLInputElement>("search");
  [from.value, to.value] = [to.value, from.value];
  [autoNamed.start, autoNamed.end] = [autoNamed.end, autoNamed.start];
  store.fromCurrent = false;
  syncOD();
  void requestRoute();
});

el<HTMLButtonElement>("loop-btn").addEventListener("click", () => {
  void requestLoop();
});

/** Show/hide the coloured safety network. Driven by the panel checkbox and —
 * because the panel is hidden while navigating — by the nav-mode button too,
 * so both stay in sync from either place. */
function setNetworkVisible(on: boolean): void {
  el<HTMLInputElement>("show-net").checked = on;
  for (const layer of ["network", "network-unconfirmed", ...NETWORK_MARK_LAYERS]) {
    map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
  }
  applyBasemap(); // casing + line widths key off the same flag
  const btn = el<HTMLButtonElement>("nav-net");
  btn.classList.toggle("active", on);
  btn.title = on ? "Hide the safety-network overlay" : "Show the safety-network overlay";
  // refresh on re-show: tile loading is skipped while the layer is hidden
  if (on) void refreshNetworkTiles();
}
el<HTMLInputElement>("show-net").addEventListener("change", (e: Event) => {
  setNetworkVisible((e.target as HTMLInputElement).checked);
});
el<HTMLButtonElement>("nav-net").addEventListener("click", () => {
  setNetworkVisible(!el<HTMLInputElement>("show-net").checked);
});
for (const [checkboxId, layers] of [
  ["show-pois", ["pois"]],
  ["show-gates", ["gateways"]],
] as [string, string[]][]) {
  el<HTMLInputElement>(checkboxId).addEventListener("change", (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked;
    for (const layer of layers) {
      if (checked) ensureLayer(layer);
      map.setLayoutProperty(layer, "visibility", checked ? "visible" : "none");
    }
  });
}

el<HTMLInputElement>("prefer-flat").addEventListener("change", (e: Event) => {
  store.preferFlat = (e.target as HTMLInputElement).checked;
  void requestRoute();
  void computeShed();
  regradeVisible();
});

el<HTMLSelectElement>("walk-max").addEventListener("change", (e: Event) => {
  store.walkMaxM = Number((e.target as HTMLSelectElement).value);
  writeItem("walkMaxM", String(store.walkMaxM));
  void requestRoute();
  regradeVisible();
});
// restore the persisted walking budget
store.walkMaxM = Number(readItem("walkMaxM") ?? "0") || 0;
el<HTMLSelectElement>("walk-max").value = String(store.walkMaxM);

for (const [cls] of AVOIDABLE) {
  const box = el<HTMLInputElement>(`avoid-${cls}`);
  box.checked = store.avoidTypes.has(cls);
  box.addEventListener("change", () => {
    if (box.checked) store.avoidTypes.add(cls);
    else store.avoidTypes.delete(cls);
    writeItem("avoidTypes", JSON.stringify([...store.avoidTypes]));
    syncAvoidSummary();
    // Write the permalink NOW, not just when the reroute finishes: the URL is
    // parsed on load and overrides the stored preferences, so a reload (or a
    // shared link) in the seconds after ticking a box used to resurrect the
    // previous set and silently drop the change.
    updateHash();
    void requestRoute();
    // the letters in the search list were computed against the old set
    regradeVisible();
  });
}
syncAvoidSummary();

// the two area overlays are mutually exclusive to stay readable; in 3D view
// the extruded variants replace the flat fills and terrain turns on
const AREA_OVERLAYS: [string, string][] = [
  ["show-heat", "heatmap"],
  ["show-elev", "elevmap"],
  ["show-lanes", "lanemap"],
];

function syncOverlays(): void {
  const threeD = el<HTMLInputElement>("show-3d").checked;
  const vis = (on: boolean): "visible" | "none" => (on ? "visible" : "none");
  for (const [checkbox, layer] of AREA_OVERLAYS) {
    const on = el<HTMLInputElement>(checkbox).checked;
    map.setLayoutProperty(layer, "visibility", vis(on && !threeD));
    map.setLayoutProperty(`${layer}-3d`, "visibility", vis(on && threeD));
  }
}

for (const [checkbox, layer] of AREA_OVERLAYS) {
  el<HTMLInputElement>(checkbox).addEventListener("change", (e: Event) => {
    if ((e.target as HTMLInputElement).checked) {
      ensureLayer(layer);
      for (const [other] of AREA_OVERLAYS) {
        if (other !== checkbox) el<HTMLInputElement>(other).checked = false;
      }
    }
    syncOverlays();
  });
}
// honor any overlay left enabled by default markup / a restored session
for (const [checkbox, layer] of AREA_OVERLAYS) {
  if (el<HTMLInputElement>(checkbox).checked) ensureLayer(layer);
}
if (el<HTMLInputElement>("show-gates").checked) ensureLayer("gateways");

el<HTMLInputElement>("show-3d").addEventListener("change", (e: Event) => {
  const on = (e.target as HTMLInputElement).checked;
  if (on) {
    map.setTerrain({ source: "dem", exaggeration: 1.3 });
    map.easeTo({ pitch: 60, duration: 800 });
  } else {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }
  syncOverlays();
});

for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=profile]")) {
  radio.addEventListener("change", () => {
    const v = radio.value;
    if (radio.checked && (v === "young_kids" || v === "older_kids" || v === "solo")) {
      store.profileId = v;
      void requestRoute();
      void computeShed();
      // the letters were the safest route for a different rider; a cache key
      // can stop a stale one being replayed but cannot take down one already
      // on screen
      regradeVisible();
    }
  });
}

initSearchInput();

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    if (
      el<HTMLDialogElement>("about").open ||
      el<HTMLDialogElement>("rides").open ||
      el<HTMLDialogElement>("hazard").open
    ) {
      return; // dialogs handle it
    }
    if (store.shedMode) exitShedMode();
    // never wipe the trip out from under an active ride: reset() cleared the
    // route, markers and permalink while navigation kept talking, leaving the
    // rider following a voice over a blank map with no way to recover it
    else if (!store.navActive) el<HTMLButtonElement>("reset").click();
  }
});

// legend: each class as it is drawn — colour, width and mark — so the marks
// are explained where the colours are, and construction beside them
const legend = el<HTMLDivElement>("legend");
for (const [cls, label] of Object.entries(CLASS_LABELS) as [ProtectionClass, string][]) {
  if (cls === "service") continue; // drawn as quiet_street
  const sw = document.createElement("span");
  sw.innerHTML = classSwatch(cls);
  legend.appendChild(sw);
  const span = document.createElement("span");
  span.textContent = label;
  legend.appendChild(span);
}
{
  const sw = document.createElement("span");
  sw.innerHTML = CONSTRUCTION_SWATCH;
  legend.appendChild(sw);
  const span = document.createElement("span");
  span.textContent = "construction — routes avoid it";
  legend.appendChild(span);
}


// ---------------------------------------------------------------------------
// hazard reports (category + note + photo), stored on-device
// ---------------------------------------------------------------------------

/** The hazard reports' photos as the hover card shows them (src/photourls.ts):
 * read from the device once per report, tried again if a read failed, and let
 * go with the report. */
const hazardPhotos = new PhotoUrls(getHazardPhoto);

async function refreshHazards(): Promise<void> {
  try {
    store.hazards = await listHazards();
  } catch {
    store.hazards = [];
  }
  applyAvoidPoints();
  hazardPhotos.prune(new Set(store.hazards.filter((h) => h.hasPhoto).map((h) => h.id)));
  const features = store.hazards.map((h) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [h.lon, h.lat] },
    properties: { id: h.id, category: h.category, note: h.note, t: h.t, hasPhoto: h.hasPhoto },
  }));
  const src = map.getSource("hazardpts");
  if (src) {
    (src as GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    } as GeoJSON.GeoJSON);
  }
}

function openHazardDialog(lon: number, lat: number): void {
  hazardPendingLoc = [lon, lat];
  hazardPhoto = null;
  el<HTMLSelectElement>("hazard-category").value = "surface";
  el<HTMLInputElement>("hazard-note").value = "";
  el<HTMLInputElement>("hazard-photo").value = "";
  const preview = el<HTMLImageElement>("hazard-preview");
  preview.style.display = "none";
  preview.src = "";
  const where = el<HTMLDivElement>("hazard-loc");
  const note = " — saved reports appear on the map and routes avoid them";
  where.textContent = `here${note}`;
  // named as soon as the router says what kind of way this is, if the dialog
  // is still about this spot by then
  void hereLabel(lon, lat).then((label) => {
    if (hazardPendingLoc?.[0] === lon && hazardPendingLoc[1] === lat) {
      where.textContent = `${label}${note}`;
    }
  });
  el<HTMLDialogElement>("hazard").showModal();
}

function pendingHazardReport(): HazardReport | null {
  if (!hazardPendingLoc) return null;
  return {
    id: `${Date.now()}`,
    t: Date.now(),
    lon: hazardPendingLoc[0],
    lat: hazardPendingLoc[1],
    category: el<HTMLSelectElement>("hazard-category").value as HazardCategory,
    note: el<HTMLInputElement>("hazard-note").value,
    hasPhoto: hazardPhoto !== null,
  };
}

el<HTMLInputElement>("hazard-photo").addEventListener("change", () => {
  const file = el<HTMLInputElement>("hazard-photo").files?.[0] ?? null;
  hazardPhoto = file;
  const preview = el<HTMLImageElement>("hazard-preview");
  if (file) {
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
  } else {
    preview.style.display = "none";
  }
});

el<HTMLButtonElement>("hazard-save").addEventListener("click", () => {
  const report = pendingHazardReport();
  if (!report) return;
  void (async () => {
    const photo = hazardPhoto ? await downscalePhoto(hazardPhoto) : null;
    await addHazard(report, photo);
    await refreshHazards();
    el<HTMLDialogElement>("hazard").close();
    speak("hazard saved. routes will avoid it.");
    void requestRoute();
  })().catch(() => {
    el<HTMLDivElement>("hazard-loc").textContent = "could not save (storage unavailable)";
  });
});

// Share used to build a message and never save the report, leaving the dialog
// open with no feedback — so a rider who tapped it kept nothing.
el<HTMLButtonElement>("hazard-share").addEventListener("click", () => {
  el<HTMLButtonElement>("hazard-save").click();
  const report = pendingHazardReport();
  if (!report) return;
  const text = buildReportText(report);
  const files =
    hazardPhoto !== null
      ? [new File([hazardPhoto], "hazard.jpg", { type: hazardPhoto.type || "image/jpeg" })]
      : [];
  const payload = files.length > 0 ? { text, files } : { text };
  if (typeof navigator.canShare === "function" && navigator.canShare(payload)) {
    void navigator.share(payload).catch(() => undefined);
  } else {
    window.location.href = `mailto:?subject=${encodeURIComponent("Bike hazard report")}&body=${encodeURIComponent(text)}`;
  }
});

el<HTMLButtonElement>("hazard-close").addEventListener("click", () => {
  el<HTMLDialogElement>("hazard").close();
});

// ── reporting a hazard mid-ride: file first, ask after ────────────────────
// The dialog (category, note, photo) is still how you report from the planning
// map, where you can read and type. Riding, it was three taps and a form at
// 12 km/h, so nobody used it.

let classifyId: string | null = null;
let classifyTimer: number | undefined;

function hideClassify(): void {
  window.clearTimeout(classifyTimer);
  classifyId = null;
  el<HTMLDivElement>("nav-classify").style.display = "none";
}

async function quickReport(): Promise<void> {
  if (!store.navActive) {
    if (navLastPos) openHazardDialog(navLastPos[0], navLastPos[1]);
    return;
  }
  const at = navLastPos;
  if (!at) {
    showRideAlert("⚠️ no position yet — can't report from here", "gps");
    window.setTimeout(hideRideAlert, 4000);
    return;
  }
  // tapping again because nothing visible happened used to file a second report
  const near = store.hazards.find((hz) => distM([hz.lon, hz.lat], at) < 20);
  const id = near?.id ?? `${Date.now()}`;
  if (!near) {
    try {
      await addHazard(
        { id, t: Date.now(), lon: at[0], lat: at[1], category: "other", note: "", hasPhoto: false },
        null,
      );
      await refreshHazards();
    } catch {
      showRideAlert("⚠️ could not save the report", "gps");
      window.setTimeout(hideRideAlert, 4000);
      return;
    }
  }
  classifyId = id;
  vibrate([80]);
  speak("reported. routes will avoid this spot.", "chat");
  showRideAlert(near ? "📷 already reported here" : "📷 reported — routes will avoid it");
  window.setTimeout(hideRideAlert, 4000);
  el<HTMLDivElement>("nav-classify").style.display = "flex";
  window.clearTimeout(classifyTimer);
  // long enough to answer at the next light, short enough to stop nagging
  classifyTimer = window.setTimeout(hideClassify, 20_000);
}

el<HTMLButtonElement>("nav-report").addEventListener("click", () => {
  void quickReport();
});

for (const btn of document.querySelectorAll<HTMLButtonElement>("#nav-classify button")) {
  btn.addEventListener("click", () => {
    const cat = btn.dataset["cat"] as HazardCategory | undefined;
    const id = classifyId;
    hideClassify();
    if (cat === undefined || id === null) return;
    void setHazardCategory(id, cat)
      .then(refreshHazards)
      .catch(() => undefined);
    showRideAlert(`✓ logged as ${HAZARD_LABELS[cat]}`);
    window.setTimeout(hideRideAlert, 3000);
  });
}

// ride history dialog: app/rides-dialog.ts

initRidesDialog();

// tap-outside is the reflex on a phone; #hazard was the one dialog ignoring it
el<HTMLDialogElement>("hazard").addEventListener("click", (e: MouseEvent) => {
  if (e.target === el<HTMLDialogElement>("hazard")) el<HTMLDialogElement>("hazard").close();
});

el<HTMLButtonElement>("mapillary-save").addEventListener("click", () => {
  const token = el<HTMLInputElement>("mapillary-token").value.trim();
  store.mapillaryToken = token;
  if (token === "") removeItem("mapillaryToken");
  else writeItem("mapillaryToken", token);
  clearPhotoCache(); // the shared lookup holds misses fetched with the old token
  el<HTMLSpanElement>("mapillary-status").textContent =
    token === "" ? "cleared" : "✓ saved — hover any street";
});

initAppInfo();

// ---------------------------------------------------------------------------
// turn-by-turn navigation: follows the GPS along the selected route with a
// banner, voice instructions, wake lock, and automatic rerouting
// ---------------------------------------------------------------------------

const NAV_PITCH = 50;
/** After the rider stops touching the map, the camera takes itself back —
 * otherwise one bump on the handlebars leaves the ride permanently off-centre
 * and you have to keep hunting for the recenter button. */
const REFOLLOW_MS = 10_000;

let navWatchId: number | null = null;
let navMuted = false;
let navFollowing = true;
let navDest: [number, number] | null = null;
let navDot: Marker | null = null;
/** The screen stays on for the whole ride, taken back after every app switch
 * (see lifecycle.ts). */
const screenLock = new ScreenLock(
  // typed as always-present; Safari before 16.4 has none
  () => navigator.wakeLock as WakeLockApi | undefined,
  () => document.visibilityState === "visible",
);
document.addEventListener("visibilitychange", () => {
  void screenLock.onVisibilityChange();
});
/** How long after a ride ends a held-back reload waits: long enough for the
 * "ride saved" line to be heard. */
const RELOAD_AFTER_RIDE_MS = 5000;
let navLastPos: [number, number] | null = null;
/** Set while detouring to a kid stop: where the ride was originally headed. */
let navOriginalDest: [number, number] | null = null;
/** "go with my street choice": reroutes respect the rider's direction. */
let navMyWay = readItem("navMyWay") === "1";
// --- smooth motion (the "feels like Google Maps" layer) -------------------
// GPS fixes land ~1/s. Rather than teleporting the dot and firing a competing
// easeTo per fix, every fix sets a TARGET and one rAF loop eases the dot and
// camera toward it continuously.
let navRaf: number | null = null;
/** Where the dot is drawn right now, and where it's heading. */
let navPosShown: [number, number] | null = null;
let navPosTarget: [number, number] | null = null;
let navBearingShown = 0;
/** Rider's own zoom wins until they hit recenter — no yanking back mid-glance. */
let navUserZoom = false;
/** True mid-gesture: the follow camera keeps its hands off so it can't cut
 * the rider's own pinch/scroll inertia short. */
let navInteracting = false;
let navRefollowTimer: number | undefined;
/** Persist the in-progress ride every N fixes (cheap; finish() only reads). */
const STASH_EVERY_FIXES = 20;
let navFixesSinceStash = 0;
let recorder: RideRecorder | null = null;
/** Background (native) watcher id — used instead of a web watch in the app. */
let navBgWatcherId: string | null = null;

function finishAndSaveRide(): void {
  const ride = recorder?.finish(store.profileId);
  recorder = null;
  stashInProgress(null);
  if (!ride) return;
  saveRide(ride);
  speak(`ride saved. ${lengthVoice(ride.meters)}.`, "chat");
}

function vibrate(pattern: number[]): void {
  if ("vibrate" in navigator) navigator.vibrate(pattern);
}

/** The spoken-guidance queue (see speech.ts). Safety beats navigation beats
 * encouragement — the old code called cancel() before every utterance, so
 * whichever line arrived second silenced the first, and the riders' logs showed
 * "busy street crossing. gather up." being eaten by turn calls (and vice versa)
 * dozens of times in one ride. */
const speech = new SpeechQueue(
  {
    hasNative: isNativeApp,
    speakNative: nativeSpeak,
    stopNative: nativeStopSpeech,
    web: () => {
      // typed as always-present, but a WebView can leave it undefined
      const synth = window.speechSynthesis as SpeechSynthesis | undefined;
      if (!synth) return null;
      return {
        speak: (line): void => {
          const u = new SpeechSynthesisUtterance(line.text);
          u.rate = line.rate;
          u.volume = line.volume;
          u.onend = line.onEnd;
          u.onerror = line.onEnd;
          synth.speak(u);
        },
        cancel: (): void => synth.cancel(),
        get speaking(): boolean {
          return synth.speaking;
        },
      };
    },
  },
  { setTimeout: (fn, ms) => window.setTimeout(fn, ms) },
  () => noteVoiceUnavailable(),
);

/** Say a line and report which engine actually said it.
 *
 * "I can't hear it" has several causes that look identical from the saddle —
 * no engine installed, media volume down, audio on a Bluetooth device in a
 * pannier — and none of them announce themselves. This turns the question into
 * an answer before the ride rather than after it. */
function runVoiceTest(): void {
  const box = el<HTMLDivElement>("voice-status");
  const line = `Voice test. In ${distVoice(200)}, turn left onto the path.`;
  box.textContent = "testing…";
  if (!isNativeApp()) {
    browserVoiceTest(box, line);
    return;
  }
  void nativeVoiceTest(box, line);
}

/** In a browser, speak first and judge afterwards. iOS Safari speaks only when
 * the utterance is started inside the tap, and it reports no voices at all until
 * something has been spoken — so counting voices first, as this used to, told
 * every iPhone "this phone has no usable voice" and never tried. */
function browserVoiceTest(box: HTMLElement, line: string): void {
  const synth = window.speechSynthesis as SpeechSynthesis | undefined;
  if (!synth) {
    box.textContent = "✗ this browser has no voice — watch the screen for turns.";
    return;
  }
  const utter = new SpeechSynthesisUtterance(line);
  utter.rate = 1.05;
  let started = false;
  utter.onstart = (): void => {
    started = true;
  };
  synth.speak(utter);
  window.setTimeout(() => {
    const voices = webVoiceCount();
    box.textContent =
      started || synth.speaking
        ? `▶ spoken by the browser${voices > 0 ? ` (${voices} voices)` : ""}. ` +
          "A browser only talks while the screen is on, so keep this page open " +
          "on screen while you ride — navigating keeps the screen awake for you."
        : "✗ nothing was spoken. Check the phone isn't on silent and the media " +
          "volume is up, then test again.";
  }, 800);
}

async function nativeVoiceTest(box: HTMLElement, line: string): Promise<void> {
  if (await nativeSpeak(line)) {
    box.textContent =
      "✓ spoken by the phone's own voice engine — the one that keeps working " +
      "with the screen off. Heard nothing? Press volume-up while it plays " +
      "(that sets MEDIA volume), and check nothing is grabbing the audio over " +
      "Bluetooth.";
    return;
  }
  const err = lastNativeSpeechError();
  const voices = webVoiceCount();
  if (voices === 0) {
    box.textContent =
      `✗ this phone has no usable voice${err !== null ? ` (${err})` : ""}. ` +
      "Android: Settings → Accessibility → Text-to-speech output — install or " +
      "enable an engine and its English voice data. The app can't supply one.";
    return;
  }
  const utter = new SpeechSynthesisUtterance(line);
  utter.rate = 1.05;
  window.speechSynthesis.speak(utter);
  box.textContent =
    `▶ spoken by the browser engine (${voices} voices), but the app's own ` +
    `engine failed${err !== null ? `: ${err}` : ""} — that's the one that ` +
    "works with the screen off, so turns would go quiet in your pocket.";
}

el<HTMLButtonElement>("voice-test").addEventListener("click", () => {
  runVoiceTest();
});

/** Told the rider once this ride that there is no voice. */
let voiceWarned = false;

function noteVoiceUnavailable(): void {
  if (voiceWarned) return;
  voiceWarned = true;
  const why = lastNativeSpeechError();
  console.warn("voice unavailable", why ?? "no voices");
  if (!store.navActive) return;
  // silence is the worst failure a spoken guide can have: a rider who thinks
  // the voice is coming stops watching the screen
  showRideAlert("🔇 no voice on this phone — watch the screen for turns", "gps");
  window.setTimeout(hideRideAlert, 8000);
}

function speak(text: string, priority: SpeakPriority = "turn"): void {
  if (navMuted) return;
  speech.speak(text, priority);
}

/** Abandon anything queued or being said, on every engine (ride over, or
 * muted). */
function clearSpeech(): void {
  speech.clear();
}

// ── round trips ──────────────────────────────────────────────────────────
// A loop ends where it starts, so its navDest is the start, and a reroute
// aimed there sends the rider home from wherever they strayed. While riding a
// loop the app keeps the loop as planned and how far round it the rider has
// got, and every way back aims for the rest of it instead (see rejoin.ts).

/** The round trip being ridden, as planned; null on an A-to-B ride. */
let navLoop: RouteOption | null = null;
/** The loop legs of the ways back planned so far, by option. */
const loopLegs = new WeakMap<RouteOption, LoopLeg>();

/** The ride itself: where the rider is on the route, and what to tell them
 * (ride.ts). What follows here applies what it decides to the page. */
const rideEngine = new RideEngine({
  dest: () => navDest,
  atStop: () => navOriginalDest !== null,
  myWay: () => navMyWay,
  paceKmh: () => PROFILES[store.profileId].paceKmh,
  solo: () => store.profileId === "solo",
});

/** Route options from where the rider is to where the ride is going: back onto
 * what is left of a loop, or to the destination. Null when there is nowhere
 * to go (no destination yet). */
async function rideOptionsFrom(
  from: [number, number],
  heading?: number,
  toward: { dest: [number, number] | null; onDetour: boolean } = {
    dest: navDest,
    onDetour: navOriginalDest !== null,
  },
): Promise<RouteOption[] | null> {
  const loop = navLoop;
  if (loop !== null && !toward.onDetour) {
    const target = loopRejoinPoint(loop.payload, rideEngine.loopDoneM);
    if (target !== null) {
      const lead = (await routing.plan(from, target.at, routePrefs(), heading))[0];
      if (!lead) return [];
      const back = rejoinOption(lead, loop, target.index);
      loopLegs.set(back, { legM: payloadLength(lead.payload), resumeM: target.atM });
      return [back];
    }
    // what is left of the loop is shorter than the way onto it: finish
  }
  return toward.dest === null ? null : routing.plan(from, toward.dest, routePrefs(), heading);
}

/** Every way on the ride plans mid-ride — a re-plan, a reroute, a detour, the
 * way back from one — owns what the ride follows next, and the newest wins. An
 * answer that arrives after the ride ended, or after a newer one was asked
 * for, is dropped: guidance switching to a route for a wrong turn already put
 * right is worse than none. */
const rideLane = new Lane();
const rideStale = (ticket: Ticket): boolean => ticket.stale() || !store.navActive;
/** A ride's ticket as the trip takes it: stale too once the ride is over. */
const rideTicket = (ticket: Ticket): Ticket => ({ stale: () => rideStale(ticket) });
/** A reroute is also dropped when the rider rejoins before it arrives. */
const rerouteLane = new Lane();

/** Re-plan the ride from where the rider is, keeping where it is going: after
 * something changed what the router must avoid. */
async function replanRide(): Promise<void> {
  if (!store.routerReady || !navLastPos) return;
  // The destination pin may be why: dragged mid-ride, it used to re-plan to
  // where the ride had been going, with the pin and the guidance apart. On a
  // detour the pin is still the ride's destination, the one Resume returns to;
  // a round trip's pin is its start, which it already ends at.
  const pin = store.end?.getLngLat();
  if (pin !== undefined && navLoop === null) {
    if (navOriginalDest !== null) navOriginalDest = [pin.lng, pin.lat];
    else navDest = [pin.lng, pin.lat];
  }
  const ticket = rideLane.begin();
  try {
    const found = await rideOptionsFrom(navLastPos);
    if (rideStale(ticket)) return;
    const first = found?.[0];
    if (!found || !first) return;
    if (!trip.publish(rideTicket(ticket), found)) return;
    selectOption(first.id);
    rebuildNavFromSelected();
  } catch {
    if (rideStale(ticket)) return;
    showRideAlert("⚠ couldn't re-plan from here — keep to the route", "gps");
    window.setTimeout(hideRideAlert, 4000);
  }
}

function rebuildNavFromSelected(): boolean {
  const sel = trip.selected;
  if (!sel) return false;
  // a detour to a stop is off the loop; the loop itself is on it from the start
  const leg = loopLegs.get(sel) ?? (navLoop !== null && sel === navLoop ? { legM: 0, resumeM: 0 } : null);
  rideEngine.setRoute(sel.payload, leg);
  return true;
}

/** What the ride banner says, which is all it says: drawn from here
 * (src/ui/NavBanner.tsx), never written into the page piece by piece. */
const rideView: { headline: Headline; trip: TripLine } = {
  headline: { icon: "⬆", dist: "–", street: "–" },
  trip: { remaining: "", speed: "" },
};

function showHeadline(headline: Headline): void {
  rideView.headline = headline;
  render(h(NavHeadline, headline), el<HTMLDivElement>("nav-main"));
}

function showTripLine(line: TripLine): void {
  rideView.trip = line;
  render(h(NavTripLine, line), el<HTMLDivElement>("nav-trip"));
}

// drawn once at load, as the page's own markup used to be
showHeadline(rideView.headline);
showTripLine(rideView.trip);

/** Distance / ETA line. `straight` marks an off-route estimate (as the crow
 * flies) so the number is honest rather than frozen at its last on-route value. */
function showTrip(t: Extract<RideEffect, { type: "trip" }>): void {
  const eta = new Date(Date.now() + t.minutes * 60_000);
  const clock = eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // "arrive" spelled out pushed this past the banner width, so it wrapped with
  // "PM" alone on a second line and the banner's height twitched all ride
  showTripLine({
    remaining: `${t.straight ? "~" : ""}${fmtDist(t.remainingM)} · ${t.minutes} min · eta ${clock}`,
    speed: t.speedMps > 0.8 ? fmtSpeedRound(t.speedMps) : "",
  });
}

function showBanner(m: Maneuver | undefined, distToNextM: number): void {
  showHeadline({ icon: m?.icon ?? "⬆", dist: navDistText(distToNextM), street: m?.text ?? "" });
}

function toFix(pos: GeolocationPosition): NativeFix {
  return {
    lon: pos.coords.longitude,
    lat: pos.coords.latitude,
    accuracy: pos.coords.accuracy,
    heading: pos.coords.heading,
    speed: pos.coords.speed,
  };
}

/** Losing GPS used to be silent, put "location unavailable — check permissions"
 * over the street name (clipped mid-sentence at 220 px), and leave the big
 * distance frozen looking live. Code 2 is a signal drop, not a permission
 * problem, and the rider needs to hear about it. */
let gpsLostSpokenAt = 0;
function onLocationError(err: { code?: number }): void {
  const denied = err.code === 1;
  showRideAlert(denied ? "⚠ location permission denied" : "⚠ GPS signal lost", "gps");
  if (!denied) {
    const now = Date.now();
    if (now - gpsLostSpokenAt > 20_000) {
      gpsLostSpokenAt = now;
      speak("lost g p s signal. keep following the road.", "safety");
    }
  }
}

function navOnPosition(pos: GeolocationPosition): void {
  navOnFix(toFix(pos));
}

/** A location problem on the ride alert, and what tapping the alert opens. */
let gpsAlertFix: { text: string; fix: () => void } | null = null;
function showLocationAdvice(message: string, fix?: () => void): void {
  const text = `⚠ ${message}`;
  showRideAlert(text, "gps");
  gpsAlertFix = fix === undefined ? null : { text, fix };
}
el<HTMLDivElement>("nav-alert").addEventListener("click", () => {
  const box = el<HTMLDivElement>("nav-alert");
  // only while the alert still says what the fix is for
  if (gpsAlertFix !== null && box.style.display !== "none" && box.textContent === gpsAlertFix.text) {
    gpsAlertFix.fix();
  }
});

/** Set while navStartLocation is waiting on a permission dialog. */
let navLocationStarting = false;

/** Start the ride's position source.
 *
 * In the app, permission comes first and the watcher second. The watcher's
 * plugin asks for location itself, but goes straight on to start its foreground
 * service without waiting for the answer; on Android 14+ that start is refused
 * without the permission and never retried, so a first ride only tracked while
 * the screen stayed on. With precise location refused or only approximate, no
 * watcher starts at all — the WebView would just ask again — and this runs again
 * when the rider comes back from Settings (`ask` false: nothing pops up then). */
async function navStartLocation(ask: boolean): Promise<void> {
  if (navLocationStarting || navBgWatcherId !== null || navWatchId !== null) return;
  navLocationStarting = true;
  try {
    if (isNativeApp()) {
      const state = await rideLocationState(ask);
      if (!store.navActive) return;
      const advice = locationAdvice(state);
      if (state === "approximate" || state === "denied") {
        if (advice !== null) showLocationAdvice(advice.text, advice.fix);
        return;
      }
      if (ask && state !== "unknown") {
        const line = await askForRideNotifications((l) => showRideAlert(`🔔 ${l}`, "gps"));
        if (line !== null && el<HTMLDivElement>("nav-alert").textContent === `🔔 ${line}`) {
          hideRideAlert();
        }
        if (!store.navActive) return;
      }
      // "off" still starts the watcher: its fixes arrive once location is on
      if (advice !== null) showLocationAdvice(advice.text, advice.fix);
      // background watcher keeps GPS + voice alive with the screen off (shows a
      // persistent notification while navigating)
      const id = await startBackgroundWatcher(
        "Family Bike Router",
        "Turn-by-turn navigation is running",
        navOnFix,
        showLocationAdvice,
        { requestPermissions: state === "unknown" },
      );
      if (!store.navActive) {
        if (id !== null) void stopBackgroundWatcher(id);
        return;
      }
      navBgWatcherId = id;
      if (id !== null) return;
    }
    navWatchId = navigator.geolocation.watchPosition(
      navOnPosition,
      (err: GeolocationPositionError) => onLocationError(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  } finally {
    navLocationStarting = false;
  }
}

// Back from Settings with location now allowed (or switched on): pick the ride up.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && store.navActive && isNativeApp()) {
    void navStartLocation(false);
  }
});

/** A warning the rider can SEE. The spoken version is the primary channel, but
 * it is useless muted or over kids' chatter, and a safety app must not depend on
 * audio alone. Cleared automatically once it's behind us. */
function showRideAlert(text: string, kind: "hazard" | "gps" = "hazard"): void {
  if (kind === "hazard") window.__navAlertsSeen = (window.__navAlertsSeen ?? 0) + 1;
  const box = el<HTMLDivElement>("nav-alert");
  box.textContent = text;
  box.classList.toggle("gps", kind === "gps");
  box.style.display = "block";
}
function hideRideAlert(): void {
  el<HTMLDivElement>("nav-alert").style.display = "none";
  rideEngine.alertHidden();
}

/** Ask the rider something without stopping the ride. window.confirm blocks
 * the page, so guidance, the follow camera and the recorder all froze until it
 * was answered — easy to miss at speed, and indistinguishable from a crash. */
function askDuringRide(question: string, onYes: () => void): void {
  const box = el<HTMLDivElement>("nav-ask");
  el<HTMLDivElement>("nav-ask-text").textContent = question;
  box.style.display = "block";
  el<HTMLDivElement>("nav-banner").classList.add("expanded");
  navAskYes = onYes;
}
let navAskYes: (() => void) | null = null;

function closeAsk(): void {
  el<HTMLDivElement>("nav-ask").style.display = "none";
  navAskYes = null;
}

/** Where we're going, for the arrival line. */
let navDestLabel: string | null = null;

/** Fit the map to a freshly planned route. A link is how routes are shared, and
 * the recipient of a 42 km route was left looking at the default view with 2% of
 * it on screen. Skipped while navigating, where the camera belongs to the rider. */
function frameRoute(option: RouteOption): void {
  if (store.navActive) return;
  const coords = option.payload.geojson.features.flatMap((f) =>
    f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
  );
  if (coords.length < 2) return;
  let w = Infinity;
  let sth = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < sth) sth = lat;
    if (lat > n) n = lat;
  }
  map.fitBounds(
    [
      [w, sth],
      [e, n],
    ],
    {
      // Leave room for the panel: a bottom sheet wherever the CSS makes it one
      // — sheetLayout is that same query, which includes a phone held sideways
      // (max-height: 500px); asking about width alone framed a landscape phone's
      // route with desktop padding, under the sheet — and down the left-hand
      // side on a desktop. The sheet stands at "half" once a route is shown
      // (revealSheet): 52% plus its own padding.
      padding: sheetLayout.matches
        ? { top: 40, bottom: Math.round(window.innerHeight * SHEET_HALF) + 40, left: 30, right: 30 }
        : { top: 60, bottom: 60, left: 380, right: 60 },
      duration: 700,
      maxZoom: 16,
    },
  );
}

/** Where the rider is, in words. The hazard dialog used to print raw decimal
 * degrees at them while the app already knew the street name. */
async function hereLabel(lon: number, lat: number): Promise<string> {
  const street = rideView.headline.street.trim();
  if (store.navActive && street && !/^[-–]$/.test(street) && !/^⚠/.test(street)) {
    return `on ${street}`;
  }
  const cls = await routing.edgeClassAt(lon, lat);
  return cls ? `on a ${cls.replace(/_/g, " ")}` : "at this spot";
}

/** A bearing as something sayable ("north-east"), for telling an off-route
 * rider which way the new route runs. */
function compassPoint(deg: number): string {
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8] ?? "on";
}

/** Shortest signed angle a -> b, in degrees. */
function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** One continuous loop drives the dot and the follow camera toward the latest
 * fix. Fixes arrive ~1/s; easing every frame keeps motion smooth instead of
 * teleporting the dot while a queue of 900 ms camera eases fight each other. */
function navAnimate(): void {
  navRaf = null;
  if (!store.navActive) return;
  if (navPosTarget) {
    const cur = navPosShown ?? navPosTarget;
    const k = 0.18; // keeps up with a fix/sec without looking twitchy
    const next: [number, number] = [
      cur[0] + (navPosTarget[0] - cur[0]) * k,
      cur[1] + (navPosTarget[1] - cur[1]) * k,
    ];
    navPosShown = distM(next, navPosTarget) < 0.3 ? navPosTarget : next;
    navDot?.setLngLat(navPosShown);
  }
  if (navFollowing && navPosShown && !navInteracting) {
    navBearingShown =
      (navBearingShown + angleDelta(navBearingShown, rideEngine.bearingTarget) * 0.12 + 360) % 360;
    const curZoom = map.getZoom();
    const zoom = navUserZoom ? curZoom : curZoom + (rideEngine.zoomTarget - curZoom) * 0.06;
    // Only touch the camera when something actually moved. jumpTo fires a full
    // movestart/zoomstart/moveend cycle, so writing every frame spams events
    // (and burns battery) even when the rider is sitting still at a light.
    const c = map.getCenter();
    const moved =
      Math.abs(c.lng - navPosShown[0]) > 1e-7 ||
      Math.abs(c.lat - navPosShown[1]) > 1e-7 ||
      Math.abs(angleDelta(map.getBearing(), navBearingShown)) > 0.05 ||
      Math.abs(zoom - curZoom) > 0.002;
    if (moved) {
      // Padding pushes the rider down the screen so the view is mostly the road
      // AHEAD: centred, ~60% of the display was ground already covered.
      map.jumpTo({
        center: navPosShown,
        bearing: navBearingShown,
        zoom,
        pitch: NAV_PITCH,
        padding: { top: Math.round(map.getCanvas().clientHeight * 0.34), bottom: 0, left: 0, right: 0 },
      });
    }
  }
  navRaf = requestAnimationFrame(navAnimate);
}

function navStartAnimation(): void {
  if (navRaf === null) navRaf = requestAnimationFrame(navAnimate);
}

function navStopAnimation(): void {
  if (navRaf !== null) cancelAnimationFrame(navRaf);
  navRaf = null;
  navPosShown = null;
  navPosTarget = null;
}

function navOnFix(fix: NativeFix): void {
  if (!store.navActive) return;
  const step = rideEngine.onFix(fix, Date.now());
  if (step === null) return;
  navLastPos = [fix.lon, fix.lat];
  // keep the ride recoverable: Back, a reload or a crash used to lose it all
  if (recorder && ++navFixesSinceStash >= STASH_EVERY_FIXES) {
    navFixesSinceStash = 0;
    stashInProgress(recorder.finish(store.profileId));
  }
  recorder?.addPoint(Date.now(), fix.lon, fix.lat, step.cls, step.alongM);
  navPosTarget = step.dot;
  if (!navDot) {
    const dot = document.createElement("div");
    dot.className = "nav-dot";
    navDot = new maplibregl.Marker({ element: dot }).setLngLat(navPosTarget).addTo(map);
    navPosShown = navPosTarget;
  }
  navStartAnimation();
  for (const effect of step.effects) applyRideEffect(effect);
  // dim the ridden part of the route so progress reads at a glance
  if (step.done !== null) {
    getSource("route-done").setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: step.done },
    } as GeoJSON.GeoJSON);
  }
}

function applyRideEffect(e: RideEffect): void {
  switch (e.type) {
    case "speak":
      speak(e.text, e.priority);
      return;
    case "vibrate":
      vibrate(e.pattern);
      return;
    case "alert":
      showRideAlert(e.text, e.kind);
      return;
    case "clearGpsAlert":
      if (el<HTMLDivElement>("nav-alert").classList.contains("gps")) hideRideAlert();
      return;
    case "hideAlert":
      hideRideAlert();
      return;
    case "offRoute":
      showHeadline({ icon: "↩", dist: "off route", street: "adjusting…" });
      return;
    case "banner":
      showBanner(e.maneuver, e.distToNextM);
      return;
    case "trip":
      showTrip(e);
      return;
    case "reroute":
      void rerouteFrom(e.from, e.heading);
      return;
    case "rejoined":
      rerouteLane.cancel();
      return;
    case "arrived":
      showArrival(e.atStop, e.totalM);
      return;
  }
}

/** A wrong turn: plan the way on from here, and say which way it goes. */
async function rerouteFrom(from: [number, number], heading: number | null): Promise<void> {
  const ride = rideLane.begin();
  const mine = rerouteLane.begin();
  const ticket: Ticket = { stale: () => ride.stale() || mine.stale() };
  try {
    const found = await rideOptionsFrom(from, heading ?? undefined);
    if (rideStale(ticket)) return;
    if (found !== null && !trip.publish(rideTicket(ticket), found)) return;
    const first = found?.[0];
    if (first) {
      selectOption(first.id);
      rebuildNavFromSelected();
      // tell the rider a new way exists and which way it goes, instead of
      // leaving "adjusting…" up while a fresh route sits undrawn-to
      const back = rideEngine.rejoinBearing();
      showRideAlert(
        back === null
          ? "⚠ off route — new route ready"
          : `⚠ off route — head ${compassPoint(back)} to rejoin`,
        "gps",
      );
    }
  } catch {
    if (rideStale(ticket)) return;
    showRideAlert("⚠ off route — no way back from here", "gps");
  }
}

function showArrival(atStop: boolean, totalM: number): void {
  if (atStop) {
    showHeadline({ icon: "🛑", dist: "At the stop", street: "tap ▶ resume to ride on" });
    el<HTMLButtonElement>("nav-resume").style.display = "inline-block";
    return;
  }
  showHeadline({ icon: "🏁", dist: "Arrived", street: navDestLabel ?? "you're there" });
  showTripLine({ remaining: `${fmtDist(totalM)} ridden`, speed: "" });
  hideRideAlert();
  finishAndSaveRide();
}

/** Which ride this is: a ride's startup waits (the wake lock, a permission
 * dialog), and one ended and followed by another in the meantime must not
 * carry on inside the new one. */
let rideGen = 0;

async function startNav(): Promise<void> {
  // a ride follows the streets as they are, never a what-if's proposed lane
  clearWhatIf();
  // and the main thread is the guidance's: a search list left open would go on
  // grading, up to five routing runs, while the rider is on the bike
  dropGrading();
  const chosen = trip.selected;
  navLoop = chosen !== undefined && chosen.id.startsWith("loop") ? chosen : null;
  rideEngine.start();
  if (!rebuildNavFromSelected()) return;
  const destLngLat = store.end?.getLngLat() ?? store.start?.getLngLat();
  if (!destLngLat) return;
  navDest = [destLngLat.lng, destLngLat.lat];
  // A round trip has no destination field of its own; the one on screen still
  // names wherever the rider last searched for.
  navDestLabel =
    navLoop !== null
      ? "back where you started"
      : el<HTMLInputElement>("search").value.trim().split(",")[0] || null;
  navOriginalDest = null;
  el<HTMLButtonElement>("nav-resume").style.display = "none";
  store.navActive = true;
  const ride = ++rideGen;
  navFollowing = true;
  navUserZoom = false;
  voiceWarned = false;
  navBearingShown = map.getBearing();
  recorder = new RideRecorder();
  document.body.classList.add("navigating");
  el<HTMLDivElement>("nav-banner").style.display = "block";
  setRecentreNeeded(false);
  map.setLayoutProperty("route-done", "visibility", "visible");
  // label-free basemap, our own upright labels, and the network dimmed behind
  // the route — all of which applyBasemap decides from navActive
  applyBasemap();
  // Said before anything is awaited. iOS lets a page speak only once speech was
  // started inside a tap, and the tap is over at the first await — this used to
  // come after the wake lock and the GPS watcher, which on an iPhone meant a
  // silent ride and a false "no voice on this phone" warning.
  speak("navigation started", "chat");
  keepScreenOn(true); // the app's window flag: a WebView may not honour the Wake Lock
  // unsupported or denied, navigation still works; taken again whenever the
  // page comes back into view (see lifecycle.ts)
  await screenLock.acquire();
  // Each wait is a moment the ride can end in (exit, or Back, pressed while a
  // permission dialog is up), and another begin. Starting a GPS watch or
  // pushing a Back guard for a ride already over left the phone tracking, and
  // a Back that did nothing; doing it inside the next ride pushed two.
  if (!store.navActive || ride !== rideGen) return;
  // Location last, permission first: on Android 14+ the background watcher's
  // foreground service cannot start without it (see navStartLocation).
  await navStartLocation(true);
  if (!store.navActive || ride !== rideGen) return;
  // absorb one Back press: on Android the hardware button is a thumb-brush from
  // ending the ride, and there was no guard of any kind
  history.pushState({ navigating: true }, "");
}

function exitNav(): void {
  store.navActive = false;
  rideLane.cancel();
  // the stops menu belongs to the ride; left open it floated over the planner
  stopsOpen(false);
  navOriginalDest = null;
  navLastPos = null;
  if (navWatchId !== null) navigator.geolocation.clearWatch(navWatchId);
  navWatchId = null;
  if (navBgWatcherId !== null) void stopBackgroundWatcher(navBgWatcherId);
  navBgWatcherId = null;
  screenLock.release();
  keepScreenOn(false);
  closeAsk();
  hideClassify();
  hideRideAlert();
  window.clearTimeout(navRefollowTimer);
  navStopAnimation();
  navDot?.remove();
  navDot = null;
  // the ride's own queue goes first, so the line that closes it is not
  // cancelled the moment it starts ("ride saved…" was queued, then cleared)
  clearSpeech();
  // Saving never stands in the way of the ride ending: an exception here used
  // to leave the ride screen up with the GPS and the wake lock still held.
  try {
    finishAndSaveRide();
  } catch (err) {
    console.warn("ride not saved", err);
  }
  document.body.classList.remove("navigating");
  el<HTMLDivElement>("nav-banner").style.display = "none";
  map.setLayoutProperty("route-done", "visibility", "none");
  applyBasemap(); // restores the network's normal opacity
  getSource("route-done").setData(emptyFC());
  const threeD = el<HTMLInputElement>("show-3d").checked;
  map.easeTo({ pitch: threeD ? 60 : 0, bearing: 0, duration: 800 });
  // a new build that arrived mid-ride is loaded now the ride is over
  if (swReload.waiting) window.setTimeout(() => swReload.idle(), RELOAD_AFTER_RIDE_MS);
  // The ride pushed a history entry to catch Back; left there, the next Back
  // after the ride only popped it, and did nothing a rider could see.
  if ((history.state as { navigating?: boolean } | null)?.navigating === true) {
    navHistoryUnwinding = true;
    history.back();
  }
}

/** Mid-ride detour: reroute to the nearest kid stop of a kind, remembering
 * the original destination for the resume button. */
async function detourToNearest(kind: "water" | "restroom" | "playground"): Promise<void> {
  if (!store.navActive || !store.routerReady || !navLastPos) return;
  const from = navLastPos;
  const candidates = store.pois.filter((p) => p.properties.kind === kind);
  const ticket = rideLane.begin();
  try {
    const idx = await routing.nearestReachable(
      from,
      candidates.map((p) => p.geometry.coordinates),
      store.profileId,
      store.preferFlat,
    );
    if (rideStale(ticket)) return;
    const poi = idx !== null ? candidates[idx] : undefined;
    if (!poi) {
      speak(`no ${kind === "water" ? "water fountain" : kind} found nearby`);
      return;
    }
    const found = await routing.plan(from, poi.geometry.coordinates, routePrefs());
    if (rideStale(ticket)) return;
    if (!trip.publish(rideTicket(ticket), found)) return;
    const first = found[0];
    if (!first) return;
    selectOption(first.id);
    if (navOriginalDest === null) navOriginalDest = navDest;
    navDest = poi.geometry.coordinates;
    rebuildNavFromSelected();
    // offer the way back immediately: this used to appear only on ARRIVAL at
    // the stop, so a mis-tapped detour couldn't be abandoned, and the voice
    // said "tap resume" for a button that wasn't on screen
    el<HTMLButtonElement>("nav-resume").style.display = "block";
    const label = poi.properties.name || POI_META[kind]?.label || kind;
    speak(
      `detour: ${label} is ${fmtDist(first.payload.summary.meters)} away. follow the route.`,
    );
  } catch {
    if (rideStale(ticket)) return;
    speak("could not plan a detour from here");
  }
}

el<HTMLButtonElement>("nav-water").addEventListener("click", () => {
  void detourToNearest("water");
});
el<HTMLButtonElement>("nav-restroom").addEventListener("click", () => {
  void detourToNearest("restroom");
});
el<HTMLButtonElement>("nav-playground").addEventListener("click", () => {
  void detourToNearest("playground");
});

el<HTMLButtonElement>("nav-resume").addEventListener("click", () => {
  void resumeRide();
});

/** Back to the ride from a detour: the destination, or what is left of the
 * loop. The detour stays what is being followed until the way back exists. */
async function resumeRide(): Promise<void> {
  if (!store.routerReady || !navLastPos || !navOriginalDest) return;
  const original = navOriginalDest;
  const ticket = rideLane.begin();
  try {
    const found = await rideOptionsFrom(navLastPos, undefined, { dest: original, onDetour: false });
    if (rideStale(ticket)) return;
    const first = found?.[0];
    if (!found || !first) throw new Error("no way back");
    if (!trip.publish(rideTicket(ticket), found)) return;
    navDest = original;
    navOriginalDest = null;
    selectOption(first.id);
    rebuildNavFromSelected();
    el<HTMLButtonElement>("nav-resume").style.display = "none";
    hideRideAlert();
    speak("back on the way. let's go!");
  } catch {
    if (rideStale(ticket)) return;
    // still on the detour
    speak("could not plan the way back from here");
  }
}

el<HTMLButtonElement>("nav-myway").classList.toggle("active", navMyWay);
el<HTMLButtonElement>("nav-myway").addEventListener("click", () => {
  navMyWay = !navMyWay;
  writeItem("navMyWay", navMyWay ? "1" : "0");
  el<HTMLButtonElement>("nav-myway").classList.toggle("active", navMyWay);
  speak(
    navMyWay
      ? "going your way: reroutes will follow your direction."
      : "back to safest: reroutes return to the safest path.",
  );
});

el<HTMLButtonElement>("nav-hazard").addEventListener("click", () => {
  if (!navLastPos) {
    // it did nothing at all with no fix yet — a dead button with no feedback
    showRideAlert("⚠ no position yet — can't mark this spot", "gps");
    return;
  }
  // Tapping again because nothing visible happened wrote a duplicate mark, and
  // marks can only be removed from the planning panel, which is hidden while
  // riding. Collapse repeats within a few metres.
  const already = store.sketchyMarks.some((m) => distM(m, navLastPos as [number, number]) < 15);
  if (!already) {
    store.sketchyMarks.push(navLastPos);
    saveSketchy(store.sketchyMarks);
    applyAvoidPoints();
    renderSketchy();
  }
  vibrate([80]);
  speak("marked. future routes will avoid this spot.", "chat");
  // confirm on screen too: muted, there was no sign it had worked
  showRideAlert(already ? "⚠️ already marked here" : "⚠️ marked — routes will avoid it");
  window.setTimeout(hideRideAlert, 4000);
});

// Units. Everything is metres underneath; this only changes what is shown and
// spoken, so switching re-renders rather than recomputing anything.
{
  const pref = el<HTMLSelectElement>("units-pref");
  pref.value = getUnits();
  const syncUnitLabels = (): void => {
    el<HTMLSpanElement>("loop-unit").textContent = unitShort();
    // the field's own limits, in the unit it's typed in (a phone keyboard and
    // the spinner arrows respect these; the check in the loop planner is the
    // one that holds)
    const loopDist = el<HTMLInputElement>("loop-dist");
    [loopDist.min, loopDist.max] = LOOP_LIMITS[getUnits()].map(String) as [string, string];
    // The walking budget is stored in metres (the router's unit) and its
    // options keep those values; only what they read as follows the rider.
    // Feet round to tens: "330 ft" is a figure, "328 ft" is a conversion.
    for (const opt of el<HTMLSelectElement>("walk-max").options) {
      const m = Number(opt.value);
      const ft = m * 3.28084;
      opt.textContent =
        getUnits() === "imperial" && ft < 1000 ? `${Math.round(ft / 10) * 10} ft` : fmtDistTight(m);
    }
    el<HTMLSpanElement>("shed-budget-label").textContent = fmtDistTight(
      Number(el<HTMLInputElement>("shed-budget").value) * 1000,
    );
  };
  syncUnitLabels();
  pref.addEventListener("change", () => {
    const wasM = toMeters(Number(el<HTMLInputElement>("loop-dist").value) || 0);
    setUnits(pref.value === "metric" ? "metric" : "imperial");
    void routing.configure(dataSource(), getUnits());
    syncUnitLabels();
    scaleBar.setUnit(getUnits());
    // the number in the box meant a distance, not a digit: keep the distance
    if (wasM > 0) {
      el<HTMLInputElement>("loop-dist").value = String(Math.round(fromMeters(wasM) * 10) / 10);
    }
    renderOptions();
    renderOptionChips();
    const sel = trip.selected;
    if (sel) showSummary(sel);
    renderPlacesAndRecent();
    renderRides();
  });
}

el<HTMLButtonElement>("nav-btn").addEventListener("click", () => {
  // first, inside the tap: without it an iPhone never speaks this page load
  speech.unlock();
  void startNav();
});
el<HTMLButtonElement>("nav-exit").addEventListener("click", () => {
  // it used to end the ride outright, and sat 9 px from the mute button
  askDuringRide("End the ride now?", exitNav);
});
el<HTMLButtonElement>("nav-ask-no").addEventListener("click", closeAsk);
el<HTMLButtonElement>("nav-ask-yes").addEventListener("click", () => {
  const yes = navAskYes;
  closeAsk();
  yes?.();
});
/** Whether recentring would do anything, shown by weight rather than presence.
 *
 * It used to be hidden while the camera was already following. In a row of five
 * that re-spaces the other four, so the target a rider was reaching for moves
 * under their thumb — the one thing a control in a moving vehicle must not do.
 */
function setRecentreNeeded(needed: boolean): void {
  const btn = el<HTMLButtonElement>("nav-recenter");
  btn.classList.toggle("idle", !needed);
  const label = needed ? "Recentre on me" : "Already following you";
  btn.setAttribute("aria-label", label);
  btn.title = label; // it said "Recentre on me" while the label said otherwise
}

// Layers: twelve of them, so a way back to the state someone can reason about.
// Everything routes through a change event rather than being set directly, so a
// reset takes exactly the path a tap does and can't drift from it.
const LAYER_DEFAULTS: Record<string, boolean> = {
  "show-net": true,
  "show-constr": true,
  "show-heat": false,
  "show-gates": false,
  "show-pois": false,
  "show-elev": false,
  "show-3d": false,
  "show-aerial": false,
  "show-lanes": false,
  "show-access": false,
  "show-build": false,
  // dark-mode is deliberately absent. It is the rider's setting, not a map
  // layer: resetting the layers on a night ride should not white out the
  // screen.
};

el<HTMLButtonElement>("layers-reset").addEventListener("click", () => {
  for (const [id, want] of Object.entries(LAYER_DEFAULTS)) {
    const box = document.getElementById(id) as HTMLInputElement | null;
    if (!box || box.checked === want) continue;
    box.checked = want;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  }
});

// The planner layers belong to a workspace of its own now, so the link leaves
// the rider's app rather than expanding a section inside it.

// The stops menu. The three detours were three of nine buttons in a drawer;
// they are one dock button and a menu that opens upward, out from under the
// thumb that just tapped it.
function stopsOpen(open: boolean): void {
  el<HTMLDivElement>("nav-stops-menu").style.display = open ? "flex" : "none";
  el<HTMLButtonElement>("nav-stops").setAttribute("aria-expanded", String(open));
}
el<HTMLButtonElement>("nav-stops").addEventListener("click", (e: Event) => {
  e.stopPropagation();
  stopsOpen(el<HTMLButtonElement>("nav-stops").getAttribute("aria-expanded") !== "true");
});
// Tapping the map puts it away (onMapTap, step 1).
for (const id of ["nav-water", "nav-restroom", "nav-playground"]) {
  el<HTMLButtonElement>(id).addEventListener("click", () => stopsOpen(false));
}
el<HTMLButtonElement>("nav-mute").addEventListener("click", () => {
  navMuted = !navMuted;
  const btn = el<HTMLButtonElement>("nav-mute");
  // the icon alone read as decoration at a glance; the word says which it is
  btn.querySelector(".dock-icon")!.textContent = navMuted ? "🔇" : "🔊";
  btn.querySelector(".dock-label")!.textContent = navMuted ? "muted" : "voice on";
  btn.classList.toggle("muted", navMuted);
  btn.setAttribute("aria-label", navMuted ? "Voice off — tap to turn on" : "Voice on — tap to mute");
  if (navMuted) clearSpeech();
});
el<HTMLButtonElement>("nav-recenter").addEventListener("click", () => {
  navFollowing = true;
  navUserZoom = false; // hand the zoom back to the follow camera
  setRecentreNeeded(false);
});
/** Set while exitNav steps back over the ride's history entry. */
let navHistoryUnwinding = false;
window.addEventListener("popstate", () => {
  if (!store.navActive) {
    if (navHistoryUnwinding) {
      navHistoryUnwinding = false;
      // back on the entry from before the ride, whose link may be older than
      // the plan now on screen (a reroute rewrote the ride's own entry)
      updateHash();
    }
    return;
  }
  // stay on the ride and ask, rather than silently leaving it
  history.pushState({ navigating: true }, "");
  askDuringRide("End the ride?", exitNav);
});

// Android's Back in the app. The popstate guard above is the website's; in the
// APK Back never reached it, so mid-ride it went home, it never closed a dialog,
// and on Android 7–11 it closed the app, stopping GPS and the voice with it.
// Now it puts away whatever is on top, asks before leaving a ride, and otherwise
// sends the app to the background the way Home does.
onAndroidBack(() => {
  const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  const topDialog = dialogs[dialogs.length - 1];
  if (topDialog !== undefined) {
    topDialog.close();
    return;
  }
  const popupClose = document.querySelector<HTMLButtonElement>(".maplibregl-popup-close-button");
  if (popupClose !== null) {
    popupClose.click();
    return;
  }
  if (el<HTMLButtonElement>("nav-stops").getAttribute("aria-expanded") === "true") {
    stopsOpen(false);
    return;
  }
  if (el<HTMLDivElement>("nav-ask").style.display === "block") {
    closeAsk(); // Back answers "no"
    return;
  }
  if (store.navActive) {
    askDuringRide("End the ride?", exitNav);
    return;
  }
  if (document.body.classList.contains("searching")) {
    (document.activeElement as HTMLElement | null)?.blur();
    leaveSearchMode(false);
    return;
  }
  if (store.shedMode) {
    exitShedMode();
    return;
  }
  minimizeApp();
});

map.on("dragstart", () => {
  if (store.navActive) {
    navFollowing = false;
    setRecentreNeeded(true);
    scheduleRefollow();
  }
});
// A pinch/scroll zoom while navigating is the rider deliberately looking
// further ahead — keep their zoom (the old code re-applied its own every fix,
// so zooming out snapped back within a second) until they tap recenter.
map.on("zoomstart", (e: { originalEvent?: unknown }) => {
  if (store.navActive && e.originalEvent) {
    navUserZoom = true;
    setRecentreNeeded(true);
  }
});
// The follow camera writes the map every animation frame, which would fight
// (and cancel) the rider's own pinch/scroll before MapLibre could even start
// the gesture. Back off the moment they touch the map, resume shortly after.
let navInteractTimer: number | undefined;
function pauseFollowForInput(): void {
  if (!store.navActive) return;
  navInteracting = true;
  scheduleRefollow();
  window.clearTimeout(navInteractTimer);
  navInteractTimer = window.setTimeout(() => {
    navInteracting = false;
  }, 500);
}

/** The rider took the zoom: keep it until they tap recenter (or until the
 * camera takes itself back — see scheduleRefollow). */
function takeZoomControl(): void {
  if (!store.navActive) return;
  navUserZoom = true;
  setRecentreNeeded(true);
  scheduleRefollow();
}

/** Hand the camera back to the route once the rider has stopped fiddling. */
function scheduleRefollow(): void {
  window.clearTimeout(navRefollowTimer);
  navRefollowTimer = window.setTimeout(() => {
    if (!store.navActive) return;
    navFollowing = true;
    navUserZoom = false;
    setRecentreNeeded(false);
  }, REFOLLOW_MS);
}

// Bound to the map's own input events, not a canvas listener (wheel/touch land
// on MapLibre's overlay containers, which don't bubble through the leaf canvas)
// and not to zoomstart (handler-driven zooms don't reliably carry originalEvent).
map.on("wheel", () => {
  pauseFollowForInput();
  takeZoomControl();
});
map.on("touchstart", (e: { originalEvent?: TouchEvent }) => {
  pauseFollowForInput();
  if ((e.originalEvent?.touches.length ?? 0) >= 2) takeZoomControl(); // pinch
});
map.on("mousedown", pauseFollowForInput);


// dark mode (night rides): app/dark-mode.ts

initDarkMode();

el<HTMLInputElement>("show-constr").addEventListener("change", (e: Event) => {
  const on = (e.target as HTMLInputElement).checked;
  for (const layer of ["construction-lines-base", "construction-lines", "construction-pts"]) {
    map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
  }
});

initSketchy();

// test hook: E2E (Playwright) asserts on live layer state through this
declare global {
  interface Window {
    /** Test hook: how many hazard warnings have been displayed. */
    __navAlertsSeen?: number;
    /** Test hook: how many times search-grading has actually started routing.
     *
     * Here for the same reason as the counter above. Grading is up to five
     * routing runs on the main thread, and it must never start mid-ride — but it
     * works on rows the panel has already replaced, so nothing about it is
     * visible in the DOM by then. The only other instrument was timing, and a
     * loaded machine blocks the main thread for longer than a routing run does,
     * so that test failed on the runner rather than on the app. */
    __regradesStarted?: number;
    /** Test hook: panel paints still watching the map for their route to draw.
     * Each watches every frame until it fires or is superseded, so one that
     * never stops is a leak; before this hook the test counted MapLibre's
     * private _listeners, which the next upgrade could quietly empty. */
    __panelPaintsWaiting?: number;
    /** Set as app.js starts running; compat.js reads it (see there). */
    __appStarted?: boolean;
    _map?: MLMap;
  }
}
window._map = map;

// start-up: recover an interrupted ride, then the update check and the service
// worker (app/app-update.ts)

// a ride interrupted by Back/reload/crash is saved on the next launch rather
// than silently lost
const interrupted = takeInProgress();
if (interrupted !== null) {
  saveRide(interrupted);
  renderRides();
}

initAppUpdate();
initMarkers();
initServiceWorker();


// "Where to build" — the city-facing view of pipeline/priorities.py: app/build-*.ts
initBuildControls();


// at boot, only the 2 KB metadata: it decides whether the section exists
ensureBuildMeta();
