// Frontend for the family bike router. Routing runs fully in the browser
// (see router.ts); class colors mirror pipeline/config.py.
import "./app/started.js";
import { reportCaught } from "./report.js";
import { links } from "./app/links.js";
import { AVOIDABLE, store } from "./app/store.js";
import { CLASS_MARKS, CONSTRUCTION_SWATCH, MARK_INK, NETWORK_MARK_LAYERS, POI_META, classSwatch, classWidth, constructionIcon } from "./app/classes.js";
import { el, emptyFC } from "./app/dom.js";
// the map is built by importing this: app/map.js
import { map } from "./app/map.js";
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent, MapMouseEvent, Popup } from "maplibre-gl";

import { maplibregl } from "./maplibre.js";
import { CLASS_LABELS, clearPhotoCache, FACILITY_CLASSES } from "./segment.js";
import { distM } from "./nav.js";
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
import { saveRide, takeInProgress } from "./rides.js";
import { type ComponentChild, h, render } from "preact";
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
import { readItem, removeItem, writeItem } from "./storage.js";
import type { ProtectionClass } from "./types.js";
import { applyBasemap, initDarkMode } from "./app/dark-mode.js";
import { ensureLayer } from "./app/sources.js";
import { constructionReady, dataProgress, initDataLoad, networkReady, poisData, refreshNetworkTiles } from "./app/data-load.js";
import { initRidesDialog, renderRides } from "./app/rides-dialog.js";
import { initAppInfo } from "./app/app-info.js";
import { initRouteExport } from "./app/route-export.js";
import { computeShed, exitShedMode, initShed } from "./app/shed.js";
import { applyAvoidPoints, initAvoid, syncAvoidSummary } from "./app/avoid.js";
import { initMarkers, setPoint, syncOD } from "./app/markers.js";
import { initSketchy, openSketchyPopup } from "./app/sketchy.js";
import { initPlaces } from "./app/places.js";
import { initAppUpdate, initServiceWorker } from "./app/app-update.js";
import { TAP_ORDER, type TapTarget, onTap, tapTargets } from "./app/taps.js";
import { ensureBuildMeta } from "./app/build-list.js";
import { initBuildControls } from "./app/build-controls.js";
import { initSearchResults } from "./app/search-results.js";
import { initSearchGrade, regradeVisible } from "./app/search-grade.js";
import { initPhoneSearch } from "./app/phone-search.js";
import { initSearchInput } from "./app/search-input.js";
import { initSheet, sheetLayout } from "./app/sheet.js";
import { initPermalink, parseHash, updateHash } from "./app/permalink.js";
import { initPlanOptions } from "./app/plan-options.js";
import { initPlanRoute, requestRoute } from "./app/plan-route.js";
import { initPlanControls } from "./app/plan-controls.js";
import { nav } from "./app/nav-state.js";
import { initNavVoice, speak, vibrate } from "./app/nav-voice.js";
import { askDuringRide, hideRideAlert, initNavBanner, showRideAlert, stopsOpen } from "./app/nav-banner.js";
import { hereLabel, initNavCamera } from "./app/nav-camera.js";
import { initNavLocation } from "./app/nav-location.js";
import { exitNav, initNavSession } from "./app/nav-session.js";
import { initNavControls } from "./app/nav-controls.js";
import { initNavRide } from "./app/nav-ride.js";

// The functions other modules call through src/app/links.ts, set before anything at
// start-up runs. Four are function declarations still in this module (dropHoverCard,
// hideClassify, openHazardDialog, refreshHazards), so they exist from the moment it
// runs. The inits set the hooks of modules that moved: regradeVisible, the search
// list's chooseSearchRow and saveSearchRow, the planner's requestRoute, planBetween,
// beginPlan and selectOption, and the ride's rebuildNavFromSelected and replanRide.
// More are set by their modules' own inits further down and reached only by an event
// or after a plan has arrived: renderSketchy (a backup restore), leaveSearchMode
// (choosing a search row), updateHash (choosing an option), resetPlan (the address
// changing), frameRoute (a route drawn) and showArrival (the rider arriving).
links.dropHoverCard.set(dropHoverCard);
links.hideClassify.set(hideClassify);
links.openHazardDialog.set(openHazardDialog);
links.refreshHazards.set(refreshHazards);
initSearchGrade();
initSearchResults();
initPlanRoute();
initPlanOptions();
initNavRide();


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

initDataLoad();

initAvoid();


// The street card's photo on a hover is fetched once the pointer rests on a segment.
let segPhotoTimer: number | undefined;


// GPX, cue sheet and the offline map download: app/route-export.ts

initRouteExport();


// URL hash permalinks (#s=lon,lat&e=lon,lat&m=profile&f=1): app/permalink.ts
initPermalink();


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


// ---------------------------------------------------------------------------
// hazard reports (category + note + photo), stored on-device
// ---------------------------------------------------------------------------

/** The hazard reports' photos as the hover card shows them (src/photourls.ts):
 * read from the device once per report, tried again if a read failed, and let
 * go with the report. */
const hazardPhotos = new PhotoUrls(getHazardPhoto);

/** The newest refresh wins: a slow older read must not put an older list back over a
 * newer one (a backup restore while the start-up read is still waiting). */
let hazardsGen = 0;

async function refreshHazards(): Promise<void> {
  const gen = ++hazardsGen;
  let list: HazardReport[];
  try {
    list = await listHazards();
  } catch (err) {
    // neither the database nor its mirror could be read: nothing to avoid is known, and
    // that is worth knowing about
    reportCaught("error", err);
    list = [];
  }
  if (gen !== hazardsGen) return;
  store.hazards = list;
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
    if (nav.lastPos) openHazardDialog(nav.lastPos[0], nav.lastPos[1]);
    return;
  }
  const at = nav.lastPos;
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

// turn-by-turn navigation: follows the GPS along the selected route, with a banner,
// voice instructions, wake lock and automatic rerouting: app/nav-*.ts
initNavSession();
initNavVoice();


initNavBanner();

initNavLocation();


initNavControls();


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
