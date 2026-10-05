// Frontend for the family bike router. Routing runs fully in the browser
// (see router.ts); class colors mirror pipeline/config.py.
import "./app/started.js";
import { links } from "./app/links.js";
// the map is built by importing this: app/map.js
import { map } from "./app/map.js";

import { initDarkMode } from "./app/dark-mode.js";
import { initDataLoad } from "./app/data-load.js";
import { initRidesDialog, recoverInterruptedRide } from "./app/rides-dialog.js";
import { initAppInfo } from "./app/app-info.js";
import { initRouteExport } from "./app/route-export.js";
import { initShed } from "./app/shed.js";
import { initAvoid } from "./app/avoid.js";
import { initMarkers } from "./app/markers.js";
import { initSketchy } from "./app/sketchy.js";
import { initPlaces } from "./app/places.js";
import { initAppUpdate, initServiceWorker } from "./app/app-update.js";
import { ensureBuildMeta } from "./app/build-list.js";
import { initBuildControls } from "./app/build-controls.js";
import { initSearchResults } from "./app/search-results.js";
import { initSearchGrade } from "./app/search-grade.js";
import { initPhoneSearch } from "./app/phone-search.js";
import { initSearchInput } from "./app/search-input.js";
import { initSheet } from "./app/sheet.js";
import { initPermalink } from "./app/permalink.js";
import { initPlanOptions } from "./app/plan-options.js";
import { initPlanRoute } from "./app/plan-route.js";
import { initPlanControls } from "./app/plan-controls.js";
import { initNavVoice } from "./app/nav-voice.js";
import { initNavBanner } from "./app/nav-banner.js";
import { initNavCamera } from "./app/nav-camera.js";
import { initNavLocation } from "./app/nav-location.js";
import { initNavSession } from "./app/nav-session.js";
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
import { initAreaCards, initHoverCards } from "./app/hover-cards.js";
import { initSegmentHover } from "./app/hover-segment.js";
import { initLayerData } from "./app/layer-data.js";
import { dropHoverCard } from "./app/hover-state.js";
import { initMapTaps } from "./app/map-taps.js";
import { initLayerToggles } from "./app/layer-toggles.js";
import { initRiderPrefs } from "./app/rider-prefs.js";
import { initPageChrome } from "./app/page-chrome.js";
import { initFirstRun } from "./app/first-run.js";
import { exposeMapToTests } from "./app/test-hooks.js";

// The functions other modules call through src/app/links.ts, set before anything at
// start-up runs. One, dropHoverCard, is imported from app/hover-state.ts, so it exists
// before anything here runs. The inits set the hooks of modules that moved:
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

// The order here is the order the layers are stacked in (a layer added later is drawn over
// the ones before it), and, for the cards, the order their handlers run in: where a street
// and an overlay are under the pointer, the overlay's card is the one shown. Keep both when
// adding to it.
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
  initAreaCards();
  initLayerData();
});

initMapTaps();
initSheet();
initFirstRun();
initPhoneSearch(); // search on a phone
initPlaces();
initPlanControls();
initLayerToggles();
initRiderPrefs();
initSearchInput();
initPageChrome();

// dialogs
initRidesDialog();
initAppInfo();

// turn-by-turn navigation: follows the GPS along the selected route, with a banner,
// voice instructions, wake lock and automatic rerouting
initNavSession();
initNavVoice();
initNavBanner();
initNavLocation();
initNavControls();
initUnitsPref();
initNavCamera();

initDarkMode(); // night rides
initSketchy();
exposeMapToTests();

// start-up: recover an interrupted ride, then the update check and the service worker
recoverInterruptedRide();
initAppUpdate();
initMarkers();
initServiceWorker();

// "Where to build", the city-facing view of pipeline/priorities.py
initBuildControls();
ensureBuildMeta(); // at boot only the 2 KB of metadata, which decides whether the section exists
