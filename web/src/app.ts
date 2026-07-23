// Frontend for the family bike router. Routing runs fully in the browser
// (see router.ts); class colors mirror pipeline/config.py.
import type {
  GeoJSONSource,
  LngLat,
  Map as MLMap,
  MapLayerMouseEvent,
  MapMouseEvent,
  Marker,
  Popup,
} from "maplibre-gl";

import type { NativeFix } from "./native.js";
import {
  isNativeApp,
  isNewerAppVersion,
  nativeSpeak,
  openExternal,
  startBackgroundWatcher,
  stopBackgroundWatcher,
} from "./native.js";
import type { Maneuver, RideAlert, Track } from "./nav.js";
import {
  bearingDeg,
  buildAlerts,
  buildManeuvers,
  buildTrack,
  distM,
  snapToTrack,
  sunsetTime,
  trackBearing,
} from "./nav.js";
import type { HazardCategory, HazardReport } from "./hazards.js";
import {
  addHazard,
  buildReportText,
  downscalePhoto,
  getHazardPhoto,
  HAZARD_LABELS,
  listHazards,
  removeHazard,
} from "./hazards.js";
import type { RecentRoute, SavedPlace } from "./places.js";
import {
  clearRecent,
  deletePlace,
  emojiFor,
  listPlaces,
  listRecent,
  pushRecent,
  savePlace,
} from "./places.js";
import type { RideSummary } from "./rides.js";
import {
  clearRides,
  deleteRide,
  loadRides,
  RideRecorder,
  rideTotals,
  saveRide,
} from "./rides.js";
import { initDataSource, loadJson, usingRemoteData } from "./data.js";
import { buildCues, PROFILES, Router, toGPX } from "./router.js";
import { bboxOf, NetworkTiles, TileStore } from "./tiles.js";
import { drawRideCard, drawTotalsCard, rideShareText, totalsShareText } from "./sharecard.js";
import type {
  PoiFeature,
  ProfileId,
  ProtectionClass,
  RouteOption,
  RouteSummary,
  SafetyGrade,
} from "./types.js";

declare const maplibregl: typeof import("maplibre-gl");

interface NominatimResult {
  display_name: string;
  lon: string;
  lat: string;
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const CLASS_LABELS: Record<ProtectionClass, string> = {
  path: "off-street path",
  separated: "separated lane",
  buffered: "buffered lane",
  quiet_street: "quiet street",
  service: "alley/service",
  lane: "painted lane",
  sharrow: "sharrow",
  moderate_street: "moderate street",
  busy_street: "busy street",
};

const CLASS_COLORS: Record<ProtectionClass, string> = {
  path: "#1a9850",
  separated: "#66bd63",
  buffered: "#a6d96a",
  quiet_street: "#d9ef8b",
  service: "#d9ef8b",
  lane: "#fee08b",
  sharrow: "#fdae61",
  moderate_street: "#f46d43",
  busy_street: "#d73027",
};

/** What each class means for riding with kids, in plain words. */
const CLASS_SAFETY: Record<ProtectionClass, string> = {
  path: "off-street — no car traffic at all",
  separated: "physically protected from car traffic",
  buffered: "painted buffer only — no physical protection",
  quiet_street: "low-traffic residential street, riding with cars",
  service: "alley / service way, occasional vehicles",
  lane: "paint only, directly beside moving traffic",
  sharrow: "shared with car traffic, marking only",
  moderate_street: "no bike facility, moderate traffic",
  busy_street: "no protection on a busy street",
};

/** Segment grade on the same kid-stress scale used for whole routes. */
function classGrade(cls: ProtectionClass): SafetyGrade {
  const m = PROFILES.young_kids.mult[cls];
  return m <= 1.6 ? "A" : m <= 2.4 ? "B" : m <= 4 ? "C" : m <= 8 ? "D" : "F";
}

const GRADE_COLORS: Record<SafetyGrade, string> = {
  A: "#1a9850",
  B: "#66bd63",
  C: "#fdae61",
  D: "#f46d43",
  F: "#d73027",
};

const POI_META: Record<string, { emoji: string; label: string; color: string }> = {
  playground: { emoji: "🛝", label: "playground", color: "#e67e22" },
  ice_cream: { emoji: "🍦", label: "ice cream", color: "#e84393" },
  library: { emoji: "📚", label: "library", color: "#8e44ad" },
  water: { emoji: "🚰", label: "water fountain", color: "#2980b9" },
  restroom: { emoji: "🚻", label: "restroom", color: "#7f8c8d" },
};

const BBOX = { west: -71.32, south: 42.20, east: -70.93, north: 42.51 } as const;
const SKETCHY_KEY = "sketchyMarks";
const DARK_KEY = "darkMode";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
}

function fmtDist(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function loadSketchy(): [number, number][] {
  try {
    const raw = localStorage.getItem(SKETCHY_KEY);
    if (raw === null) return [];
    return JSON.parse(raw) as [number, number][];
  } catch {
    return [];
  }
}

function saveSketchy(marks: [number, number][]): void {
  localStorage.setItem(SKETCHY_KEY, JSON.stringify(marks));
}

// ---------------------------------------------------------------------------
// map setup
// ---------------------------------------------------------------------------

const map: MLMap = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
  center: [-71.105, 42.383],
  zoom: 13,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(
  new maplibregl.GeolocateControl({
    trackUserLocation: true,
    positionOptions: { enableHighAccuracy: true },
    fitBoundsOptions: { maxZoom: 16.5 },
  }),
  "top-right",
);
map.addControl(new maplibregl.ScaleControl({}), "bottom-left");

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let router: Router | null = null;
let start: Marker | null = null;
let end: Marker | null = null;
// Google-Maps-style flow: origin defaults to the current location; the next
// map tap fills the destination unless the user is explicitly picking a start.
let fromCurrent = true;
let activeField: "start" | "end" = "end";
let poiMarker: Marker | null = null;
let shedMarker: Marker | null = null;
let profileId: ProfileId = "young_kids";
let preferFlat = false;
let walkMaxM = 0;
const AVOIDABLE: [ProtectionClass, string][] = [
  ["lane", "painted lanes"],
  ["buffered", "buffered lanes"],
  ["sharrow", "sharrows"],
  ["moderate_street", "moderate streets"],
  ["busy_street", "busy streets"],
];
let avoidTypes = new Set<ProtectionClass>(
  JSON.parse(localStorage.getItem("avoidTypes") ?? "[]") as ProtectionClass[],
);

function syncAvoidSummary(): void {
  el<HTMLElement>("avoid-summary").textContent =
    avoidTypes.size === 0 ? "🛡 avoid lane types" : `🛡 avoiding ${avoidTypes.size} lane type${avoidTypes.size > 1 ? "s" : ""}`;
}
let hoverPopup: Popup | null = null;
let options: RouteOption[] = [];
let selectedId: RouteOption["id"] | null = null;
let shedMode = false;
let shedCenter: [number, number] | null = null;
let sketchyMarks: [number, number][] = loadSketchy();
let pois: PoiFeature[] = [];
let hazards: HazardReport[] = [];
let mapillaryToken = "";
interface ConstructionFC {
  features: {
    geometry: { type: string; coordinates: unknown };
    properties: { src: string; name: string; detail?: string; start: string; end: string };
  }[];
}
let constructionFC: ConstructionFC | null = null;

/** Sample construction geometries into avoid-points for the router. */
function constructionAvoidPoints(fc: ConstructionFC): [number, number][] {
  const pts: [number, number][] = [];
  const pushCoord = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      pts.push([c[0], c[1]]);
    }
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === "Point") pushCoord(g.coordinates);
    else if (g.type === "LineString" && Array.isArray(g.coordinates)) {
      for (const c of g.coordinates) pushCoord(c);
    } else if (Array.isArray(g.coordinates)) {
      for (const part of g.coordinates) {
        if (Array.isArray(part)) for (const c of part) pushCoord(c);
      }
    }
  }
  return pts;
}
let hazardPendingLoc: [number, number] | null = null;
let hazardPhoto: Blob | null = null;

/** Routes avoid both quick sketchy marks and full hazard reports. */
function applyAvoidPoints(): void {
  router?.setSketchyMarks([
    ...sketchyMarks,
    ...hazards.map((h): [number, number] => [h.lon, h.lat]),
  ]);
}
let loopParams: { km: number; kind: string } | null = null;
let pendingSelect: RouteOption["id"] | null = null;

const dataReady: Promise<void> = initDataSource();

// first launch after a website data refresh downloads layers from the site;
// surface that as progress (native only — bundled loads are instant)
const DATA_STEPS = 4; // tile manifest + network + pois + construction (overlays are lazy)
let dataDone = 0;
function dataProgress(): void {
  if (usingRemoteData() === null) return;
  dataDone += 1;
  const box = el<HTMLDivElement>("data-update");
  if (dataDone >= DATA_STEPS) box.style.display = "none";
  else {
    box.textContent = `\u2b07 Updating map data\u2026 ${dataDone}/${DATA_STEPS}`;
    box.style.display = "block";
  }
}
void dataReady.then(() => {
  if (usingRemoteData() !== null) {
    const box = el<HTMLDivElement>("data-update");
    box.textContent = "\u2b07 Updating map data\u2026";
    box.style.display = "block";
  }
});

// Routing graph is tiled (pipeline/export_web.py): the browser loads only the
// tiles covering a route's corridor, so coverage can scale toward all of MA
// without a giant download. The Router is (re)built over whatever tiles are
// loaded; ensureRouter fetches the ones a given area needs first.
const tiles = new TileStore(loadJson);
let builtTileCount = -1;

/** Fetch the tiles covering `points` (± padM metres, plus a margin), then
 * return a Router built over the current tile set — rebuilt only when the
 * loaded set actually grew. Null if the area has no mapped tiles. */
async function ensureRouter(
  points: [number, number][],
  padM: number,
  margin = 1,
): Promise<Router | null> {
  await manifestReady;
  await tiles.ensure(bboxOf(points, padM), margin);
  if (tiles.loadedCount === 0) return null;
  if (router === null || builtTileCount !== tiles.loadedCount) {
    router = new Router(tiles.assemble());
    builtTileCount = tiles.loadedCount;
    applyAvoidPoints();
    if (constructionFC) router.setConstructionPoints(constructionAvoidPoints(constructionFC));
    renderSketchy();
  }
  return router;
}

const manifestReady: Promise<void> = dataReady
  .then(() => tiles.loadManifest())
  .then(() => {
    void refreshHazards();
    el<HTMLDivElement>("loading").style.display = "none";
    dataProgress();
  })
  .catch((err: unknown) => {
    const errBox = el<HTMLDivElement>("error");
    errBox.textContent = `failed to load routing tiles: ${String(err)}`;
    errBox.style.display = "block";
    dataProgress();
  });
el<HTMLDivElement>("loading").textContent = "loading map…";
el<HTMLDivElement>("loading").style.display = "block";

// The display network also tiles, but loads by VIEWPORT rather than by route
// corridor (it's shown by default across the whole visible area). Below this
// zoom individual streets aren't legible and the viewport spans too many
// tiles, so the layer clears — pan/zoom in and it repopulates.
const NET_MIN_ZOOM = 12;
const netTiles = new NetworkTiles(loadJson);
const networkReady: Promise<void> = dataReady.then(() => netTiles.loadManifest());
let netToken = 0;

/** Fill the network source with the streets in the current viewport. */
async function refreshNetworkTiles(): Promise<void> {
  await networkReady;
  const src = map.getSource("network") as GeoJSONSource | undefined;
  if (!src) return;
  if (map.getZoom() < NET_MIN_ZOOM) {
    src.setData(emptyFC());
    return;
  }
  const b = map.getBounds();
  const box = {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  };
  const token = ++netToken;
  const features = await netTiles.visibleFeatures(box, 1);
  if (token !== netToken) return; // a newer move superseded this fetch
  src.setData({ type: "FeatureCollection", features });
}
map.on("moveend", () => void refreshNetworkTiles());

void dataReady
  .then(() => loadJson<{ mapillary?: string }>("keys.json"))
  .then((keys) => {
    mapillaryToken = localStorage.getItem("mapillaryToken") ?? keys.mapillary ?? "";
  })
  .catch(() => undefined);

const constructionReady: Promise<void> = dataReady
  .then(() => loadJson<ConstructionFC>("construction.geojson"))
  .then((fc) => {
    constructionFC = fc;
  })
  .catch(() => undefined);

// apply construction avoidance to the live Router as soon as the zones load
void constructionReady.then(() => {
  if (router && constructionFC) {
    router.setConstructionPoints(constructionAvoidPoints(constructionFC));
  }
});

const poisReady: Promise<void> = dataReady
  .then(() => loadJson<{ features: PoiFeature[] }>("pois.geojson"))
  .then((fc) => {
    pois = fc.features;
  })
  .catch(() => undefined);

function getSource(id: string): GeoJSONSource {
  const src = map.getSource(id);
  if (src === undefined) throw new Error(`missing source ${id}`);
  return src as GeoJSONSource;
}

// Heavy overlays load their data the first time they're shown, not at startup.
const LAZY_LAYER_FILES: Record<string, string> = {
  heatmap: "heatmap.geojson",
  lanemap: "lanemap.geojson",
  elevmap: "elevation.geojson",
  gateways: "gateways.geojson",
};
const lazyLoaded = new Set<string>();

/** Fetch an overlay's data once, the first time its toggle is turned on. */
function ensureLayer(id: string): void {
  const file = LAZY_LAYER_FILES[id];
  if (file === undefined || lazyLoaded.has(id)) return;
  lazyLoaded.add(id);
  void dataReady
    .then(() => loadJson<GeoJSON.GeoJSON>(file))
    .then((d) => {
      (map.getSource(id) as GeoJSONSource).setData(d);
    })
    .catch(() => {
      lazyLoaded.delete(id); // let a later toggle retry
    });
}

function currentPosition(): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("no geolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.longitude, p.coords.latitude]),
      (err) => reject(err instanceof Error ? err : new Error(String(err.message))),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  });
}

/** Reflect the origin state in the From field. */
function syncOD(): void {
  const f = el<HTMLButtonElement>("from-field");
  if (f.classList.contains("picking")) return;
  el<HTMLElement>("from-label").textContent = fromCurrent ? "Your location" : "Custom start";
  f.classList.toggle("custom", !fromCurrent);
}

function makeMarker(lngLat: LngLat | [number, number], color: string, label: string): Marker {
  const m = new maplibregl.Marker({ color, draggable: true });
  m.setLngLat(lngLat).addTo(map);
  m.getElement().title = `${label} (drag to move)`;
  m.on("dragend", () => {
    void requestRoute();
  });
  return m;
}

function setPoint(kind: "start" | "end", lngLat: LngLat | [number, number]): void {
  if (kind === "start") {
    fromCurrent = false;
    el<HTMLButtonElement>("from-field").classList.remove("picking");
    if (start) start.setLngLat(lngLat);
    else start = makeMarker(lngLat, "#2b83ba", "start");
  } else {
    if (end) end.setLngLat(lngLat);
    else end = makeMarker(lngLat, "#d7191c", "end");
  }
  syncOD();
  void requestRoute();
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

async function requestRoute(): Promise<void> {
  if (!end) return;
  await manifestReady;
  const errBox = el<HTMLDivElement>("error");
  errBox.style.display = "none";
  const loading = el<HTMLDivElement>("loading");
  if (!start) {
    if (!fromCurrent) return;
    loading.textContent = "finding your location…";
    loading.style.display = "block";
    try {
      start = makeMarker(await currentPosition(), "#2b83ba", "start");
      syncOD();
    } catch {
      loading.style.display = "none";
      errBox.textContent =
        "Couldn't get your location — tap \u201c\ud83d\udccd From\u201d to set a start, or enable location access.";
      errBox.style.display = "block";
      return;
    }
  }
  loading.textContent = "routing…";
  loading.style.display = "block";
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const s = start.getLngLat();
    const d = end.getLngLat();
    const a: [number, number] = [s.lng, s.lat];
    const b: [number, number] = [d.lng, d.lat];
    poiMarker?.remove();
    poiMarker = null;
    loopParams = null;
    // load the tiles along the corridor, then route; a safe route can detour
    // well outside the straight A–B box, so widen the loaded area once if the
    // first attempt finds nothing.
    const route = (r: Router): RouteOption[] =>
      r.routeOptions(a, b, profileId, preferFlat, undefined, avoidTypes, walkMaxM);
    let r = await ensureRouter([a, b], 1200, 1);
    try {
      if (!r) throw new Error("unmapped");
      options = route(r);
      if (!options.length) throw new Error("no route");
    } catch {
      r = await ensureRouter([a, b], 5000, 2);
      if (!r) throw new Error("this area isn't mapped for routing yet");
      options = route(r);
    }
    const fallback = options[0];
    if (!fallback) throw new Error("no route found");
    const wanted = pendingSelect;
    pendingSelect = null;
    selectOption(wanted !== null && options.some((o) => o.id === wanted) ? wanted : fallback.id);
    recordRecentRoute([s.lng, s.lat], [d.lng, d.lat]);
    revealSheet();
  } catch (err) {
    options = [];
    selectedId = null;
    renderOptions();
    clearOptionChips();
    errBox.textContent = err instanceof Error ? err.message : String(err);
    errBox.style.display = "block";
  } finally {
    loading.style.display = "none";
  }
}

async function requestLoop(): Promise<void> {
  await manifestReady;
  const errBox = el<HTMLDivElement>("error");
  errBox.style.display = "none";
  if (!start) {
    errBox.textContent = "click the map to set a start point first";
    errBox.style.display = "block";
    return;
  }
  await poisReady;
  const km = Number(el<HTMLSelectElement>("loop-dist").value);
  const kind = el<HTMLSelectElement>("loop-stop").value;
  const candidates = kind === "any" ? pois : pois.filter((p) => p.properties.kind === kind);
  const loading = el<HTMLDivElement>("loading");
  loading.textContent = "planning loop…";
  loading.style.display = "block";
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const s = start.getLngLat();
    // a loop can range out to roughly half its length from the start
    const r = await ensureRouter([[s.lng, s.lat]], km * 500, 2);
    if (!r) throw new Error("this area isn't mapped for routing yet");
    const { option, poi } = r.loopRoute(
      [s.lng, s.lat],
      km * 1000,
      candidates,
      profileId,
      preferFlat,
    );
    end?.remove();
    end = null;
    options = [option];
    loopParams = { km, kind };
    selectOption("loop");
    poiMarker?.remove();
    poiMarker = new maplibregl.Marker({ color: "#e67e22" })
      .setLngLat(poi.geometry.coordinates)
      .addTo(map);
    const meta = POI_META[poi.properties.kind];
    poiMarker.getElement().title = `${meta?.emoji ?? ""} ${poi.properties.name || meta?.label || "stop"}`;
  } catch (err) {
    errBox.textContent = err instanceof Error ? err.message : String(err);
    errBox.style.display = "block";
  } finally {
    loading.style.display = "none";
  }
}

let optionChips: Marker[] = [];
function clearOptionChips(): void {
  for (const c of optionChips) c.remove();
  optionChips = [];
}

/** Selectable grade·time chips on the map, one per alternative (Google-style,
 * but the lead label is the safety grade, not the ETA). */
function renderOptionChips(): void {
  clearOptionChips();
  if (options.length < 2) return; // no choice to make
  options.forEach((o, i) => {
    const coords = o.payload.geojson.features.flatMap((f) => f.geometry.coordinates);
    if (coords.length === 0) return;
    const frac = Math.min(0.9, 0.35 + i * 0.2);
    const pt = coords[Math.floor(coords.length * frac)] ?? coords[coords.length - 1];
    if (!pt) return;
    const chip = document.createElement("div");
    chip.className = "opt-chip" + (o.id === selectedId ? " sel" : "");
    chip.style.setProperty("--g", GRADE_COLORS[o.grade]);
    chip.textContent = `${o.grade} · ${o.payload.summary.minutes}m`;
    chip.title = `${o.label}: ${o.gradeReason}`;
    chip.addEventListener("click", (ev: Event) => {
      ev.stopPropagation();
      selectOption(o.id);
    });
    optionChips.push(
      new maplibregl.Marker({ element: chip }).setLngLat(pt as [number, number]).addTo(map),
    );
  });
}

function selectOption(id: RouteOption["id"]): void {
  const chosen = options.find((o) => o.id === id);
  if (!chosen) return;
  selectedId = id;
  getSource("route").setData(chosen.payload.geojson as GeoJSON.GeoJSON);
  const altFeatures = options
    .filter((o) => o.id !== id)
    .flatMap((o) => o.payload.geojson.features);
  getSource("alts").setData({
    type: "FeatureCollection",
    features: altFeatures,
  } as GeoJSON.GeoJSON);
  renderOptions();
  renderOptionChips();
  showSummary(chosen);
  updateHash();
}

function renderOptions(): void {
  const box = el<HTMLDivElement>("options");
  box.innerHTML = "";
  if (options.length === 0) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  if (options.length > 1) {
    const head = document.createElement("div");
    head.className = "options-head";
    head.textContent = `${options.length} route options — safety-rated:`;
    box.appendChild(head);
  }
  for (const o of options) {
    const card = document.createElement("div");
    card.className = "option-card" + (o.id === selectedId ? " selected" : "");
    card.title = o.gradeReason;
    const s = o.payload.summary;
    const badge = document.createElement("b");
    badge.className = "grade";
    badge.style.background = GRADE_COLORS[o.grade];
    badge.textContent = o.grade;
    card.appendChild(badge);
    const label = document.createElement("span");
    label.innerHTML =
      `<b>${o.label}</b> · ${fmtDist(s.meters)} · ~${s.minutes} min · ` +
      `${s.pct_protected}% protected · ↗ ${s.climb_m ?? 0} m`;
    card.appendChild(label);
    card.addEventListener("click", () => {
      selectOption(o.id);
    });
    // hovering a card previews that route on the map
    card.addEventListener("mouseenter", () => {
      getSource("route").setData(o.payload.geojson as GeoJSON.GeoJSON);
    });
    card.addEventListener("mouseleave", () => {
      const sel = options.find((x) => x.id === selectedId);
      if (sel) getSource("route").setData(sel.payload.geojson as GeoJSON.GeoJSON);
    });
    box.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// summary + ribbon + cautions
// ---------------------------------------------------------------------------

function renderRibbon(option: RouteOption): void {
  const holder = el<HTMLDivElement>("ribbon");
  const ribbon = option.payload.ribbon ?? [];
  if (ribbon.length === 0) {
    holder.innerHTML = "";
    return;
  }
  const W = 280;
  const total = ribbon.reduce((a, r) => a + r.m, 0);
  if (total <= 0) {
    holder.innerHTML = "";
    return;
  }
  const elevs = ribbon.flatMap((r) => [r.e0, r.e1]);
  const eMin = Math.min(...elevs);
  const eMax = Math.max(...elevs, eMin + 5);
  const ey = (v: number): number => 62 - ((v - eMin) / (eMax - eMin)) * 24;
  let x = 0;
  const rects: string[] = [];
  const crossings: string[] = [];
  const linePts: string[] = [];
  for (const seg of ribbon) {
    const wpx = (seg.m / total) * W;
    const fill = seg.walk === true ? "#8aa4b8" : CLASS_COLORS[seg.cls];
    const segLabel = seg.walk === true ? "walk the bike" : CLASS_LABELS[seg.cls];
    rects.push(
      `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(wpx, 0.4).toFixed(2)}" height="12"` +
        ` fill="${fill}"><title>${segLabel}: ${fmtDist(seg.m)}</title></rect>`,
    );
    if (seg.crossing) {
      crossings.push(
        `<text x="${x.toFixed(2)}" y="22" font-size="9" fill="#a33">▲<title>busy crossing</title></text>`,
      );
    }
    linePts.push(`${x.toFixed(2)},${ey(seg.e0).toFixed(1)}`);
    x += wpx;
    linePts.push(`${x.toFixed(2)},${ey(seg.e1).toFixed(1)}`);
  }
  holder.innerHTML =
    `<svg width="${W}" height="70" xmlns="http://www.w3.org/2000/svg">` +
    rects.join("") +
    crossings.join("") +
    `<polyline points="${linePts.join(" ")}" fill="none" stroke="#666" stroke-width="1.4"/>` +
    `<text x="0" y="40" font-size="8" fill="#999">${Math.round(eMax)} m</text>` +
    `<text x="0" y="68" font-size="8" fill="#999">${Math.round(eMin)} m</text>` +
    `</svg>`;
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
  const bar = el<HTMLDivElement>("classbar");
  bar.innerHTML = "";
  for (const [cls, m] of Object.entries(s.by_class_m) as [ProtectionClass, number][]) {
    const seg = document.createElement("i");
    seg.style.cssText = `flex:${m};background:${CLASS_COLORS[cls] ?? "#999"}`;
    seg.title = `${CLASS_LABELS[cls] ?? cls}: ${fmtDist(m)}`;
    bar.appendChild(seg);
  }
  renderRibbon(option);
  const cautions = el<HTMLDivElement>("cautions");
  cautions.innerHTML = "";
  if (s.cautions.length === 0) {
    const div = document.createElement("div");
    div.className = "all-clear";
    div.textContent = "✓ no stressful segments";
    cautions.appendChild(div);
  }
  for (const c of s.cautions) {
    const div = document.createElement("div");
    div.className = "caution";
    div.textContent = `⚠ ${c.name}: ${fmtDist(c.meters)} of ${CLASS_LABELS[c.cls] ?? c.cls} `;
    if (c.lon !== undefined && c.lat !== undefined) {
      const lon = c.lon;
      const lat = c.lat;
      const a = document.createElement("a");
      a.href = `https://maps.google.com/maps?q=&layer=c&cbll=${lat},${lon}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "street view";
      div.appendChild(a);
      if (mapillaryToken !== "") {
        div.appendChild(document.createTextNode(" · "));
        const photo = document.createElement("a");
        photo.href = "#";
        photo.textContent = "📷 photo";
        photo.title = "recent street-level photo (Mapillary)";
        photo.addEventListener("click", (ev: Event) => {
          ev.preventDefault();
          void showMapillaryPreview(lon, lat);
        });
        div.appendChild(photo);
      }
    }
    cautions.appendChild(div);
  }
  const why = el<HTMLDetailsElement>("why");
  const whyList = el<HTMLUListElement>("why-list");
  whyList.innerHTML = "";
  const explanation = s.explanation ?? [];
  why.style.display = explanation.length > 0 ? "block" : "none";
  for (const reason of explanation) {
    const li = document.createElement("li");
    li.textContent = reason;
    whyList.appendChild(li);
  }

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

interface MapillaryImage {
  thumb_1024_url?: string;
  captured_at?: number;
}

/** ~45 m cell cache so hovering along a street reuses one lookup. */
const segPhotoCache = new Map<string, { url: string | null; captured: number | null }>();
let segPhotoTimer: number | undefined;

async function fetchSegmentPhoto(
  lon: number,
  lat: number,
): Promise<{ url: string | null; captured: number | null }> {
  const key = `${Math.round(lon / 0.0005)},${Math.round(lat / 0.0005)}`;
  const cached = segPhotoCache.get(key);
  if (cached !== undefined) return cached;
  const d = 0.0004;
  const url =
    "https://graph.mapillary.com/images?" +
    new URLSearchParams({
      access_token: mapillaryToken,
      bbox: `${lon - d},${lat - d},${lon + d},${lat + d}`,
      fields: "id,thumb_256_url,captured_at",
      limit: "5",
    }).toString();
  let result: { url: string | null; captured: number | null } = { url: null, captured: null };
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const data = (await resp.json()) as {
        data: { thumb_256_url?: string; captured_at?: number }[];
      };
      const newest = [...data.data].sort(
        (a, b) => (b.captured_at ?? 0) - (a.captured_at ?? 0),
      )[0];
      result = { url: newest?.thumb_256_url ?? null, captured: newest?.captured_at ?? null };
    }
  } catch {
    // offline or rate-limited: cache the miss too, avoids retry storms
  }
  segPhotoCache.set(key, result);
  return result;
}

function fillSegmentPhoto(popup: Popup, lon: number, lat: number): void {
  void fetchSegmentPhoto(lon, lat).then(({ url, captured }) => {
    if (popup !== hoverPopup) return; // hover moved on
    const slot = popup.getElement()?.querySelector<HTMLDivElement>("div[data-seg-photo]");
    if (!slot || !slot.isConnected) return;
    if (url === null) {
      slot.innerHTML = `<small><i>no street-level photo here</i></small>`;
      return;
    }
    const when =
      captured !== null ? ` <small>${new Date(captured).toLocaleDateString()}</small>` : "";
    slot.innerHTML =
      `<img src="${url}" alt="" style="max-width:210px;border-radius:6px;display:block;` +
      `margin-top:4px">📷${when}`;
  });
}

async function showMapillaryPreview(lon: number, lat: number): Promise<void> {
  const d = 0.0005; // ~45 m box
  const url =
    "https://graph.mapillary.com/images?" +
    new URLSearchParams({
      access_token: mapillaryToken,
      bbox: `${lon - d},${lat - d},${lon + d},${lat + d}`,
      fields: "id,thumb_1024_url,captured_at",
      limit: "3",
    }).toString();
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`mapillary ${resp.status}`);
    const data = (await resp.json()) as { data: MapillaryImage[] };
    const newest = [...data.data].sort((a, b) => (b.captured_at ?? 0) - (a.captured_at ?? 0))[0];
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

// ---------------------------------------------------------------------------
// GPX + cue sheet
// ---------------------------------------------------------------------------

el<HTMLButtonElement>("gpx").addEventListener("click", () => {
  const sel = options.find((o) => o.id === selectedId);
  if (!sel) return;
  const gpx = toGPX(sel.payload, `Family bike route (${sel.label})`);
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "family-bike-route.gpx";
  a.click();
  URL.revokeObjectURL(a.href);
});

el<HTMLButtonElement>("print-cues").addEventListener("click", () => {
  const sel = options.find((o) => o.id === selectedId);
  if (!sel) return;
  const cues = buildCues(sel.payload);
  const s = sel.payload.summary;
  const rows = cues
    .map((c) => `<tr><td>${c.km.toFixed(1)} km</td><td>${c.text}</td></tr>`)
    .join("");
  const cautionRows = s.cautions
    .map((c) => `<li>⚠ ${c.name}: ${fmtDist(c.meters)} of ${CLASS_LABELS[c.cls] ?? c.cls}</li>`)
    .join("");
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(
    `<html><head><title>Cue sheet</title><style>
      body{font-family:sans-serif;font-size:13px;max-width:520px;margin:20px auto}
      table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:3px 6px}
      td:first-child{white-space:nowrap;font-variant-numeric:tabular-nums}
    </style></head><body>
    <h2>Family bike route — ${sel.label}</h2>
    <p>${fmtDist(s.meters)} · ~${s.minutes} min · ${s.pct_protected}% protected · climb ${s.climb_m ?? 0} m</p>
    ${cautionRows ? `<ul>${cautionRows}</ul>` : ""}
    <table>${rows}</table>
    </body></html>`,
  );
  win.document.close();
  win.print();
});

// ---------------------------------------------------------------------------
// URL hash permalinks: #s=lon,lat&e=lon,lat&m=profile&f=1
// ---------------------------------------------------------------------------

function updateHash(): void {
  if (!start) return;
  const s = start.getLngLat();
  const base =
    `s=${s.lng.toFixed(6)},${s.lat.toFixed(6)}&m=${profileId}` +
    (preferFlat ? "&f=1" : "") +
    (walkMaxM > 0 ? `&wk=${walkMaxM}` : "") +
    (avoidTypes.size > 0 ? `&x=${[...avoidTypes].join(",")}` : "");
  let h: string;
  if (loopParams !== null) {
    h = `${base}&l=${loopParams.km},${loopParams.kind}`;
  } else if (end) {
    const d = end.getLngLat();
    h =
      `${base}&e=${d.lng.toFixed(6)},${d.lat.toFixed(6)}` +
      (selectedId !== null && selectedId !== "loop" ? `&o=${selectedId}` : "");
  } else {
    return;
  }
  history.replaceState(null, "", `#${h}`);
}

function parseHash(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const parse = (v: string | null): [number, number] | null => {
    if (v === null) return null;
    const parts = v.split(",").map(Number);
    const [lng, lat] = parts;
    if (parts.length !== 2 || lng === undefined || lat === undefined) return null;
    if (Number.isNaN(lng) || Number.isNaN(lat)) return null;
    return [lng, lat];
  };
  const m = params.get("m");
  const legacy: Record<string, ProfileId> = { kids: "young_kids", solo: "solo" };
  const mapped = m !== null ? (legacy[m] ?? m) : null;
  if (mapped === "young_kids" || mapped === "older_kids" || mapped === "solo") {
    profileId = mapped;
    const radio = document.querySelector<HTMLInputElement>(
      `input[name=profile][value=${mapped}]`,
    );
    if (radio) radio.checked = true;
  }
  if (params.get("f") === "1") {
    preferFlat = true;
    el<HTMLInputElement>("prefer-flat").checked = true;
  }
  const wk = params.get("wk");
  if (wk !== null) {
    walkMaxM = wk === "1" ? 500 : Math.max(0, Math.min(2000, Number(wk) || 0));
    el<HTMLSelectElement>("walk-max").value = String(walkMaxM);
  }
  const x = params.get("x");
  if (x !== null) {
    const valid = new Set(AVOIDABLE.map(([c]) => c as string));
    avoidTypes = new Set(x.split(",").filter((t) => valid.has(t)) as ProtectionClass[]);
    for (const [cls] of AVOIDABLE) {
      el<HTMLInputElement>(`avoid-${cls}`).checked = avoidTypes.has(cls);
    }
    syncAvoidSummary();
  }
  const o = params.get("o");
  if (o === "safest" || o === "balanced" || o === "direct") pendingSelect = o;
  const s = parse(params.get("s"));
  const e = parse(params.get("e"));
  const l = params.get("l");
  if (s && l !== null) {
    // shared loop: restore controls, place the start, and re-plan it
    const [kmRaw, kind] = l.split(",");
    const km = Number(kmRaw);
    if (km > 0 && kind) {
      el<HTMLSelectElement>("loop-dist").value = String(km);
      el<HTMLSelectElement>("loop-stop").value = kind;
      start = makeMarker(s, "#2b83ba", "start");
      void requestLoop();
      return;
    }
  }
  if (s) setPoint("start", s);
  if (e) setPoint("end", e);
}

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

// ---------------------------------------------------------------------------
// saved places (Home/Work/…) and recent route history
// ---------------------------------------------------------------------------

/** Label a just-planned route from its street names for the recent list. */
function recordRecentRoute(s: [number, number], e: [number, number]): void {
  const sel = options.find((o) => o.id === selectedId) ?? options[0];
  if (!sel) return;
  const names = sel.payload.geojson.features
    .map((f) => f.properties.name)
    .filter((n): n is string => n !== null && n !== "");
  const from = names[0] ?? "start";
  const to = names[names.length - 1] ?? "end";
  pushRecent({
    s,
    e,
    label: `${from} → ${to}`,
    km: Math.round(sel.payload.summary.meters / 100) / 10,
    grade: sel.grade,
    t: Date.now(),
  });
  renderPlacesAndRecent();
}

function planBetween(s: [number, number], e: [number, number]): void {
  fromCurrent = false;
  syncOD();
  if (start) start.setLngLat(s);
  else start = makeMarker(s, "#2b83ba", "start");
  if (end) end.setLngLat(e);
  else end = makeMarker(e, "#d7191c", "end");
  void requestRoute();
}

function promptSavePlace(lon: number, lat: number): void {
  const name = window.prompt("Name this place (e.g. Home, Work, School):");
  if (name === null || name.trim() === "") return;
  savePlace({ name: name.trim(), lon, lat });
  renderPlacesAndRecent();
}

function placeRow(place: SavedPlace): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "search-row";
  const label = document.createElement("span");
  label.textContent = `${emojiFor(place.name)} ${place.name}`;
  row.appendChild(label);
  for (const kind of ["start", "end"] as const) {
    const btn = document.createElement("button");
    btn.textContent = kind;
    btn.addEventListener("click", () => {
      setPoint(kind, [place.lon, place.lat]);
      map.flyTo({ center: [place.lon, place.lat], zoom: 15 });
    });
    row.appendChild(btn);
  }
  const rm = document.createElement("button");
  rm.textContent = "✕";
  rm.title = "delete place";
  rm.addEventListener("click", () => {
    deletePlace(place.name);
    renderPlacesAndRecent();
  });
  row.appendChild(rm);
  return row;
}

function recentRow(route: RecentRoute): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "search-row";
  const label = document.createElement("span");
  label.textContent = `🕘 ${route.label} · ${route.km} km`;
  label.title = "plan this route again";
  label.style.cursor = "pointer";
  label.addEventListener("click", () => {
    planBetween(route.s, route.e);
  });
  row.appendChild(label);
  const swapBtn = document.createElement("button");
  swapBtn.textContent = "⇄";
  swapBtn.title = "plan the reverse direction";
  swapBtn.addEventListener("click", () => {
    planBetween(route.e, route.s);
  });
  row.appendChild(swapBtn);
  return row;
}

function renderPlacesAndRecent(): void {
  const placesBox = el<HTMLDivElement>("places-list");
  placesBox.innerHTML = "";
  const places = listPlaces();
  for (const place of places) placesBox.appendChild(placeRow(place));
  const recentBox = el<HTMLDivElement>("recent-list");
  recentBox.innerHTML = "";
  const recent = listRecent();
  // collapsed by default; the whole section is hidden when there's no history
  el<HTMLDetailsElement>("recent-box").style.display = recent.length > 0 ? "block" : "none";
  if (recent.length > 0) {
    for (const route of recent.slice(0, 5)) recentBox.appendChild(recentRow(route));
    const clear = document.createElement("button");
    clear.textContent = "clear history";
    clear.title = "clear recent routes";
    clear.style.cssText = "margin-top:4px;padding:1px 8px;font-size:11px";
    clear.addEventListener("click", () => {
      clearRecent();
      renderPlacesAndRecent();
    });
    recentBox.appendChild(clear);
  }
}

// ---------------------------------------------------------------------------
// address search (Nominatim, bounded to our area)
// ---------------------------------------------------------------------------

async function searchAddress(query: string): Promise<NominatimResult[]> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1" +
    `&viewbox=${BBOX.west},${BBOX.north},${BBOX.east},${BBOX.south}` +
    `&q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`search failed (${resp.status})`);
  return (await resp.json()) as NominatimResult[];
}

function renderSearchResults(results: NominatimResult[]): void {
  const box = el<HTMLDivElement>("search-results");
  box.innerHTML = "";
  if (results.length === 0) {
    box.textContent = "no results in this area";
    return;
  }
  for (const r of results) {
    const row = document.createElement("div");
    row.className = "search-row";
    const name = document.createElement("span");
    name.textContent = r.display_name.split(",").slice(0, 3).join(",");
    name.title = r.display_name;
    row.appendChild(name);
    const lngLat: [number, number] = [parseFloat(r.lon), parseFloat(r.lat)];
    for (const kind of ["start", "end"] as const) {
      const btn = document.createElement("button");
      btn.textContent = kind;
      btn.addEventListener("click", () => {
        setPoint(kind, lngLat);
        map.flyTo({ center: lngLat, zoom: 15 });
        box.innerHTML = "";
      });
      row.appendChild(btn);
    }
    const star = document.createElement("button");
    star.textContent = "☆";
    star.title = "save as a place (Home, Work, …)";
    star.addEventListener("click", () => {
      promptSavePlace(lngLat[0], lngLat[1]);
      box.innerHTML = "";
    });
    row.appendChild(star);
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// safe-shed (reachability)
// ---------------------------------------------------------------------------

async function computeShed(): Promise<void> {
  if (!shedCenter) return;
  await manifestReady;
  const budgetKm = Number(el<HTMLInputElement>("shed-budget").value);
  el<HTMLSpanElement>("shed-budget-label").textContent = `${budgetKm} km`;
  // the flood can reach out to the full budget radius from the center
  const r = await ensureRouter([shedCenter], budgetKm * 1000, 2);
  if (!r) return;
  const res = r.safeShed(shedCenter, budgetKm * 1000, profileId, preferFlat);
  getSource("shed").setData(res.geojson as GeoJSON.GeoJSON);
  el<HTMLDivElement>("shed-info").textContent =
    `${res.reachableKm} km of streets reachable (${res.pctReachable}% of the network) ` +
    `within a perceived ${budgetKm} km`;
  if (shedMarker) shedMarker.setLngLat(shedCenter);
  else {
    shedMarker = new maplibregl.Marker({ color: "#7c3aed" }).setLngLat(shedCenter).addTo(map);
    shedMarker.getElement().title = "reachability center";
  }
}

function exitShedMode(): void {
  shedMode = false;
  shedCenter = null;
  shedMarker?.remove();
  shedMarker = null;
  getSource("shed").setData(emptyFC());
  el<HTMLDivElement>("shed-panel").style.display = "none";
  el<HTMLButtonElement>("shed-btn").textContent = "🗺 Reach map";
  el<HTMLDivElement>("shed-info").textContent = "";
}

el<HTMLButtonElement>("shed-btn").addEventListener("click", () => {
  if (shedMode) {
    exitShedMode();
    return;
  }
  shedMode = true;
  el<HTMLButtonElement>("shed-btn").textContent = "✕ Exit reach map";
  el<HTMLDivElement>("shed-panel").style.display = "block";
  el<HTMLDivElement>("shed-info").textContent =
    "click the map (e.g. home) to see everything reachable at your comfort level";
});

el<HTMLInputElement>("shed-budget").addEventListener("input", () => {
  void computeShed();
});

// ---------------------------------------------------------------------------
// sketchy marks (personal feedback)
// ---------------------------------------------------------------------------

function renderSketchy(): void {
  const box = el<HTMLDivElement>("sketchy-section");
  const list = el<HTMLDivElement>("sketchy-list");
  list.innerHTML = "";
  box.style.display = sketchyMarks.length > 0 ? "block" : "none";
  sketchyMarks.forEach((mark, i) => {
    const row = document.createElement("div");
    row.className = "sketchy-row";
    const span = document.createElement("span");
    span.textContent = `⚠ marked spot ${i + 1}`;
    span.style.cursor = "pointer";
    span.title = "fly to";
    span.addEventListener("click", () => {
      map.flyTo({ center: mark, zoom: 16 });
    });
    row.appendChild(span);
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.title = "remove";
    rm.addEventListener("click", () => {
      sketchyMarks = sketchyMarks.filter((_, j) => j !== i);
      saveSketchy(sketchyMarks);
      applyAvoidPoints();
      renderSketchy();
      void requestRoute();
    });
    row.appendChild(rm);
    list.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// layers + interaction wiring
// ---------------------------------------------------------------------------

const FACILITY_CLASSES = ["path", "separated", "buffered", "lane"];

map.on("load", () => {
  // dark basemap (CARTO dark matter), toggled with the UI theme
  map.addSource("carto-dark", {
    type: "raster",
    tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
    tileSize: 256,
    attribution: "© OpenStreetMap contributors © CARTO",
  });
  map.addLayer({
    id: "osm-dark",
    type: "raster",
    source: "carto-dark",
    layout: { visibility: "none" },
  });
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
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 3.5],
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
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 3.5],
      "line-opacity": 0.75,
      "line-dasharray": [2, 1.4],
    },
  });
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
  // walking stretches: white dashes over the route line
  map.addLayer({
    id: "route-walk",
    type: "line",
    source: "route",
    filter: ["==", ["get", "walk"], true],
    paint: { "line-color": "#ffffff", "line-width": 2.5, "line-dasharray": [1.5, 1.5] },
  });
  map.addSource("construction", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "construction-lines",
    type: "line",
    source: "construction",
    filter: ["!=", ["geometry-type"], "Point"],
    paint: { "line-color": "#ff8c00", "line-width": 5, "line-dasharray": [1.2, 1], "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "construction-pts",
    type: "circle",
    source: "construction",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 6,
      "circle-color": "#ff8c00",
      "circle-stroke-color": "#7a3b00",
      "circle-stroke-width": 2,
    },
  });
  for (const layer of ["construction-lines", "construction-pts"]) {
    map.on("click", layer, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as {
        src?: string;
        name?: string;
        detail?: string;
        start?: string;
        end?: string;
        kind?: string;
        address?: string;
      };
      const source = props.src === "massdot_wzdx" ? "MassDOT work zone" : "Cambridge street permit";
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `🚧 <b>${props.name || props.kind || "construction"}</b><br>` +
            `${props.address ?? ""}${props.detail ? `<br>${props.detail}` : ""}` +
            `<br><small>${source} · ${props.start ?? "?"} → ${props.end ?? "?"}</small>`,
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
  map.on("click", "hazardpts", (e: MapLayerMouseEvent) => {
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

  // hover tooltips on every dot layer (clicks keep their richer popups)
  const hoverHtml: Record<string, (props: Record<string, unknown>) => string> = {
    pois: (p) => {
      const kind = typeof p["kind"] === "string" ? p["kind"] : "";
      const meta = POI_META[kind];
      const name = typeof p["name"] === "string" && p["name"] !== "" ? p["name"] : null;
      return `${meta?.emoji ?? "📍"} <b>${name ?? meta?.label ?? "stop"}</b>` +
        (name ? `<br><small>${meta?.label ?? ""}</small>` : "");
    },
    gateways: () =>
      "🚦 <b>safe crossing</b><br><small>signalized crossing of a busy street</small>",
    hazardpts: (p) => {
      const cat = typeof p["category"] === "string" ? (p["category"] as HazardCategory) : null;
      const note = typeof p["note"] === "string" && p["note"] !== "" ? `<br>${p["note"]}` : "";
      const when =
        typeof p["t"] === "number"
          ? `<br><small>${new Date(p["t"]).toLocaleDateString()} · click to remove</small>`
          : "";
      // photo placeholder — filled asynchronously from IndexedDB below
      const photo =
        p["hasPhoto"] === true || p["hasPhoto"] === "true"
          ? `<img data-hazard-photo="${String(p["id"] ?? "")}" alt=""
               style="max-width:180px;display:block;border-radius:6px;margin-top:4px">`
          : "";
      return `⚠ <b>${cat !== null ? HAZARD_LABELS[cat] : "hazard"}</b>${note}${photo}${when}`;
    },
    "construction-pts": (p) => constructionHtml(p),
    "construction-lines": (p) => constructionHtml(p),
  };
  function constructionHtml(p: Record<string, unknown>): string {
    const name = typeof p["name"] === "string" && p["name"] !== "" ? p["name"] : "construction";
    const kind = typeof p["kind"] === "string" ? ` · ${p["kind"]}` : "";
    const address =
      typeof p["address"] === "string" && p["address"] !== "" ? `<br>${p["address"]}` : "";
    const detail =
      typeof p["detail"] === "string" && p["detail"] !== "" ? `<br>${p["detail"]}` : "";
    const source =
      p["src"] === "massdot_wzdx" ? "MassDOT work zone" : "Cambridge street permit";
    const dates =
      typeof p["start"] === "string" && typeof p["end"] === "string"
        ? ` · ${p["start"]} → ${p["end"]}`
        : "";
    return `🚧 <b>${name}</b>${kind}${address}${detail}<br><small>${source}${dates}</small>`;
  }
  for (const [layer, html] of Object.entries(hoverHtml)) {
    map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f) return;
      hoverPopup?.remove();
      hoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 10,
      })
        .setLngLat(e.lngLat)
        .setHTML(html(f.properties as Record<string, unknown>))
        .addTo(map);
      // hazard photos live in IndexedDB — fill the placeholder if present
      const slot = hoverPopup
        .getElement()
        ?.querySelector<HTMLImageElement>("img[data-hazard-photo]");
      const photoId = slot?.dataset["hazardPhoto"];
      if (slot && photoId !== undefined && photoId !== "") {
        void getHazardPhoto(photoId).then((blob) => {
          if (blob && slot.isConnected) slot.src = URL.createObjectURL(blob);
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
  map.on("click", "gateways", (e: MapLayerMouseEvent) => {
    new maplibregl.Popup({ offset: 10 })
      .setLngLat(e.lngLat)
      .setHTML(hoverHtml["gateways"]?.({}) ?? "")
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
      const cls = props.cls;
      const label = cls !== undefined ? CLASS_LABELS[cls] ?? cls : "?";
      const grade = cls !== undefined ? classGrade(cls) : null;
      const badge =
        grade !== null
          ? `<span style="background:${GRADE_COLORS[grade]};color:#fff;border-radius:5px;` +
            `padding:0 6px;font-weight:700">${grade}</span> `
          : "";
      const meaning = cls !== undefined ? `<br>${CLASS_SAFETY[cls]}` : "";
      const mult = cls !== undefined ? PROFILES.young_kids.mult[cls] : null;
      const stress =
        mult !== null
          ? `<br><small>kid-stress ×${mult} — young kids would detour up to ` +
            `${mult}× the distance to avoid ${mult > 1.6 ? "this" : "worse"}</small>`
          : "";
      const crashes =
        props.crashes !== undefined && props.crashes > 0
          ? `<br><small>⚠ ${props.crashes} bike crash${props.crashes > 1 ? "es" : ""} ` +
            `recorded nearby (2021–26)</small>`
          : "";
      const unconfirmed =
        props.source === "osm" && cls !== undefined && FACILITY_CLASSES.includes(cls)
          ? "<br><small><i>facility per OSM only (not in official layers yet)</i></small>"
          : "";
      const photoSlot = mapillaryToken !== "" ? `<div data-seg-photo></div>` : "";
      const html =
        `${badge}<b>${props.name ?? "unnamed"}</b><br>${label}${meaning}${stress}` +
        `${crashes}${unconfirmed}${photoSlot}` +
        `<br><small>right-click to mark as sketchy</small>`;
      if (!hoverPopup) {
        hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
        hoverPopup.addTo(map);
      }
      hoverPopup.setLngLat(e.lngLat).setHTML(html);
      if (mapillaryToken !== "") {
        window.clearTimeout(segPhotoTimer);
        const popup = hoverPopup;
        const { lng, lat } = e.lngLat;
        // debounce: only fetch once the cursor rests on a segment
        segPhotoTimer = window.setTimeout(() => {
          fillSegmentPhoto(popup, lng, lat);
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

  map.on("click", "pois", (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as { kind?: string; name?: string };
    const meta = props.kind !== undefined ? POI_META[props.kind] : undefined;
    new maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(`${meta?.emoji ?? ""} <b>${props.name || meta?.label || "?"}</b>`)
      .addTo(map);
  });

  map.on("mousemove", "lanemap", (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as { fac_m?: number; prot_m?: number };
    if (props.fac_m === undefined) return;
    hoverPopup?.remove();
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
      .setLngLat(e.lngLat)
      .setHTML(
        `🚴 ${props.fac_m} m of bike facilities in this block` +
          `<br><small>${props.prot_m ?? 0} m protected (path/separated)</small>`,
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
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
      .setLngLat(e.lngLat)
      .setHTML(`elevation ~${props.elev} m`)
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
  void dataReady
    .then(() => loadJson<GeoJSON.GeoJSON>("pois.geojson"))
    .then((d) => {
      (map.getSource("pois") as GeoJSONSource).setData(d);
    })
    .catch(() => undefined)
    .finally(() => dataProgress());
  void networkReady.then(() => refreshNetworkTiles()).finally(() => dataProgress());
  void constructionReady
    .then(() => {
      if (constructionFC) {
        (map.getSource("construction") as GeoJSONSource).setData(
          constructionFC as unknown as GeoJSON.GeoJSON,
        );
      }
    })
    .finally(() => dataProgress());

  parseHash();
});

map.on("click", (e: MapMouseEvent) => {
  if (shedMode) {
    shedCenter = [e.lngLat.lng, e.lngLat.lat];
    void computeShed();
    return;
  }
  if (activeField === "start") {
    setPoint("start", e.lngLat);
    activeField = "end";
  } else {
    setPoint("end", e.lngLat);
  }
});

// touch devices have no right-click: a long-press on a street opens the
// same "mark sketchy" popup
function openSketchyPopup(lngLat: [number, number]): void {
  const box = document.createElement("div");
  const btn = document.createElement("button");
  btn.textContent = "⚠ mark this spot as sketchy";
  box.appendChild(btn);
  const report = document.createElement("button");
  report.textContent = "📷 report hazard…";
  box.appendChild(report);
  const star = document.createElement("button");
  star.textContent = "☆ save place…";
  box.appendChild(star);
  const popup = new maplibregl.Popup().setLngLat(lngLat).setDOMContent(box).addTo(map);
  btn.addEventListener("click", () => {
    sketchyMarks.push(lngLat);
    saveSketchy(sketchyMarks);
    applyAvoidPoints();
    renderSketchy();
    popup.remove();
    void requestRoute();
  });
  report.addEventListener("click", () => {
    popup.remove();
    openHazardDialog(lngLat[0], lngLat[1]);
  });
  star.addEventListener("click", () => {
    popup.remove();
    promptSavePlace(lngLat[0], lngLat[1]);
  });
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

// draggable bottom-sheet (mobile): peek / half / full snap states
const SHEET_STATES = ["peek", "half", "full"] as const;
type SheetState = (typeof SHEET_STATES)[number];
function setSheet(state: SheetState): void {
  const panel = el<HTMLDivElement>("panel");
  panel.style.maxHeight = "";
  panel.classList.remove("peek", "half", "full");
  panel.classList.add(state);
}
function currentSheet(): SheetState {
  const panel = el<HTMLDivElement>("panel");
  return SHEET_STATES.find((s) => panel.classList.contains(s)) ?? "half";
}
(function initSheet(): void {
  const panel = el<HTMLDivElement>("panel");
  const handle = el<HTMLDivElement>("sheet-handle");
  if (window.matchMedia("(max-width: 760px), (max-height: 500px)").matches) setSheet("half");
  let dragging = false;
  let startY = 0;
  let startH = 0;
  let moved = 0;
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    moved = 0;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    moved = Math.max(moved, Math.abs(dy));
    const h = Math.min(window.innerHeight * 0.88, Math.max(70, startH + dy));
    panel.classList.remove("peek", "half", "full");
    panel.style.maxHeight = `${h}px`;
  });
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    const h = panel.getBoundingClientRect().height;
    panel.style.maxHeight = "";
    if (moved < 6) {
      // a tap cycles peek -> half -> full -> peek
      const next = SHEET_STATES[(SHEET_STATES.indexOf(currentSheet()) + 1) % 3];
      setSheet(next ?? "half");
      return;
    }
    const vh = window.innerHeight;
    setSheet(h < vh * 0.25 ? "peek" : h < vh * 0.68 ? "half" : "full");
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
})();

/** After a route computes, make sure the sheet is at least half-open (mobile). */
function revealSheet(): void {
  if (currentSheet() === "peek") setSheet("half");
}

el<HTMLButtonElement>("from-field").addEventListener("click", () => {
  const f = el<HTMLButtonElement>("from-field");
  if (!fromCurrent && start) {
    // revert to using the current location as the origin
    start.remove();
    start = null;
    fromCurrent = true;
    activeField = "end";
    f.classList.remove("picking");
    syncOD();
    void requestRoute();
  } else {
    // pick a custom start: the next map tap / place / search fills it
    activeField = "start";
    f.classList.add("picking");
    el<HTMLElement>("from-label").textContent = "tap the map or a place…";
  }
});

el<HTMLButtonElement>("reset").addEventListener("click", () => {
  start?.remove();
  end?.remove();
  poiMarker?.remove();
  start = end = poiMarker = null;
  clearOptionChips();
  fromCurrent = true;
  activeField = "end";
  el<HTMLButtonElement>("from-field").classList.remove("picking");
  syncOD();
  options = [];
  selectedId = null;
  renderOptions();
  getSource("route").setData(emptyFC());
  getSource("alts").setData(emptyFC());
  el<HTMLDivElement>("summary").style.display = "none";
  el<HTMLDivElement>("error").style.display = "none";
  history.replaceState(null, "", "#");
});

el<HTMLButtonElement>("swap").addEventListener("click", () => {
  if (!start || !end) return;
  const s = start.getLngLat();
  start.setLngLat(end.getLngLat());
  end.setLngLat(s);
  void requestRoute();
});

el<HTMLButtonElement>("loop-btn").addEventListener("click", () => {
  void requestLoop();
});

el<HTMLInputElement>("show-net").addEventListener("change", applyBasemap);
for (const [checkboxId, layers] of [
  ["show-net", ["network", "network-unconfirmed"]],
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
  preferFlat = (e.target as HTMLInputElement).checked;
  void requestRoute();
  void computeShed();
});

el<HTMLSelectElement>("walk-max").addEventListener("change", (e: Event) => {
  walkMaxM = Number((e.target as HTMLSelectElement).value);
  localStorage.setItem("walkMaxM", String(walkMaxM));
  void requestRoute();
});
// restore the persisted walking budget
walkMaxM = Number(localStorage.getItem("walkMaxM") ?? "0") || 0;
el<HTMLSelectElement>("walk-max").value = String(walkMaxM);

for (const [cls] of AVOIDABLE) {
  const box = el<HTMLInputElement>(`avoid-${cls}`);
  box.checked = avoidTypes.has(cls);
  box.addEventListener("change", () => {
    if (box.checked) avoidTypes.add(cls);
    else avoidTypes.delete(cls);
    localStorage.setItem("avoidTypes", JSON.stringify([...avoidTypes]));
    syncAvoidSummary();
    void requestRoute();
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
      profileId = v;
      void requestRoute();
      void computeShed();
    }
  });
}

const searchInput = el<HTMLInputElement>("search");
let searchTimer: number | undefined;
searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 3) {
    el<HTMLDivElement>("search-results").innerHTML = "";
    return;
  }
  searchTimer = window.setTimeout(() => {
    searchAddress(q)
      .then(renderSearchResults)
      .catch(() => {
        el<HTMLDivElement>("search-results").textContent = "search unavailable";
      });
  }, 400);
});

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    if (
      el<HTMLDialogElement>("about").open ||
      el<HTMLDialogElement>("rides").open ||
      el<HTMLDialogElement>("hazard").open
    ) {
      return; // dialogs handle it
    }
    if (shedMode) exitShedMode();
    else el<HTMLButtonElement>("reset").click();
  }
});

// legend
const legend = el<HTMLDivElement>("legend");
for (const [cls, label] of Object.entries(CLASS_LABELS) as [ProtectionClass, string][]) {
  if (cls === "service") continue; // same color as quiet_street
  const sw = document.createElement("i");
  sw.style.background = CLASS_COLORS[cls];
  legend.appendChild(sw);
  const span = document.createElement("span");
  span.textContent = label;
  legend.appendChild(span);
}

// ---------------------------------------------------------------------------
// about dialog: methodology + live data freshness
// ---------------------------------------------------------------------------

interface DataMeta {
  built: string;
  sources: { name: string; retrieved: string; features: number }[];
}

function fillAbout(): void {
  const multTable = el<HTMLTableElement>("mult-table");
  if (multTable.rows.length > 0) return; // already filled
  const yk = PROFILES.young_kids;
  const rows = (Object.entries(yk.mult) as [ProtectionClass, number][])
    .sort((a, b) => a[1] - b[1])
    .map(
      ([cls, m]) =>
        `<tr><td><i style="display:inline-block;width:12px;height:5px;border-radius:2px;` +
        `background:${CLASS_COLORS[cls]}"></i> ${CLASS_LABELS[cls]}</td>` +
        `<td>×${m}</td></tr>`,
    );
  rows.push(
    `<tr><td>painted lane on a busy road</td><td>×${yk.busyLane}</td></tr>`,
    `<tr><td>buffered lane on a busy road</td><td>×${yk.busyBuffered}</td></tr>`,
  );
  multTable.innerHTML = `<tr><th>street type</th><th>cost</th></tr>${rows.join("")}`;
  void dataReady
    .then(() => loadJson<DataMeta>("meta.json"))
    .then((meta: DataMeta | null) => {
      if (!meta) return;
      const remote = usingRemoteData();
      el<HTMLElement>("built-date").textContent =
        meta.built + (remote !== null ? " (live from the website)" : "");
      const table = el<HTMLTableElement>("freshness-table");
      for (const s of meta.sources) {
        const tr = table.insertRow();
        tr.insertCell().textContent = s.name.replace(/_/g, " ");
        tr.insertCell().textContent = s.retrieved;
        tr.insertCell().textContent = String(s.features);
      }
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// hazard reports (category + note + photo), stored on-device
// ---------------------------------------------------------------------------

async function refreshHazards(): Promise<void> {
  try {
    hazards = await listHazards();
  } catch {
    hazards = [];
  }
  applyAvoidPoints();
  const features = hazards.map((h) => ({
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
  el<HTMLDivElement>("hazard-loc").textContent =
    `at ${lat.toFixed(5)}, ${lon.toFixed(5)} — saved reports appear on the map and routes avoid them`;
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

el<HTMLButtonElement>("hazard-share").addEventListener("click", () => {
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

el<HTMLButtonElement>("nav-report").addEventListener("click", () => {
  if (navLastPos) openHazardDialog(navLastPos[0], navLastPos[1]);
});

// ---------------------------------------------------------------------------
// ride history dialog
// ---------------------------------------------------------------------------

function showRideOnMap(ride: RideSummary): void {
  getSource("history").setData({
    type: "Feature",
    geometry: { type: "LineString", coordinates: ride.polyline },
    properties: {},
  } as GeoJSON.GeoJSON);
  const lons = ride.polyline.map((p) => p[0]);
  const lats = ride.polyline.map((p) => p[1]);
  if (lons.length > 1) {
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 60, duration: 800 },
    );
  }
}

/** Share text + a rendered PNG card via the native share sheet; falls back to
 * downloading the image and copying the text. */
function shareContent(text: string, imagePromise: Promise<Blob>, filename: string): void {
  void imagePromise
    .then((blob) => {
      const file = new File([blob], filename, { type: "image/png" });
      const payload = { text, files: [file] };
      if (typeof navigator.canShare === "function" && navigator.canShare(payload)) {
        return navigator.share(payload).catch(() => undefined);
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      return navigator.clipboard.writeText(text).catch(() => undefined);
    })
    .catch(() => {
      // canvas unavailable: share/copy the text alone
      if (typeof navigator.share === "function") {
        void navigator.share({ text }).catch(() => undefined);
      } else {
        void navigator.clipboard.writeText(text).catch(() => undefined);
      }
    });
}

function renderRides(): void {
  const rides = loadRides();
  const totals = rideTotals(rides, new Date());
  el<HTMLDivElement>("ride-totals").innerHTML =
    rides.length === 0
      ? "No rides yet — rides are saved automatically when you Navigate, or use ● Record."
      : `<b>${totals.count}</b> rides · <b>${totals.km} km</b> total · ` +
        `<b>${totals.movingHours} h</b> moving · longest <b>${totals.longestKm} km</b> · ` +
        `this month <b>${totals.thisMonthKm} km</b> · avg <b>${totals.avgProtectedPct}%</b> protected`;
  el<HTMLButtonElement>("rides-share").style.display = rides.length === 0 ? "none" : "inline-block";
  const table = el<HTMLTableElement>("ride-list");
  table.innerHTML =
    rides.length === 0
      ? ""
      : "<tr><th>date</th><th>km</th><th>moving</th><th>avg</th><th>protected</th><th></th></tr>";
  for (const ride of rides) {
    const tr = table.insertRow();
    const d = new Date(ride.startedAt);
    tr.insertCell().textContent = d.toLocaleDateString([], { month: "short", day: "numeric" });
    tr.insertCell().textContent = (ride.meters / 1000).toFixed(1);
    tr.insertCell().textContent = `${Math.round(ride.movingS / 60)} min`;
    tr.insertCell().textContent =
      ride.movingS > 0 ? `${((ride.meters / ride.movingS) * 3.6).toFixed(1)} km/h` : "–";
    tr.insertCell().textContent = `${ride.pctProtected}% + ${ride.pctQuiet}% quiet`;
    const actions = tr.insertCell();
    const show = document.createElement("button");
    show.textContent = "map";
    show.addEventListener("click", () => {
      showRideOnMap(ride);
      el<HTMLDialogElement>("rides").close();
    });
    actions.appendChild(show);
    const shareBtn = document.createElement("button");
    shareBtn.textContent = "📤";
    shareBtn.title = "share this ride (stats card + text)";
    shareBtn.addEventListener("click", () => {
      shareContent(rideShareText(ride), drawRideCard(ride), "bike-ride.png");
    });
    actions.appendChild(shareBtn);
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      deleteRide(ride.id);
      renderRides();
    });
    actions.appendChild(rm);
  }
}

el<HTMLButtonElement>("rides-btn").addEventListener("click", () => {
  renderRides();
  el<HTMLDialogElement>("rides").showModal();
});
el<HTMLButtonElement>("rides-close").addEventListener("click", () => {
  el<HTMLDialogElement>("rides").close();
});
el<HTMLButtonElement>("rides-share").addEventListener("click", () => {
  const totals = rideTotals(loadRides(), new Date());
  shareContent(totalsShareText(totals), drawTotalsCard(totals), "bike-stats.png");
});

el<HTMLButtonElement>("rides-clear").addEventListener("click", () => {
  clearRides();
  getSource("history").setData(emptyFC());
  renderRides();
});
el<HTMLDialogElement>("rides").addEventListener("click", (e: MouseEvent) => {
  if (e.target === el<HTMLDialogElement>("rides")) el<HTMLDialogElement>("rides").close();
});

el<HTMLButtonElement>("mapillary-save").addEventListener("click", () => {
  const token = el<HTMLInputElement>("mapillary-token").value.trim();
  mapillaryToken = token;
  if (token === "") localStorage.removeItem("mapillaryToken");
  else localStorage.setItem("mapillaryToken", token);
  segPhotoCache.clear();
  el<HTMLSpanElement>("mapillary-status").textContent =
    token === "" ? "cleared" : "✓ saved — hover any street";
});

el<HTMLButtonElement>("about-btn").addEventListener("click", () => {
  el<HTMLInputElement>("mapillary-token").value = mapillaryToken;
  fillAbout();
  el<HTMLDialogElement>("about").showModal();
});
el<HTMLButtonElement>("about-close").addEventListener("click", () => {
  el<HTMLDialogElement>("about").close();
});
el<HTMLDialogElement>("about").addEventListener("click", (e: MouseEvent) => {
  if (e.target === el<HTMLDialogElement>("about")) el<HTMLDialogElement>("about").close();
});

// ---------------------------------------------------------------------------
// turn-by-turn navigation: follows the GPS along the selected route with a
// banner, voice instructions, wake lock, and automatic rerouting
// ---------------------------------------------------------------------------

const OFF_ROUTE_M = 40;
const OFF_ROUTE_STRIKES = 3;
/** Ignore fixes with worse GPS accuracy than this for off-route decisions. */
const MAX_GPS_ACCURACY_M = 50;
/** Minimum time between automatic reroutes. */
const REROUTE_COOLDOWN_MS = 10_000;
const ANNOUNCE_FAR_M = 90;
const ANNOUNCE_NOW_M = 25;

let navActive = false;
let navWatchId: number | null = null;
let navTrack: Track | null = null;
let navManeuvers: Maneuver[] = [];
let navNext = 0;
/** 0 = nothing announced for navNext, 1 = "in X m" said, 2 = "now" said */
let navAnnounceStage = 0;
let navHint = -1;
let navMuted = false;
let navFollowing = true;
let navDest: [number, number] | null = null;
let navOffCount = 0;
let navDot: Marker | null = null;
let navArrived = false;
let wakeLock: WakeLockSentinel | null = null;
let navAlerts: RideAlert[] = [];
let navAlertNext = 0;
let navLastPos: [number, number] | null = null;
/** Set while detouring to a kid stop: where the ride was originally headed. */
let navOriginalDest: [number, number] | null = null;
let navNextKm = 1;
let navHalfway = false;
let navLastRerouteAt = 0;
/** "go with my street choice": reroutes respect the rider's direction. */
let navMyWay = localStorage.getItem("navMyWay") === "1";
let navPrevPos: [number, number] | null = null;
let navHeading: number | null = null;
let recorder: RideRecorder | null = null;
let recordMode = false;
let recordWatchId: number | null = null;
/** Background (native) watcher ids — used instead of web watches in the app. */
let navBgWatcherId: string | null = null;
let recordBgWatcherId: string | null = null;

/** Free-record auto-stop: end the ride after this long with no movement. */
const RECORD_IDLE_STOP_MS = 10 * 60_000;

function finishAndSaveRide(): void {
  const ride = recorder?.finish(profileId);
  recorder = null;
  if (!ride) return;
  saveRide(ride);
  speak(`ride saved. ${(ride.meters / 1000).toFixed(1)} kilometers.`);
}

function vibrate(pattern: number[]): void {
  if ("vibrate" in navigator) navigator.vibrate(pattern);
}

function speak(text: string): void {
  if (navMuted) return;
  void nativeSpeak(text).then((spoken) => {
    if (spoken || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    window.speechSynthesis.speak(utter);
  });
}

function rebuildNavFromSelected(): boolean {
  const sel = options.find((o) => o.id === selectedId);
  if (!sel) return false;
  navTrack = buildTrack(sel.payload);
  navManeuvers = buildManeuvers(sel.payload);
  navAlerts = buildAlerts(sel.payload);
  navNext = 0;
  navAlertNext = 0;
  navAnnounceStage = 0;
  navHint = -1;
  navArrived = false;
  navNextKm = 1;
  navHalfway = false;
  return true;
}

function navUpdateBanner(distToNext: number, remainingM: number): void {
  const m = navManeuvers[navNext];
  el<HTMLElement>("nav-icon").textContent = m?.icon ?? "⬆";
  el<HTMLElement>("nav-dist").textContent =
    distToNext < 15 ? "now" : fmtDist(Math.round(distToNext / 10) * 10);
  el<HTMLElement>("nav-street").textContent = m?.text ?? "";
  const mins = Math.round((remainingM / 1000 / PROFILES[profileId].paceKmh) * 60);
  el<HTMLElement>("nav-remaining").textContent =
    `${fmtDist(remainingM)} to go · ~${mins} min`;
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

function navOnPosition(pos: GeolocationPosition): void {
  navOnFix(toFix(pos));
}

function navOnFix(fix: NativeFix): void {
  if (!navActive || !navTrack || !router) return;
  const lon = fix.lon;
  const lat = fix.lat;
  navLastPos = [lon, lat];
  // travel direction: GPS heading when moving, else derived from movement
  const gpsHeading = fix.heading;
  if (gpsHeading !== null && !Number.isNaN(gpsHeading) && (fix.speed ?? 0) > 0.7) {
    navHeading = gpsHeading;
  } else if (navPrevPos && distM(navPrevPos, [lon, lat]) > 5) {
    navHeading = (bearingDeg(navPrevPos, [lon, lat]) + 360) % 360;
  }
  if (!navPrevPos || distM(navPrevPos, [lon, lat]) > 3) navPrevPos = [lon, lat];
  recorder?.addPoint(Date.now(), lon, lat, router.edgeClassAt(lon, lat));
  if (!navDot) {
    const dot = document.createElement("div");
    dot.className = "nav-dot";
    navDot = new maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(map);
  } else {
    navDot.setLngLat([lon, lat]);
  }
  const snap = snapToTrack(navTrack, lon, lat, navHint);

  // off-route: a few good fixes in a row trigger a reroute to the destination
  // (like Google Maps — ride wherever you like, the route follows you)
  if (snap.offM > OFF_ROUTE_M) {
    // a poor GPS fix shouldn't count as a deviation
    if (fix.accuracy > MAX_GPS_ACCURACY_M) return;
    navOffCount++;
    // instant feedback while we make sure it's a real deviation
    el<HTMLElement>("nav-icon").textContent = "↩";
    el<HTMLElement>("nav-dist").textContent = "off route";
    el<HTMLElement>("nav-street").textContent = "adjusting…";
    const now = Date.now();
    if (navOffCount >= OFF_ROUTE_STRIKES && navDest && now - navLastRerouteAt > REROUTE_COOLDOWN_MS) {
      navOffCount = 0;
      navLastRerouteAt = now;
      const useMyWay = navMyWay && navHeading !== null;
      speak(useMyWay ? "okay, going your way." : "rerouting.");
      vibrate([80, 60, 80]);
      try {
        const bias =
          useMyWay && navHeading !== null
            ? router.headingBias([lon, lat], navHeading)
            : undefined;
        options = router.routeOptions([lon, lat], navDest, profileId, preferFlat, bias, avoidTypes);
        const first = options[0];
        if (first) {
          selectOption(first.id);
          rebuildNavFromSelected();
        }
      } catch {
        el<HTMLElement>("nav-street").textContent = "off route — can't reroute here";
      }
    }
    return;
  }
  navOffCount = 0;
  navHint = snap.idx;

  // advance past maneuvers we've already ridden through
  while (navNext < navManeuvers.length - 1 && (navManeuvers[navNext]?.atM ?? 0) < snap.alongM - 20) {
    navNext++;
    navAnnounceStage = 0;
  }
  const next = navManeuvers[navNext];
  const distToNext = Math.max(0, (next?.atM ?? 0) - snap.alongM);
  const remaining = Math.max(0, navTrack.totalM - snap.alongM);
  navUpdateBanner(distToNext, remaining);

  if (next && navAnnounceStage < 2 && distToNext <= ANNOUNCE_NOW_M) {
    speak(next.voice);
    vibrate([200]);
    navAnnounceStage = 2;
  } else if (next && navAnnounceStage < 1 && distToNext <= ANNOUNCE_FAR_M) {
    speak(`in ${Math.round(distToNext / 10) * 10} meters, ${next.voice}`);
    vibrate([100]);
    navAnnounceStage = 1;
  }

  // hazard alerts (voice + distinct buzz), announced ~100 m out
  while (navAlertNext < navAlerts.length && (navAlerts[navAlertNext]?.atM ?? 0) < snap.alongM - 10) {
    navAlertNext++;
  }
  const alert = navAlerts[navAlertNext];
  if (alert && alert.atM - snap.alongM <= 100) {
    speak(alert.voice);
    vibrate([100, 80, 100]);
    navAlertNext++;
  }

  // kid morale: kilometer milestones and the halfway mark
  if (snap.alongM >= navNextKm * 1000) {
    speak(`${navNextKm} kilometer${navNextKm > 1 ? "s" : ""} done. nice riding!`);
    navNextKm++;
  }
  if (!navHalfway && navTrack.totalM > 1500 && snap.alongM >= navTrack.totalM / 2) {
    navHalfway = true;
    speak("halfway there!");
  }

  if (remaining < 15 && !navArrived) {
    navArrived = true;
    vibrate([200, 100, 200]);
    if (navOriginalDest) {
      speak("arrived at your stop. tap resume when you're ready to ride on.");
      el<HTMLElement>("nav-dist").textContent = "🛑";
      el<HTMLElement>("nav-street").textContent = "at the stop — resume when ready";
      el<HTMLButtonElement>("nav-resume").style.display = "inline-block";
    } else {
      speak(
        `you have arrived. ${(navTrack.totalM / 1000).toFixed(1)} kilometers — nicely done!`,
      );
      el<HTMLElement>("nav-dist").textContent = "🏁";
      el<HTMLElement>("nav-street").textContent = "arrived!";
      finishAndSaveRide();
    }
  }

  if (navFollowing) {
    map.easeTo({
      center: [lon, lat],
      zoom: 16.8,
      pitch: 50,
      bearing: trackBearing(navTrack, snap.idx),
      duration: 900,
    });
  }
}

async function startNav(): Promise<void> {
  if (!rebuildNavFromSelected()) return;
  const destLngLat = end?.getLngLat() ?? start?.getLngLat();
  if (!destLngLat) return;
  navDest = [destLngLat.lng, destLngLat.lat];
  navOriginalDest = null;
  el<HTMLButtonElement>("nav-resume").style.display = "none";
  navActive = true;
  navFollowing = true;
  recorder = new RideRecorder();
  document.body.classList.add("navigating");
  el<HTMLDivElement>("nav-banner").style.display = "block";
  el<HTMLButtonElement>("nav-recenter").style.display = "none";
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null; // unsupported or denied — navigation still works
  }
  if (isNativeApp()) {
    // native app: background watcher keeps GPS + voice alive with the
    // screen off (shows a persistent notification while navigating)
    navBgWatcherId = await startBackgroundWatcher(
      "Family Bike Router",
      "Turn-by-turn navigation is running",
      navOnFix,
      (message) => {
        el<HTMLElement>("nav-street").textContent = message;
      },
    );
  }
  if (navBgWatcherId === null) {
    navWatchId = navigator.geolocation.watchPosition(
      navOnPosition,
      () => {
        el<HTMLElement>("nav-street").textContent = "location unavailable — check permissions";
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }
  speak("navigation started");
}

function exitNav(): void {
  finishAndSaveRide();
  navActive = false;
  navOriginalDest = null;
  navLastPos = null;
  if (navWatchId !== null) navigator.geolocation.clearWatch(navWatchId);
  navWatchId = null;
  if (navBgWatcherId !== null) void stopBackgroundWatcher(navBgWatcherId);
  navBgWatcherId = null;
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  navDot?.remove();
  navDot = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  document.body.classList.remove("navigating");
  el<HTMLDivElement>("nav-banner").style.display = "none";
  const threeD = el<HTMLInputElement>("show-3d").checked;
  map.easeTo({ pitch: threeD ? 60 : 0, bearing: 0, duration: 800 });
}

/** Mid-ride detour: reroute to the nearest kid stop of a kind, remembering
 * the original destination for the resume button. */
function detourToNearest(kind: "water" | "restroom" | "playground"): void {
  if (!navActive || !router || !navLastPos) return;
  const candidates = pois.filter((p) => p.properties.kind === kind);
  const idx = router.nearestReachable(
    navLastPos,
    candidates.map((p) => p.geometry.coordinates),
    profileId,
    preferFlat,
  );
  const poi = idx !== null ? candidates[idx] : undefined;
  if (!poi) {
    speak(`no ${kind === "water" ? "water fountain" : kind} found nearby`);
    return;
  }
  try {
    options = router.routeOptions(
      navLastPos, poi.geometry.coordinates, profileId, preferFlat, undefined, avoidTypes,
    );
    const first = options[0];
    if (!first) return;
    selectOption(first.id);
    if (navOriginalDest === null) navOriginalDest = navDest;
    navDest = poi.geometry.coordinates;
    rebuildNavFromSelected();
    const label = poi.properties.name || POI_META[kind]?.label || kind;
    speak(
      `detour: ${label} is ${fmtDist(first.payload.summary.meters)} away. follow the route.`,
    );
  } catch (err) {
    speak("could not plan a detour from here");
    void err;
  }
}

el<HTMLButtonElement>("nav-water").addEventListener("click", () => {
  detourToNearest("water");
});
el<HTMLButtonElement>("nav-restroom").addEventListener("click", () => {
  detourToNearest("restroom");
});
el<HTMLButtonElement>("nav-playground").addEventListener("click", () => {
  detourToNearest("playground");
});

el<HTMLButtonElement>("nav-resume").addEventListener("click", () => {
  if (!router || !navLastPos || !navOriginalDest) return;
  try {
    options = router.routeOptions(
      navLastPos, navOriginalDest, profileId, preferFlat, undefined, avoidTypes,
    );
    const first = options[0];
    if (!first) return;
    selectOption(first.id);
    navDest = navOriginalDest;
    navOriginalDest = null;
    rebuildNavFromSelected();
    el<HTMLButtonElement>("nav-resume").style.display = "none";
    speak("back on the way. let's go!");
  } catch {
    speak("could not plan the way back from here");
  }
});

el<HTMLButtonElement>("nav-myway").classList.toggle("active", navMyWay);
el<HTMLButtonElement>("nav-myway").addEventListener("click", () => {
  navMyWay = !navMyWay;
  localStorage.setItem("navMyWay", navMyWay ? "1" : "0");
  el<HTMLButtonElement>("nav-myway").classList.toggle("active", navMyWay);
  speak(
    navMyWay
      ? "going your way: reroutes will follow your direction."
      : "back to safest: reroutes return to the safest path.",
  );
});

el<HTMLButtonElement>("nav-hazard").addEventListener("click", () => {
  if (!navLastPos) return;
  sketchyMarks.push(navLastPos);
  saveSketchy(sketchyMarks);
  applyAvoidPoints();
  renderSketchy();
  vibrate([80]);
  speak("marked. future routes will avoid this spot.");
});

// ---------------------------------------------------------------------------
// free ride recording (no planned route): ● Record in the tool row
// ---------------------------------------------------------------------------

function recordOnPosition(pos: GeolocationPosition): void {
  recordOnFix(toFix(pos));
}

function recordOnFix(fix: NativeFix): void {
  if (!recordMode || !recorder) return;
  const lon = fix.lon;
  const lat = fix.lat;
  navLastPos = [lon, lat];
  if (!navDot) {
    const dot = document.createElement("div");
    dot.className = "nav-dot";
    navDot = new maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(map);
  } else {
    navDot.setLngLat([lon, lat]);
  }
  recorder.addPoint(Date.now(), lon, lat, router?.edgeClassAt(lon, lat) ?? null);
  el<HTMLElement>("nav-dist").textContent = fmtDist(recorder.metersSoFar);
  const mins = Math.round(recorder.durationSoFar / 60);
  el<HTMLElement>("nav-remaining").textContent = `recording · ${mins} min`;
  if (navFollowing) {
    map.easeTo({ center: [lon, lat], zoom: 16, duration: 900 });
  }
  if (Date.now() - recorder.lastMovedAt > RECORD_IDLE_STOP_MS) {
    speak("no movement for a while.");
    stopRecording();
  }
}

function startRecording(): void {
  if (navActive || recordMode) return;
  recordMode = true;
  recorder = new RideRecorder();
  navFollowing = true;
  document.body.classList.add("navigating");
  el<HTMLDivElement>("nav-banner").style.display = "block";
  el<HTMLDivElement>("nav-tools").style.display = "none";
  el<HTMLElement>("nav-icon").textContent = "🔴";
  el<HTMLElement>("nav-dist").textContent = "0 m";
  el<HTMLElement>("nav-street").textContent = "recording ride…";
  el<HTMLElement>("nav-remaining").textContent = "";
  void navigator.wakeLock
    ?.request("screen")
    .then((wl) => {
      wakeLock = wl;
    })
    .catch(() => undefined);
  void (async () => {
    if (isNativeApp()) {
      recordBgWatcherId = await startBackgroundWatcher(
        "Family Bike Router",
        "Recording your ride",
        recordOnFix,
        (message) => {
          el<HTMLElement>("nav-street").textContent = message;
        },
      );
    }
    if (recordBgWatcherId === null) {
      recordWatchId = navigator.geolocation.watchPosition(
        recordOnPosition,
        () => {
          el<HTMLElement>("nav-street").textContent = "location unavailable — check permissions";
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
      );
    }
  })();
  speak("recording. ride on!");
}

function stopRecording(): void {
  if (!recordMode) return;
  recordMode = false;
  if (recordWatchId !== null) navigator.geolocation.clearWatch(recordWatchId);
  recordWatchId = null;
  if (recordBgWatcherId !== null) void stopBackgroundWatcher(recordBgWatcherId);
  recordBgWatcherId = null;
  finishAndSaveRide();
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  navDot?.remove();
  navDot = null;
  navLastPos = null;
  document.body.classList.remove("navigating");
  el<HTMLDivElement>("nav-banner").style.display = "none";
  el<HTMLDivElement>("nav-tools").style.display = "block";
}

el<HTMLButtonElement>("record-btn").addEventListener("click", () => {
  if (recordMode) stopRecording();
  else startRecording();
});

el<HTMLButtonElement>("nav-btn").addEventListener("click", () => {
  void startNav();
});
el<HTMLButtonElement>("nav-exit").addEventListener("click", () => {
  if (recordMode) stopRecording();
  else exitNav();
});
el<HTMLButtonElement>("nav-mute").addEventListener("click", () => {
  navMuted = !navMuted;
  el<HTMLButtonElement>("nav-mute").textContent = navMuted ? "🔇" : "🔊";
  if (navMuted && "speechSynthesis" in window) window.speechSynthesis.cancel();
});
el<HTMLButtonElement>("nav-recenter").addEventListener("click", () => {
  navFollowing = true;
  el<HTMLButtonElement>("nav-recenter").style.display = "none";
});
map.on("dragstart", () => {
  if (navActive) {
    navFollowing = false;
    el<HTMLButtonElement>("nav-recenter").style.display = "inline-block";
  }
});

// ---------------------------------------------------------------------------
// offline: pre-cache basemap tiles along the selected route (zooms 13-16,
// ~1-tile corridor) into the service worker's tile cache
// ---------------------------------------------------------------------------

const TILE_CACHE = "bike-tiles-v1";

function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latR = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n);
  return [x, y];
}

function routeTileUrls(track: Track): string[] {
  const dark = document.body.classList.contains("dark");
  const template = dark
    ? "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
    : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const urls = new Set<string>();
  for (const z of [13, 14, 15, 16]) {
    // sample the track densely enough that no tile is skipped at this zoom
    const stepM = z >= 16 ? 150 : 400;
    let nextAt = 0;
    track.coords.forEach((c, i) => {
      if ((track.cumM[i] ?? 0) < nextAt && i !== track.coords.length - 1) return;
      nextAt = (track.cumM[i] ?? 0) + stepM;
      const [x, y] = tileXY(c[0], c[1], z);
      const spread = z >= 15 ? 1 : 0; // 3x3 corridor at high zooms
      for (let dx = -spread; dx <= spread; dx++) {
        for (let dy = -spread; dy <= spread; dy++) {
          urls.add(
            template
              .replace("{z}", String(z))
              .replace("{x}", String(x + dx))
              .replace("{y}", String(y + dy)),
          );
        }
      }
    });
  }
  return [...urls];
}

el<HTMLButtonElement>("offline-btn").addEventListener("click", () => {
  const sel = options.find((o) => o.id === selectedId);
  if (!sel) return;
  const btn = el<HTMLButtonElement>("offline-btn");
  const urls = routeTileUrls(buildTrack(sel.payload));
  btn.disabled = true;
  let done = 0;
  void caches
    .open(TILE_CACHE)
    .then(async (cache) => {
      const pool = 6;
      const queue = [...urls];
      const worker = async (): Promise<void> => {
        for (;;) {
          const url = queue.shift();
          if (url === undefined) return;
          try {
            if ((await cache.match(url)) === undefined) {
              const resp = await fetch(url, { mode: "no-cors" });
              await cache.put(url, resp);
            }
          } catch {
            // offline mid-download or a missing tile: skip
          }
          done++;
          btn.textContent = `⬇ ${done}/${urls.length}…`;
        }
      };
      await Promise.all(Array.from({ length: pool }, worker));
      btn.textContent = "✓ offline ready";
    })
    .finally(() => {
      btn.disabled = false;
      window.setTimeout(() => {
        btn.textContent = "⬇ Offline map";
      }, 4000);
    });
});

// ---------------------------------------------------------------------------
// dark mode (night rides): dark basemap + dark UI, persisted; defaults to the
// system color scheme
// ---------------------------------------------------------------------------

function applyBasemap(): void {
  const dark = document.body.classList.contains("dark");
  const aerial = el<HTMLInputElement>("show-aerial").checked;
  const netOn = el<HTMLInputElement>("show-net").checked;
  const setVis = (): void => {
    map.setLayoutProperty("aerial", "visibility", aerial ? "visible" : "none");
    map.setLayoutProperty("osm-dark", "visibility", !aerial && dark ? "visible" : "none");
    map.setLayoutProperty("osm", "visibility", !aerial && !dark ? "visible" : "none");
    map.setPaintProperty("route-casing", "line-color", dark || aerial ? "#9db8ff" : "#1440a0");
    map.setPaintProperty("alts", "line-color", dark || aerial ? "#ccc" : "#777");
    // over photos the lanes need contrast: dark halo + thicker, solid lines
    map.setLayoutProperty(
      "network-casing",
      "visibility",
      aerial && netOn ? "visible" : "none",
    );
    const width: unknown = aerial
      ? ["interpolate", ["linear"], ["zoom"], 12, 2.0, 16, 5.0]
      : ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 3.5];
    for (const layer of ["network", "network-unconfirmed"]) {
      map.setPaintProperty(layer, "line-width", width);
      map.setPaintProperty(layer, "line-opacity", aerial ? 0.95 : 0.75);
    }
  };
  // map.loaded() is false whenever tiles are streaming, and "load" fires only
  // once per map — gate on layer existence instead, or toggles made while
  // tiles load would be silently dropped
  if (map.getLayer("osm-dark") !== undefined) setVis();
  else map.once("load", setVis);
}

function applyDark(dark: boolean): void {
  document.body.classList.toggle("dark", dark);
  el<HTMLInputElement>("dark-mode").checked = dark;
  applyBasemap();
}

const storedDark = localStorage.getItem(DARK_KEY);
const initialDark =
  storedDark !== null
    ? storedDark === "1"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
applyDark(initialDark);

el<HTMLInputElement>("dark-mode").addEventListener("change", (e: Event) => {
  const dark = (e.target as HTMLInputElement).checked;
  localStorage.setItem(DARK_KEY, dark ? "1" : "0");
  applyDark(dark);
});

el<HTMLInputElement>("show-aerial").addEventListener("change", applyBasemap);

el<HTMLInputElement>("show-constr").addEventListener("change", (e: Event) => {
  const on = (e.target as HTMLInputElement).checked;
  for (const layer of ["construction-lines", "construction-pts"]) {
    map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
  }
});

renderPlacesAndRecent();

// test hook: E2E (Playwright) asserts on live layer state through this
declare global {
  interface Window {
    _map?: MLMap;
  }
}
window._map = map;

// ---------------------------------------------------------------------------
// in-app update check (native app only): compare the bundled build version
// against the latest release published next to the mirrored APK
// ---------------------------------------------------------------------------

const APK_URL = "https://pelednoam.github.io/safe-bikes-lanes/app/family-bike-router.apk";

async function checkAppUpdate(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const bundled = (await (await fetch("version.json")).json()) as { version?: string };
    const resp = await fetch(
      "https://pelednoam.github.io/safe-bikes-lanes/app/version.json",
      { cache: "no-store" },
    );
    if (!resp.ok) return;
    const latest = (await resp.json()) as { version?: string };
    if (
      bundled.version === undefined ||
      latest.version === undefined ||
      !isNewerAppVersion(bundled.version, latest.version)
    ) {
      return;
    }
    const banner = el<HTMLDivElement>("update-banner");
    el<HTMLElement>("update-text").textContent =
      `Update available: ${bundled.version} → ${latest.version}`;
    banner.style.display = "flex";
    const getBtn = el<HTMLAnchorElement>("update-get");
    getBtn.href = APK_URL; // static fallback so a tap works even without JS
    const text = el<HTMLElement>("update-text");
    const label = `Update available: ${bundled.version} → ${latest.version}`;
    getBtn.addEventListener("click", (ev: Event) => {
      ev.preventDefault();
      text.textContent = "opening download… (check your notifications)";
      void openExternal(APK_URL).then((ok) => {
        if (!ok) {
          text.innerHTML =
            `${label} — <a href="${APK_URL}" style="color:inherit;text-decoration:underline">` +
            `tap here to download</a>`;
        }
      });
    });
    el<HTMLButtonElement>("update-dismiss").addEventListener("click", () => {
      banner.style.display = "none";
    });
  } catch {
    // offline or first launch — try again next time
  }
}
void checkAppUpdate();

// service worker: register only on the website (PWA offline). In the native
// app Capacitor already bundles everything offline, and a persistent SW would
// serve a STALE app shell across APK updates (its origin outlives installs) —
// so unregister any existing one, clear the cached shell, and reload once to
// drop the stale shell immediately.
if ("serviceWorker" in navigator) {
  if (isNativeApp()) {
    void (async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      let had = false;
      for (const r of regs) {
        had = true;
        await r.unregister();
      }
      try {
        for (const k of await caches.keys()) {
          if (k.startsWith("family-bike-router") || k.startsWith("bike-tiles")) {
            await caches.delete(k);
          }
        }
      } catch {
        // caches API unavailable in this webview — nothing to clear
      }
      if (had && navigator.serviceWorker.controller && !sessionStorage.getItem("swCleared")) {
        sessionStorage.setItem("swCleared", "1");
        location.reload();
      }
    })();
  } else {
    // web PWA: auto-update to the newest build without a hard refresh.
    // Reload once when a NEW service worker takes control — but only if one
    // was already controlling at load (i.e. a genuine update, not first visit,
    // so we never reload-loop on initial install/clients.claim).
    if (navigator.serviceWorker.controller) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
    // updateViaCache:"none" — always fetch sw.js fresh so updates are detected
    void navigator.serviceWorker
      .register("sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => undefined);
  }
}
