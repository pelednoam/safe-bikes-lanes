// Frontend for the family bike router. Routing runs fully in the browser
// (see router.ts); class colors mirror pipeline/config.py.
import "./app/started.js";
import { links } from "./app/links.js";
import { AVOIDABLE, store } from "./app/store.js";
import { CONSTRUCTION_SWATCH, NETWORK_MARK_LAYERS, classSwatch } from "./app/classes.js";
import { el } from "./app/dom.js";
// the map is built by importing this: app/map.js
import { map } from "./app/map.js";
import type { Map as MLMap, MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";

import { CLASS_LABELS, clearPhotoCache } from "./segment.js";
import { saveRide, takeInProgress } from "./rides.js";
import { readItem, removeItem, writeItem } from "./storage.js";
import type { ProtectionClass } from "./types.js";
import { applyBasemap, initDarkMode } from "./app/dark-mode.js";
import { ensureLayer } from "./app/sources.js";
import { initDataLoad, refreshNetworkTiles } from "./app/data-load.js";
import { initRidesDialog, renderRides } from "./app/rides-dialog.js";
import { initAppInfo } from "./app/app-info.js";
import { initRouteExport } from "./app/route-export.js";
import { computeShed, exitShedMode, initShed } from "./app/shed.js";
import { initAvoid, syncAvoidSummary } from "./app/avoid.js";
import { initMarkers, setPoint, syncOD } from "./app/markers.js";
import { initSketchy, openSketchyPopup } from "./app/sketchy.js";
import { initPlaces } from "./app/places.js";
import { initAppUpdate, initServiceWorker } from "./app/app-update.js";
import { TAP_ORDER, type TapTarget, tapTargets } from "./app/taps.js";
import { ensureBuildMeta } from "./app/build-list.js";
import { initBuildControls } from "./app/build-controls.js";
import { initSearchResults } from "./app/search-results.js";
import { initSearchGrade, regradeVisible } from "./app/search-grade.js";
import { initPhoneSearch } from "./app/phone-search.js";
import { initSearchInput } from "./app/search-input.js";
import { initSheet, sheetLayout } from "./app/sheet.js";
import { initPermalink, updateHash } from "./app/permalink.js";
import { initPlanOptions } from "./app/plan-options.js";
import { initPlanRoute, requestRoute } from "./app/plan-route.js";
import { initPlanControls } from "./app/plan-controls.js";
import { initNavVoice } from "./app/nav-voice.js";
import { askDuringRide, initNavBanner, stopsOpen } from "./app/nav-banner.js";
import { initNavCamera } from "./app/nav-camera.js";
import { initNavLocation } from "./app/nav-location.js";
import { exitNav, initNavSession } from "./app/nav-session.js";
import { initNavControls } from "./app/nav-controls.js";
import { initNavRide } from "./app/nav-ride.js";
import { initUnitsPref } from "./app/units-pref.js";
import { initPlanLoop } from "./app/plan-loop.js";
import { initHazardDialog } from "./app/hazard-dialog.js";
import { initHazardBlocked } from "./app/hazard-blocked.js";
import { initBasemapLayers } from "./app/basemap-layers.js";
import { initGatewayLayer, initOverlayLayers } from "./app/overlay-layers.js";
import { initNetworkLayers, initStreetLabels } from "./app/network-layers.js";
import { initHistoryLayers, initRouteLayers } from "./app/route-layers.js";
import { initConstructionLayers } from "./app/construction-layers.js";
import { initHazardLayers } from "./app/hazard-layers.js";
import { initBuildLayers } from "./app/build-layers.js";
import { initPoiLayers } from "./app/poi-layers.js";
import { initHoverCards } from "./app/hover-cards.js";
import { initSegmentHover } from "./app/hover-segment.js";
import { initLayerData } from "./app/layer-data.js";
import { dropHoverCard } from "./app/hover-state.js";

// The functions other modules call through src/app/links.ts, set before anything at
// start-up runs. One is a function declaration still in this module (dropHoverCard), so
// it exists from the moment it runs. The inits set the hooks of modules that moved:
// regradeVisible, the search list's chooseSearchRow and saveSearchRow, the planner's
// requestRoute, planBetween, beginPlan, selectOption and requestLoop, the ride's
// rebuildNavFromSelected and replanRide, and the hazard dialog's refreshHazards,
// openHazardDialog and hideClassify. More are set by their modules' own inits further
// down and reached only by an event or after a plan has arrived: renderSketchy (a backup
// restore), leaveSearchMode (choosing a search row), updateHash (choosing an option),
// resetPlan (the address changing), frameRoute (a route drawn) and showArrival (the rider
// arriving).
links.dropHoverCard.set(dropHoverCard);
initHazardDialog();
initHazardBlocked();
initSearchGrade();
initSearchResults();
initPlanRoute();
initPlanOptions();
initPlanLoop();
initNavRide();

initDataLoad();

initAvoid();




// GPX, cue sheet and the offline map download: app/route-export.ts

initRouteExport();


// URL hash permalinks (#s=lon,lat&e=lon,lat&m=profile&f=1): app/permalink.ts
initPermalink();


// the reach map: app/shed.ts

initShed();


// ---------------------------------------------------------------------------
// layers + interaction wiring
// ---------------------------------------------------------------------------

map.on("load", () => {
  initBasemapLayers();
  initOverlayLayers();
  initNetworkLayers();
  initRouteLayers();
  initConstructionLayers();
  initHazardLayers();
  initHistoryLayers();
  initGatewayLayer();
  initStreetLabels();
  initBuildLayers();
  initPoiLayers();
  initHoverCards();
  initSegmentHover();
  initLayerData();
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

initPlanControls();

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


// hazard reports: app/hazard-dialog.ts

// ── reporting a hazard mid-ride: file first, ask after ────────────────────
// The dialog (category, note, photo) is still how you report from the planning
// map, where you can read and type. Riding, it was three taps and a form at
// 12 km/h, so nobody used it.


// ride history dialog: app/rides-dialog.ts

initRidesDialog();

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

// turn-by-turn navigation: follows the GPS along the selected route, with a banner,
// voice instructions, wake lock and automatic rerouting: app/nav-*.ts
initNavSession();
initNavVoice();

initNavBanner();

initNavLocation();

initNavControls();
initUnitsPref();


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

initNavCamera();


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
