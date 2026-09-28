// Frontend for the family bike router. Routing runs fully in the browser
// (see router.ts); class colors mirror pipeline/config.py.
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LngLat,
  Map as MLMap,
  MapLayerMouseEvent,
  MapMouseEvent,
  Marker,
  Popup,
} from "maplibre-gl";

import {
  BASEMAP_MAXZOOM,
  BASEMAP_SOURCE,
  type BasemapTheme,
  basemapSource,
  createBasemap,
  tileDeps,
} from "./basemap.js";
import { maplibregl } from "./maplibre.js";
import { CLASS_COLORS } from "./weights.gen.js";
import { downloadOffline, type TileXYZ } from "./tilecache.js";
import type { NativeFix } from "./native.js";
import {
  askForRideNotifications,
  isNativeApp,
  isNewerAppVersion,
  keepScreenOn,
  lastNativeSpeechError,
  locationAdvice,
  minimizeApp,
  nativeLocationAllowed,
  nativeSpeak,
  nativeStopSpeech,
  onAndroidBack,
  rideLocationState,
  setSystemBarsDark,
  startDownload,
  startBackgroundWatcher,
  stopBackgroundWatcher,
  webVoiceCount,
} from "./native.js";
import {
  type Candidate,
  GEOCODE_DEBOUNCE_MS,
  geocodeDelayMs,
  matchScore,
  metresBetween,
  rank as rankSearch,
  describe as describeRow,
  type Ranked,
  worthGeocoding,
} from "./search.js";
import {
  CLASS_LABELS,
  cautionsHtml,
  clearPhotoCache,
  esc,
  FACILITY_CLASSES,
  nearestMapillary,
  fillSegmentPhoto as fillPhotoSlot,
  GRADE_COLORS,
  GRADE_TEXT,
  segmentHtml,
} from "./segment.js";
import type { Maneuver, Track } from "./nav.js";
import { buildTrack, distM, sunsetTime } from "./nav.js";
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
import type { RecentRoute, SavedPlace } from "./places.js";
import {
  clearRecent,
  deletePlace,
  emojiFor,
  exportBackup,
  importBackup,
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
  stashInProgress,
  takeInProgress,
} from "./rides.js";
import { dataUrl, initDataSource, loadJson, usingRemoteData } from "./data.js";
import { buildCues, PROFILES, Router, routeCacheKey, toGPX } from "./router.js";
import {
  distVoice,
  fmtDist,
  fmtClimb,
  fmtDistTight,
  fmtSpeed,
  fmtSpeedRound,
  fromMeters,
  getUnits,
  lengthVoice,
  setUnits,
  toMeters,
  unitName,
  unitShort,
} from "./units.js";
import { NetworkTiles, TileStore } from "./tiles.js";
import { withRetry } from "./retry.js";
import { Lane, planOptions, type RoutePrefs, type Ticket, withUpgraded } from "./planner.js";
import { type SpeakPriority, SpeechQueue } from "./speech.js";
import { loopRejoinPoint, payloadLength, rejoinOption } from "./rejoin.js";
import { decodePlan, encodePlan } from "./permalink.js";
import { downloadBlob, PreparedImage, shareImage } from "./share.js";
import { readItem, readJson, removeItem, trimRecord, writeItem } from "./storage.js";
import { DeferredReload, ScreenLock, type WakeLockApi } from "./lifecycle.js";
import { drawRideCard, drawTotalsCard, rideShareText, totalsShareText } from "./sharecard.js";
import type {
  PoiFeature,
  ProfileId,
  ProtectionClass,
  SafetyGrade,
  RouteOption,
  RouteSummary,
} from "./types.js";

interface NominatimResult {
  display_name: string;
  lon: string;
  lat: string;
  /** jsonv2's short label ("Kendall/MIT"), when it has one: the full
   * display_name is five commas of address that no row has space for. */
  name?: string;
}

// First, before anything that could throw: this module parsed and is running.
// compat.js checks for it at DOMContentLoaded, and without it tells the rider
// their browser can't run the app, rather than leaving a blank map.
window.__appStarted = true;

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
// Safety classes told apart by more than hue
//
// The palette runs green to red, which is the axis colour-blind riders lose:
// simulated for deuteranopia a quiet street and a painted lane differ by a ΔE
// of 1.3 (the same colour), and a buffered lane and a sharrow by 6.2; for
// protanopia an off-street path and a moderate street by 4.1. The hues stay
// (the owner's call); each class also gets a width and a mark, the same on the
// map, on the route, in the legend and in the ride's class bar:
//
//   protected (path, separated, buffered)  plain, and the widest lines
//   quiet street / alley                   plain and thin
//   unpaved path                           short dark dashes: a path, but rough
//   painted lane                           a dark dash down the middle
//   sharrow                                a row of dark dots
//   moderate street                        dark ticks across it, spaced
//   busy street                            dark ticks across it, close — hatched
//
// Ticks for the two classes a child should not be on make "warning" something
// you can see without red. Plain means safe; marked means read the mark.
// ---------------------------------------------------------------------------

/** Line width relative to an ordinary street. */
const CLASS_WIDTH: Record<ProtectionClass, number> = {
  path: 1.7,
  separated: 1.5,
  buffered: 1.3,
  quiet_street: 0.9,
  service: 0.9,
  // off-street like a path, but slow on small wheels: between the two in weight
  unpaved: 1.3,
  lane: 1.3,
  sharrow: 1.3,
  moderate_street: 1.1,
  busy_street: 1.25,
};

interface ClassMark {
  id: string;
  cls: ProtectionClass;
  /** Mark width, as a multiple of the line it sits on. */
  scale: number;
  /** MapLibre dash pattern, in multiples of the mark's own width. */
  dash: [number, number];
  /** Round caps turn zero-length dashes into dots. */
  round: boolean;
}

const CLASS_MARKS: ClassMark[] = [
  // Short and stubby where a lane's are long, so the two never read alike; the
  // class arrived with the pipeline's surface fix after this table was drawn.
  { id: "unpaved", cls: "unpaved", scale: 0.45, dash: [0.9, 1.8], round: false },
  { id: "lane", cls: "lane", scale: 0.3, dash: [3.2, 2.2], round: false },
  { id: "sharrow", cls: "sharrow", scale: 0.5, dash: [0, 2.4], round: true },
  { id: "moderate", cls: "moderate_street", scale: 2.1, dash: [0.28, 3.2], round: false },
  { id: "busy", cls: "busy_street", scale: 2.1, dash: [0.28, 1.15], round: false },
];
const MARK_INK = "rgba(17,22,25,0.82)";
/** Ticks stand out past their line, so over the dark basemap they are drawn
 * light — dark ones there read as gaps, which is to say as dashes. */
const TICK_INK_DARK = "rgba(236,240,244,0.85)";
const isTick = (m: ClassMark): boolean => m.scale > 1;

/** A line width that grows with zoom from `lo` to `hi` and is scaled per class. */
function classWidth(lo: number, hi: number, scale = 1): ExpressionSpecification {
  const byClass = (base: number): unknown => [
    "*",
    base * scale,
    [
      "match",
      ["get", "cls"],
      ...Object.entries(CLASS_WIDTH).flatMap(([cls, k]) => [cls, k]),
      1,
    ],
  ];
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    12,
    byClass(lo),
    16,
    byClass(hi),
  ] as ExpressionSpecification;
}

/** Every layer that draws a class mark over the network. */
const NETWORK_MARK_LAYERS = CLASS_MARKS.map((m) => `network-mark-${m.id}`);

/** A small picture of a class's line — colour, width and mark — for the legend,
 * the about table and the ride's class key, so all three match the map. */
function classSwatch(cls: ProtectionClass, w = 36, h = 14): string {
  const y = h / 2;
  const sw = 2.6 * CLASS_WIDTH[cls];
  const mark = CLASS_MARKS.find((m) => m.cls === cls);
  let over = "";
  if (mark !== undefined) {
    const mw = sw * mark.scale;
    const dash = `${(mark.dash[0] * mw).toFixed(2)} ${(mark.dash[1] * mw).toFixed(2)}`;
    // ticks take their ink from the theme (--tick-ink), as they do on the map
    const ink = isTick(mark) ? `style="stroke:var(--tick-ink)"` : `stroke="${MARK_INK}"`;
    over =
      `<line x1="2" y1="${y}" x2="${w - 2}" y2="${y}" ${ink} ` +
      `stroke-width="${mw.toFixed(2)}" stroke-dasharray="${dash}"` +
      `${mark.round ? ' stroke-linecap="round"' : ""}/>`;
  }
  return (
    `<svg class="swatch" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<line x1="2" y1="${y}" x2="${w - 2}" y2="${y}" stroke="${CLASS_COLORS[cls]}" ` +
    `stroke-width="${sw.toFixed(2)}" stroke-linecap="round"/>${over}</svg>`
  );
}

/** The construction marker: a black-and-white barricade. Nothing else on the
 * map is black and white, so it cannot be read as a safety colour (it was
 * orange, between the palette's amber and red) or as a place to visit (it was a
 * dot, like the kid stops), and ~170 of them no longer look like a route. */
function constructionIcon(): { width: number; height: number; data: Uint8Array } | null {
  const W = 34;
  const H = 22;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (ctx === null) return null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(2, 3, W - 4, H - 6);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = "#111619";
  for (let x = -H; x < W + H; x += 9) {
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x + 4.5, H);
    ctx.lineTo(x + 4.5 + H, 0);
    ctx.lineTo(x + H, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#111619";
  ctx.strokeRect(2, 3, W - 4, H - 6);
  const img = ctx.getImageData(0, 0, W, H);
  return { width: W, height: H, data: new Uint8Array(img.data.buffer) };
}

/** The marks as SVG patterns, for the ride ribbon's 12 px class strip. */
const RIBBON_PATTERNS =
  `<defs>` +
  `<pattern id="rp-unpaved" width="4" height="12" patternUnits="userSpaceOnUse">` +
  `<rect x="0" y="5" width="1.8" height="2" fill="${MARK_INK}"/></pattern>` +
  `<pattern id="rp-lane" width="9" height="12" patternUnits="userSpaceOnUse">` +
  `<rect x="0" y="5.2" width="5" height="1.6" fill="${MARK_INK}"/></pattern>` +
  `<pattern id="rp-sharrow" width="6" height="12" patternUnits="userSpaceOnUse">` +
  `<circle cx="3" cy="6" r="1.4" fill="${MARK_INK}"/></pattern>` +
  `<pattern id="rp-moderate_street" width="8" height="12" patternUnits="userSpaceOnUse">` +
  `<rect width="1.5" height="12" fill="${MARK_INK}"/></pattern>` +
  `<pattern id="rp-busy_street" width="4" height="12" patternUnits="userSpaceOnUse">` +
  `<rect width="1.5" height="12" fill="${MARK_INK}"/></pattern>` +
  `</defs>`;

/** The legend's picture of construction, to match the map. */
const CONSTRUCTION_SWATCH =
  `<svg class="swatch" width="36" height="14" viewBox="0 0 36 14" aria-hidden="true">` +
  `<defs><pattern id="constr-stripes" width="6" height="12" patternUnits="userSpaceOnUse" ` +
  `patternTransform="rotate(45)"><rect width="3" height="12" fill="#111619"/></pattern></defs>` +
  `<rect x="9" y="2" width="18" height="10" fill="#fff" stroke="#111619" stroke-width="1.5"/>` +
  `<rect x="9" y="2" width="18" height="10" fill="url(#constr-stripes)"/></svg>`;

const POI_META: Record<string, { emoji: string; label: string; color: string }> = {
  playground: { emoji: "🛝", label: "playground", color: "#e67e22" },
  ice_cream: { emoji: "🍦", label: "ice cream", color: "#e84393" },
  library: { emoji: "📚", label: "library", color: "#8e44ad" },
  water: { emoji: "🚰", label: "water fountain", color: "#2980b9" },
  restroom: { emoji: "🚻", label: "restroom", color: "#7f8c8d" },
};

const BBOX = { west: -71.60, south: 42.00, east: -70.78, north: 42.63 } as const;
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
  writeItem(SKETCHY_KEY, JSON.stringify(marks));
  // this is exactly a change to what the router must avoid, so any grade
  // computed before it is now a claim about a route the app wouldn't plan
  avoidRevision++;
  regradeVisible();
}

// ---------------------------------------------------------------------------
// map setup
// ---------------------------------------------------------------------------

const map: MLMap = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      // Our own basemap file (basemap.pmtiles, see basemap.ts), not
      // tile.openstreetmap.org or a map company's servers. OSM's tile servers
      // are donated infrastructure whose usage policy rules out a public
      // product leaning on them, and Carto, which the map used before, began
      // stamping "API KEY REQUIRED" across its tiles. Declared here so the
      // basemap's layers, added below as the map loads, have it to draw from.
      [BASEMAP_SOURCE]: basemapSource(),
    },
    // vendored SDF glyph ranges (Noto Sans, Latin + Latin-1): the label layer
    // below needs them, and hosting them ourselves keeps labels working
    // offline. The basemap's labels are pointed at this same stack (basemap.ts).
    glyphs: "fonts/glyphs/{fontstack}/{range}.pbf",
    // Ground to look at while the basemap styles are in flight. Stays at the
    // bottom of the stack; the fetched layers land on top of it.
    layers: [{ id: "ground", type: "background", paint: { "background-color": "#e9e6e1" } }],
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
// in the rider's unit: it read "500 m" under a panel that said miles
const scaleBar = new maplibregl.ScaleControl({ unit: getUnits() });
map.addControl(scaleBar, "bottom-left");

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let router: Router | null = null;
/** The basemap's layers, injected under everything this app draws. A theme's
 * layers are added the first time that theme is shown — see applyBasemap. */
const basemap = createBasemap(map, () => map.getStyle().layers.find((l) => l.id !== "ground")?.id);
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
  ["unpaved", "unpaved paths"],
];
// Read at module level, so it must not throw: with site data blocked, the old
// unguarded read here stopped the whole app on load (see storage.ts).
const storedAvoid = readJson<unknown>("avoidTypes", []);
let avoidTypes = new Set<ProtectionClass>(
  Array.isArray(storedAvoid) ? (storedAvoid as ProtectionClass[]) : [],
);

/** Every routing choice the rider has made, as the router takes them — the one
 * place a reroute, a detour or a search grade reads them from (see planOptions). */
function routePrefs(): RoutePrefs {
  return { profileId, preferFlat, avoid: avoidTypes, walkMaxM };
}

function syncAvoidSummary(): void {
  el<HTMLElement>("avoid-summary").textContent =
    avoidTypes.size === 0 ? "🛡 avoid lane types" : `🛡 avoiding ${avoidTypes.size} lane type${avoidTypes.size > 1 ? "s" : ""}`;
}
let hoverPopup: Popup | null = null;
/** Take the hover card down for a click card of the same thing. Both open on a
 * desktop tap — the pointer is over it — and two cards over one spot is noise;
 * the click card is the one with a close button, so it stays. */
function dropHoverCard(): void {
  hoverPopup?.remove();
  hoverPopup = null;
}

/** What a tap on the map means, decided in one place (onMapTap).
 *
 * Every layer used to answer its own taps with map.on("click", layer, …), and
 * the plain map click answered them all again: the listeners fired in the order
 * they happened to be registered, and each guessed what the others did. So a
 * tap on a construction site also planned a trip to it, two overlapping layers
 * both opened a card, and the fix for the first broke dismissing the ride's
 * stops menu. A layer now registers what a tap on it opens, and onMapTap picks
 * one thing to do. */
type TapOpen = (e: MapLayerMouseEvent) => void;
interface TapTarget {
  open: TapOpen;
  /** Also set a trip point, as a tap on bare map would. Only for destinations:
   * tapping a playground is a fair way to say "take us there". */
  alsoSetsPoint: boolean;
}
/** Most specific first: when a tap lands on several, only the first opens. A
 * rider's own hazard report outranks the permit beneath it, which outranks the
 * planner's layers, which outrank a place. */
const TAP_ORDER = [
  "hazardpts",
  "construction-pts",
  "construction-lines",
  "gateways",
  "crossings",
  "build",
  "pois",
] as const;
type TapLayer = (typeof TAP_ORDER)[number];
const tapTargets = new Map<TapLayer, TapTarget>();
function onTap(layer: TapLayer, open: TapOpen, alsoSetsPoint = false): void {
  tapTargets.set(layer, { open, alsoSetsPoint });
}
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
/** Who owns each output while planning waits (see planner.ts): the route
 * options (a trip, a round trip, a what-if), the reach map, and the letters on
 * the search list. Every await in their code is followed by a staleness check. */
const routeLane = new Lane();
const shedLane = new Lane();
const gradeLane = new Lane();

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
/** What the loading line is doing right now.
 *
 * Routing was showing a motionless "routing…" for the whole wait, which is
 * mostly the map downloading — about 90 tiles for an ordinary trip — so the app
 * looked frozen while it was in fact busy and fine. Say which of the two things
 * is happening, and show the one that has a denominator.
 *
 * The count is reported to whoever asked for the tiles, per call. It used to be
 * a module global that only a failed route cleared, so after any successful one
 * the reach map and search grading reported their own tile loads through the
 * route's callback, and "Loading the map around your route… 40 of 40" stayed
 * over the map with nothing loading at all.
 */
/** Say something to a screen reader without putting it on screen.
 *
 * Route results, grades and search answers all arrive by redrawing part of the
 * panel, which a screen reader does not notice: a blind parent asked for a
 * route and heard nothing at all. `delayMs` lets a burst — a list redrawn on
 * every keystroke — settle into one announcement. */
let announceTimer: number | undefined;
function announce(text: string, delayMs = 0): void {
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    const box = document.getElementById("sr-status");
    if (box === null) return;
    // the same words twice in a row are only announced if the node changes
    box.textContent = box.textContent === text ? `${text}\u00a0` : text;
  }, delayMs);
}

function showStage(text: string, sub = ""): void {
  const box = el<HTMLDivElement>("loading");
  box.innerHTML =
    `<span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span>` +
    (sub === "" ? "" : `<small>${esc(sub)}</small>`);
  box.style.display = "flex";
}

async function ensureRouter(
  points: [number, number][],
  padM: number,
  margin = 1,
  onProgress?: (done: number, total: number) => void,
): Promise<Router | null> {
  await manifestReady;
  // Corridor, not bounding box: for a cross-metro trip the endpoints' bbox
  // covers most of the map, so we'd download hundreds of tiles to route along
  // one line through them. Widen the corridor by however much padding the
  // caller asked for (a reach-map flood still wants a real area, so it passes
  // a single point and a big pad, which comes out round anyway).
  // Corridor, not bounding box: same tiles that matter, ~27% fewer fetched on
  // a cross-metro trip (measured: 164 -> 120 tiles, identical route). The
  // padding is deliberately NOT trimmed further — a narrower corridor was
  // measurably cheaper but produced a less safe route (50% -> 34% protected
  // on Wellesley->Revere), which is the wrong trade for this app.
  const marginCells = margin + Math.round(padM / 2200);
  await tiles.ensureCorridor(points, marginCells, onProgress);
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

/** Say, in words, that something the app needs did not load and when it will
 * be tried again (see retry.ts). The error line used to read "failed to load
 * routing tiles: TypeError: Failed to fetch" under a "loading map…" that never
 * went away, and nothing was ever tried again. */
function dataLoadTrouble(what: string, delayMs: number): void {
  const errBox = el<HTMLDivElement>("error");
  errBox.textContent =
    `Couldn't load ${what} — trying again in ${Math.round(delayMs / 1000)} s. ` +
    "Check the phone has a connection.";
  errBox.dataset["from"] = "dataload";
  errBox.style.display = "block";
}

/** Take the message down once what it was about has loaded — only if it is
 * still that message, and not a routing error written since. */
function dataLoadRecovered(): void {
  const errBox = el<HTMLDivElement>("error");
  if (errBox.dataset["from"] !== "dataload") return;
  delete errBox.dataset["from"];
  errBox.style.display = "none";
}

const manifestReady: Promise<void> = dataReady
  .then(() =>
    withRetry(() => tiles.loadManifest(), {
      onRetry: (_err, _attempt, delayMs) => dataLoadTrouble("the map data", delayMs),
    }),
  )
  .then(() => {
    dataLoadRecovered();
    void refreshHazards();
    el<HTMLDivElement>("loading").style.display = "none";
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
const networkReady: Promise<void> = dataReady.then(() =>
  withRetry(() => netTiles.loadManifest(), {
    onRetry: (_err, _attempt, delayMs) => dataLoadTrouble("the street safety map", delayMs),
  }).then(dataLoadRecovered),
);
let netToken = 0;

/** Fill the network source with the streets in the current viewport. */
async function refreshNetworkTiles(): Promise<void> {
  await networkReady;
  const src = map.getSource("network") as GeoJSONSource | undefined;
  if (!src) return;
  // hidden layer: don't spend bandwidth or battery fetching tiles for it
  // (setNetworkVisible refreshes when it's switched back on)
  if (map.getLayoutProperty("network", "visibility") === "none") return;
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
  let features: Awaited<ReturnType<typeof netTiles.visibleFeatures>>;
  try {
    features = await netTiles.visibleFeatures(box, 1);
  } catch {
    // a tile that would not load: keep what is drawn, the next move asks again
    return;
  }
  if (token !== netToken) return; // a newer move superseded this fetch
  src.setData({ type: "FeatureCollection", features });
}
// Debounced: the follow camera drives the map every animation frame while
// navigating, and each move fires moveend — without this the whole network
// layer would be re-queried and re-rendered ~60x/second mid-ride.
let netRefreshTimer: number | undefined;
map.on("moveend", () => {
  window.clearTimeout(netRefreshTimer);
  netRefreshTimer = window.setTimeout(() => void refreshNetworkTiles(), 300);
});

void dataReady
  .then(() => loadJson<{ mapillary?: string }>("keys.json"))
  .then((keys) => {
    mapillaryToken = readItem("mapillaryToken") ?? keys.mapillary ?? "";
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

/** pois.geojson, fetched and parsed once. The loop planner reads its features
 * and the map's POI layer draws the same collection; each used to load the
 * 786 KB file for itself. null when it could not be loaded. */
const poisData: Promise<{ features: PoiFeature[] } | null> = dataReady
  .then(() => loadJson<{ features: PoiFeature[] }>("pois.geojson"))
  .catch(() => null);

const poisReady: Promise<void> = poisData.then((fc) => {
  if (fc) pois = fc.features;
});

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
  access: "access.geojson",
  build: "priorities.geojson",
  crossings: "severance.geojson",
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
/** Put the start on the map at load, when we can do it without asking.
 *
 * The From field promises "Your location", and until this ran it was a promise
 * the app hadn't kept: nothing was located until a route was requested, so the
 * map opened somewhere generic and the field described a start that didn't
 * exist. Cold-prompting every first-time visitor for location is the other
 * failure — people deny it, and a denied permission is hard to take back — so
 * this only acts where the browser says permission is already granted. Everyone
 * else is located on demand, the first time they ask for a route.
 */
async function locateIfAlreadyAllowed(): Promise<void> {
  if (!fromCurrent || start !== null || !navigator.geolocation) return;
  try {
    // In the app, Android's own answer: the WebView's Permissions API reports
    // its per-origin state, which is not the app's permission. The app no
    // longer asks at launch, so this is what keeps "Your location" filled in
    // for someone who allowed it on an earlier ride.
    const nativeAllowed = await nativeLocationAllowed();
    if (nativeAllowed === false) return;
    const perms = navigator.permissions;
    if (nativeAllowed === null) {
      if (perms === undefined) return; // Safari <16: don't guess, wait to be asked
      const status = await perms.query({ name: "geolocation" as PermissionName });
      if (status.state !== "granted") return;
    }
    const at = await currentPosition();
    if (!fromCurrent || start !== null) return; // the rider got there first
    start = makeMarker(at, "#2b83ba", "start");
    syncOD();
    map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 14), duration: 600 });
  } catch {
    // no position, revoked between the check and the call, or simply slow:
    // the on-demand path still runs when a route is asked for
  }
}

function syncOD(): void {
  const f = el<HTMLInputElement>("from-field");
  if (f.classList.contains("picking")) return;
  f.classList.toggle("custom", !fromCurrent);
  if (fromCurrent) {
    f.value = "";
    f.placeholder = "Your location";
  } else if (f.value === "") {
    // set by tapping/dragging the map rather than typed
    f.placeholder = "Start set on the map";
  }
}

// ── what the ends are called ──────────────────────────────────────────────
// A permalink (or a tap on the map) sets a destination that has no name, and
// the field sat empty: the trip was drawn but the panel couldn't say where to,
// and the voice announced "you have arrived" at nowhere in particular. Ask
// Nominatim once per spot, remember the answer, and never make routing wait
// for it — a name is a nicety, the route is the product.

const REVGEO_KEY = "bike-revgeo-v1";
/** Which fields we filled in ourselves, and may therefore overwrite. */
const autoNamed = { start: false, end: false };

/** ~11 m of precision: enough that nudging a pin reuses the cached name. */
function revKey(lon: number, lat: number): string {
  return `${lon.toFixed(4)},${lat.toFixed(4)}`;
}

/** Names worth remembering: enough for every place a family rides to, and
 * small enough that the cache cannot crowd the ride history out of storage —
 * it was never trimmed, and grew by a name for every pin ever dropped. */
const REVGEO_MAX = 400;

function revCache(): Record<string, string> {
  return readJson<Record<string, string>>(REVGEO_KEY, {});
}

function rememberName(cache: Record<string, string>, key: string, name: string): void {
  cache[key] = name;
  // private mode or a full store: the name just won't be remembered
  writeItem(REVGEO_KEY, JSON.stringify(trimRecord(cache, REVGEO_MAX)));
}

/** The router once it exists, or null if it hasn't within `ms`. */
async function withRouter(ms: number): Promise<Router | null> {
  const deadline = Date.now() + ms;
  while (router === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
  }
  return router;
}

async function reverseGeocode(lon: number, lat: number): Promise<string | null> {
  const key = revKey(lon, lat);
  const cache = revCache();
  const hit = cache[key];
  if (hit !== undefined) return hit;
  // The map we already loaded knows the street. Ask it first: it is instant,
  // it works with no signal, and it keeps a pin drop from costing a request to
  // OpenStreetMap's geocoder, which is donated infrastructure that a public app
  // is not supposed to lean on. Outside the mapped area, fall through and ask.
  //
  // Wait for the router if it isn't built yet: pins from a permalink are named
  // before the first tiles land, which is precisely the common case, and
  // answering those from Nominatim would leave the local path unused where it
  // matters most. The wait is generous because naming is fire-and-forget — the
  // field fills a beat later either way — and a slow phone on a cold start
  // shouldn't be the reason a request goes out that didn't need to.
  // A tight radius on purpose. Within a few metres of a street the local name
  // is the right answer and costs nothing; further out the pin is probably on a
  // building or in a park, where the geocoder's answer is better than the name
  // of the nearest road — a pin on Kendall Square should say "Google", not the
  // street it happens to sit beside.
  const local = (await withRouter(10_000))?.streetNameAt(lon, lat, 20) ?? null;
  if (local !== null) {
    rememberName(cache, key, local);
    return local;
  }
  const url =
    "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18" +
    `&lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) return null;
  const j = (await resp.json()) as {
    name?: string;
    display_name?: string;
    address?: Record<string, string>;
  };
  const a = j.address ?? {};
  const street = [a["house_number"], a["road"]].filter((x) => x !== undefined).join(" ");
  const label =
    (j.name ?? "") ||
    street ||
    a["neighbourhood"] ||
    a["suburb"] ||
    a["city"] ||
    (j.display_name ?? "").split(",")[0] ||
    "";
  if (label !== "") rememberName(cache, key, label);
  return label === "" ? null : label;
}

/** Name an end in its field, unless the rider typed something there. */
function nameEnd(kind: "start" | "end"): void {
  const marker = kind === "start" ? start : end;
  if (!marker) return;
  const field = el<HTMLInputElement>(kind === "start" ? "from-field" : "search");
  if (field.value.trim() !== "" && !autoNamed[kind]) return;
  const { lng, lat } = marker.getLngLat();
  const asked = revKey(lng, lat);
  field.value = "";
  autoNamed[kind] = false;
  void reverseGeocode(lng, lat)
    .then((label) => {
      if (label === null) return;
      // the pin may have moved on (or gone) while we were asking
      const now = kind === "start" ? start : end;
      if (!now) return;
      const p = now.getLngLat();
      if (revKey(p.lng, p.lat) !== asked) return;
      if (field.value.trim() !== "") return;
      field.value = label;
      autoNamed[kind] = true;
    })
    .catch(() => undefined); // offline, or Nominatim rate-limiting us
}

function makeMarker(lngLat: LngLat | [number, number], color: string, label: string): Marker {
  const m = new maplibregl.Marker({ color, draggable: true });
  m.setLngLat(lngLat).addTo(map);
  m.getElement().title = `${label} (drag to move)`;
  m.on("dragend", () => {
    nameEnd(label === "start" ? "start" : "end");
    void requestRoute();
    // a grade is the route FROM the start: move it and the letters on screen
    // describe a journey that no longer begins where the rider does
    if (label === "start") regradeVisible();
  });
  return m;
}

function setPoint(kind: "start" | "end", lngLat: LngLat | [number, number]): void {
  if (kind === "start") {
    fromCurrent = false;
    el<HTMLInputElement>("from-field").classList.remove("picking");
    if (start) start.setLngLat(lngLat);
    else start = makeMarker(lngLat, "#2b83ba", "start");
    regradeVisible();
  } else {
    if (end) end.setLngLat(lngLat);
    else end = makeMarker(lngLat, "#d7191c", "end");
  }
  syncOD();
  nameEnd(kind);
  void requestRoute();
}

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
  // a hypothetical trip belongs to the ends and settings it was asked about
  endWhatIf();
  el<HTMLDivElement>("loading").style.display = "none";
  return ticket;
}

/** Where the rider is, as the start, once a location wait is over. Null when
 * the wait was superseded or withdrawn (Reset, a newer plan) — the start is then
 * not this plan's to set. Someone else may have put a start down while we
 * waited, the load-time locate or a tap on the map; that one stands, rather
 * than a second pin going down on top of it. */
async function locateStart(ticket: Ticket, onFail: string): Promise<Marker | null> {
  if (start !== null) return start;
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
  if (start === null) {
    start = makeMarker(here, "#2b83ba", "start");
    syncOD();
  }
  return start;
}

async function requestRoute(): Promise<void> {
  // Mid-ride, a re-plan is a way on from here. Marking a sketchy street,
  // filing a hazard or dragging a pin all end up here, and used to re-plan the
  // whole trip from the start pin — which navigation then switched to, telling
  // a rider a mile down the road to go back to the beginning.
  if (navActive) {
    replanRide();
    return;
  }
  const ticket = beginPlan();
  if (!end) return;
  await manifestReady;
  if (ticket.stale()) return;
  const errBox = el<HTMLDivElement>("error");
  errBox.style.display = "none";
  const loading = el<HTMLDivElement>("loading");
  if (!start) {
    if (!fromCurrent) return;
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
  if (ticket.stale() || !start || !end) return;
  try {
    const s = start.getLngLat();
    const d = end.getLngLat();
    const a: [number, number] = [s.lng, s.lat];
    const b: [number, number] = [d.lng, d.lat];
    // load the tiles along the corridor, then route; a safe route can detour
    // well outside the straight A–B box, so widen the loaded area once if the
    // first attempt finds nothing.
    const route = (r: Router): RouteOption[] => {
      showStage("Finding the safest way…");
      return planOptions(r, a, b, routePrefs());
    };
    // Computed into a local and only published once this plan is known to be
    // the current one: `options` is what the cards, the chips and navigation
    // all read, and an abandoned plan must not have written it.
    let found: RouteOption[] = [];
    // a narrow corridor first — it covers ordinary detours and keeps a long
    // trip from pulling a big slice of the map; the retry below widens it
    let r = await ensureRouter([a, b], 1200, 1, progress);
    if (ticket.stale()) return;
    try {
      if (!r) throw new Error("unmapped");
      found = route(r);
      if (!found.length) throw new Error("no route");
    } catch {
      r = await ensureRouter([a, b], 5000, 2, progress);
      if (ticket.stale()) return;
      if (!r) throw new Error("this area isn't mapped for routing yet");
      found = route(r);
    }
    const fallback = found[0];
    if (!fallback) throw new Error("no route found");
    options = found;
    // an A-to-B trip replaces a round trip, and its stop
    poiMarker?.remove();
    poiMarker = null;
    loopParams = null;
    const wanted = pendingSelect;
    pendingSelect = null;
    selectOption(wanted !== null && options.some((o) => o.id === wanted) ? wanted : fallback.id);
    recordRecentRoute([s.lng, s.lat], [d.lng, d.lat]);
    revealSheet();
    frameRoute(fallback);
  } catch (err) {
    if (ticket.stale()) return;
    poiMarker?.remove();
    poiMarker = null;
    loopParams = null;
    options = [];
    selectedId = null;
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
  if (navActive) return; // a new round trip is not something to swap in mid-ride
  const ticket = beginPlan();
  await manifestReady;
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
  if (!start) {
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
    kind === "none" ? null : kind === "any" ? pois : pois.filter((p) => p.properties.kind === kind);
  const loading = el<HTMLDivElement>("loading");
  showStage("Loading the map around you…");
  const progress = (done: number, total: number): void => {
    if (total > 4 && !ticket.stale()) {
      showStage("Loading the map around you…", `${done} of ${total}`);
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (ticket.stale() || !start) return;
  try {
    const s = start.getLngLat();
    // a loop can range out to roughly half its length from the start
    const r = await ensureRouter([[s.lng, s.lat]], targetM / 2, 2, progress);
    if (ticket.stale()) return;
    if (!r) throw new Error("this area isn't mapped for routing yet");
    showStage(`Finding a ${fmtDistTight(targetM)} loop…`);
    const { option, poi, more } = r.loopRoute(
      [s.lng, s.lat],
      targetM,
      candidates,
      profileId,
      preferFlat,
    );
    end?.remove();
    end = null;
    // a choice of loops, not a verdict: the runner-ups go in the same option
    // cards the point-to-point router uses, so picking between them is the
    // gesture the rider already knows
    options = [option, ...more.map((m) => m.option)];
    loopParams = { km, kind };
    selectOption("loop");
    poiMarker?.remove();
    poiMarker = null;
    if (poi !== null) {
      // no marker on a ride with no stop: the loop is the whole of it
      poiMarker = new maplibregl.Marker({ color: "#e67e22" })
        .setLngLat(poi.geometry.coordinates)
        .addTo(map);
      const meta = POI_META[poi.properties.kind];
      poiMarker.getElement().title =
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

let optionChips: Marker[] = [];
function clearOptionChips(): void {
  for (const c of optionChips) c.remove();
  optionChips = [];
}

/** Selectable grade·time chips on the map, one per alternative (Google-style,
 * but the lead label is the safety grade, not the ETA). */
let chipToFocus: RouteOption["id"] | null = null;

function renderOptionChips(): void {
  clearOptionChips();
  const refocus = chipToFocus;
  chipToFocus = null;
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
    chip.style.setProperty("--gt", GRADE_TEXT[o.grade]);
    chip.textContent = `${o.grade} · ${o.payload.summary.minutes} min`;
    chip.title = `${o.label}: ${o.gradeReason}`;
    // reachable and pressable from a keyboard, like the cards they mirror
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-pressed", String(o.id === selectedId));
    chip.setAttribute(
      "aria-label",
      `${o.label}: grade ${o.grade}, ${o.payload.summary.minutes} minutes`,
    );
    chip.addEventListener("click", (ev: Event) => {
      ev.stopPropagation();
      selectOption(o.id);
    });
    chip.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      chipToFocus = o.id; // the chips are rebuilt; keep the focus on this one
      selectOption(o.id);
    });
    if (refocus === o.id) window.setTimeout(() => chip.focus(), 0);
    optionChips.push(
      new maplibregl.Marker({ element: chip }).setLngLat(pt as [number, number]).addTo(map),
    );
  });
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
  const wasNavigating = navActive;
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
        (options.length > 1 ? ` ${options.length} route options.` : ""),
    );
  });
  if (wasNavigating && navActive) {
    // keep the spoken guidance on the line that is actually drawn
    rebuildNavFromSelected();
  }
}

/** The card to give focus back to once the cards are rebuilt. */
let optionToFocus: RouteOption["id"] | null = null;

function renderOptions(): void {
  const box = el<HTMLDivElement>("options");
  box.innerHTML = "";
  if (options.length === 0) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  // One choice among several: a radio group to assistive tech, and walked with
  // the arrow keys. They were click-only divs, so a keyboard could not pick
  // Balanced or Direct at all.
  box.setAttribute("role", "radiogroup");
  box.setAttribute("aria-label", "Route options");
  const refocus = optionToFocus;
  optionToFocus = null;
  if (options.length > 1) {
    const head = document.createElement("div");
    head.className = "options-head";
    head.textContent = `${options.length} route options`;
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
    badge.style.color = GRADE_TEXT[o.grade];
    badge.textContent = o.grade;
    card.appendChild(badge);
    // name on its own line, the numbers on a second — a single run-on string
    // of "·" separators is unreadable at a glance
    const body = document.createElement("span");
    body.className = "opt-body";
    const name = document.createElement("span");
    name.className = "opt-name";
    name.textContent = o.label;
    const stats = document.createElement("span");
    stats.className = "opt-stats";
    // the selected card is the hero: just the headline numbers, since the
    // breakdown below it already spells out protected/quiet/climb
    stats.textContent =
      o.id === selectedId
        ? `${fmtDist(s.meters)} · ${s.minutes} min · ${s.pct_protected}% protected`
        : `${fmtDist(s.meters)} · ${s.minutes} min · ${s.pct_protected}% protected` +
          ` · ↗ ${fmtClimb(s.climb_m ?? 0)}`;
    body.append(name, stats);
    card.appendChild(body);
    card.addEventListener("click", () => {
      selectOption(o.id);
    });
    const selected = o.id === selectedId;
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(selected));
    // one tab stop for the group, on the chosen one — the radio pattern
    card.tabIndex = selected ? 0 : -1;
    card.addEventListener("keydown", (ev: KeyboardEvent) => {
      const i = options.findIndex((x) => x.id === o.id);
      const step =
        ev.key === "ArrowDown" || ev.key === "ArrowRight"
          ? 1
          : ev.key === "ArrowUp" || ev.key === "ArrowLeft"
            ? -1
            : 0;
      const target =
        step !== 0
          ? options[(i + step + options.length) % options.length]
          : ev.key === "Enter" || ev.key === " "
            ? o
            : undefined;
      if (target === undefined) return;
      ev.preventDefault();
      // the cards are rebuilt when the panel repaints; keep the focus with the
      // choice rather than dropping it on the page
      optionToFocus = target.id;
      selectOption(target.id);
    });
    if (refocus === o.id) window.setTimeout(() => card.focus(), 0);
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
    // the class's map mark over its colour (see CLASS_MARKS)
    if (seg.walk !== true && CLASS_MARKS.some((m) => m.cls === seg.cls)) {
      rects.push(
        `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(wpx, 0.4).toFixed(2)}" height="12"` +
          ` fill="url(#rp-${seg.cls})" pointer-events="none"/>`,
      );
    }
    if (seg.crossing) {
      crossings.push(
        `<text x="${x.toFixed(2)}" y="23" font-size="11" fill="#a33">▲<title>busy crossing</title></text>`,
      );
    }
    linePts.push(`${x.toFixed(2)},${ey(seg.e0).toFixed(1)}`);
    x += wpx;
    linePts.push(`${x.toFixed(2)},${ey(seg.e1).toFixed(1)}`);
  }
  holder.innerHTML =
    `<svg width="${W}" height="70" xmlns="http://www.w3.org/2000/svg">` +
    RIBBON_PATTERNS +
    rects.join("") +
    crossings.join("") +
    `<polyline points="${linePts.join(" ")}" fill="none" stroke="#666" stroke-width="1.4"/>` +
    `<text x="0" y="41" font-size="11" fill="currentColor" opacity=".7">${fmtClimb(eMax)}</text>` +
    `<text x="0" y="69" font-size="11" fill="currentColor" opacity=".7">${fmtClimb(eMin)}</text>` +
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
  const key = el<HTMLDivElement>("class-key");
  key.innerHTML = "";
  const total = Object.values(s.by_class_m).reduce((a, m) => a + m, 0);
  for (const [cls, m] of Object.entries(s.by_class_m) as [ProtectionClass, number][]) {
    const seg = document.createElement("i");
    // the class's mark as a pattern, so the bar reads without its colours
    seg.className = `pat-${cls}`;
    seg.style.cssText = `flex:${m};background-color:${CLASS_COLORS[cls] ?? "#999"}`;
    seg.title = `${CLASS_LABELS[cls] ?? cls}: ${fmtDist(m)}`;
    bar.appendChild(seg);
    // and in words, which a title attribute is not on a phone or to a keyboard
    const pct = total > 0 ? Math.round((100 * m) / total) : 0;
    if (pct < 1) continue;
    const item = document.createElement("span");
    item.innerHTML = `${classSwatch(cls, 22, 12)} `;
    item.append(`${CLASS_LABELS[cls] ?? cls} ${pct}%`);
    key.appendChild(item);
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

let segPhotoTimer: number | undefined;

async function showMapillaryPreview(lon: number, lat: number): Promise<void> {
  try {
    // the same "nearest, and near enough to be here" rule the street card uses;
    // this used to keep its own narrow-box, newest-wins copy
    const newest = await nearestMapillary(
      lon,
      lat,
      mapillaryToken,
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

// ---------------------------------------------------------------------------
// GPX + cue sheet
// ---------------------------------------------------------------------------

el<HTMLButtonElement>("gpx").addEventListener("click", () => {
  const sel = options.find((o) => o.id === selectedId);
  if (!sel) return;
  const gpx = toGPX(sel.payload, `Family bike route (${sel.label})`);
  downloadBlob(new Blob([gpx], { type: "application/gpx+xml" }), "family-bike-route.gpx");
});

el<HTMLButtonElement>("print-cues").addEventListener("click", () => {
  const sel = options.find((o) => o.id === selectedId);
  if (!sel) return;
  const cues = buildCues(sel.payload);
  const s = sel.payload.summary;
  const rows = cues
    .map((c) => `<tr><td>${fmtDist(c.km * 1000)}</td><td>${esc(c.text)}</td></tr>`)
    .join("");
  const cautionRows = cautionsHtml(s.cautions, fmtDist);
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(
    `<html><head><title>Cue sheet</title><style>
      body{font-family:sans-serif;font-size:13px;max-width:520px;margin:20px auto}
      table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:3px 6px}
      td:first-child{white-space:nowrap;font-variant-numeric:tabular-nums}
    </style></head><body>
    <h2>Family bike route — ${sel.label}</h2>
    <p>${fmtDist(s.meters)} · ~${s.minutes} min · ${s.pct_protected}% protected · climb ${fmtClimb(s.climb_m ?? 0)}</p>
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
    start: start === null ? null : fromCurrent ? "here" : lngLatOf(start),
    end: loopParams === null && end !== null ? lngLatOf(end) : null,
    loop: loopParams,
    profile: profileId,
    flat: preferFlat,
    walkM: walkMaxM,
    avoid: [...avoidTypes],
    option:
      selectedId === "safest" || selectedId === "balanced" || selectedId === "direct"
        ? selectedId
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
    profileId = link.profile;
    const radio = document.querySelector<HTMLInputElement>(
      `input[name=profile][value=${link.profile}]`,
    );
    if (radio) radio.checked = true;
  }
  if (link.flat) {
    preferFlat = true;
    el<HTMLInputElement>("prefer-flat").checked = true;
  }
  if (link.walkM !== null) {
    walkMaxM = link.walkM;
    el<HTMLSelectElement>("walk-max").value = String(walkMaxM);
  }
  if (link.avoid !== null) {
    const valid = new Set(AVOIDABLE.map(([c]) => c as string));
    avoidTypes = new Set(link.avoid.filter((t) => valid.has(t)) as ProtectionClass[]);
    for (const [cls] of AVOIDABLE) {
      el<HTMLInputElement>(`avoid-${cls}`).checked = avoidTypes.has(cls);
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
      fromCurrent = false;
      // one start pin, even if the load-time locate put one down already
      if (start) start.setLngLat(s);
      else start = makeMarker(s, "#2b83ba", "start");
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
  if (now === lastHash || navActive) return;
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
  nameEnd("start");
  nameEnd("end");
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
  label.textContent = `🕘 ${route.label} · ${fmtDist(route.km * 1000)}`;
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
    clear.style.cssText = "margin-top:4px;padding:1px 8px;font-size:13px";
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

/** Everything already on the device that could answer a query.
 *
 * Assembled per keystroke rather than kept in an index: 2,500 POIs and a
 * viewport of streets is a few thousand string comparisons, which is nothing, and
 * an index would have to be invalidated every time a place is saved, a trip is
 * taken, or the map moves.
 */
function localCandidates(): Candidate[] {
  const out: Candidate[] = [];

  for (const p of listPlaces()) {
    out.push({ name: p.name, lon: p.lon, lat: p.lat, source: "place", kind: "saved place" });
  }
  // where they went, not where they started: the search box asks "where to?"
  const seenRecent = new Set<string>();
  for (const r of listRecent()) {
    const key = `${r.e[0].toFixed(4)},${r.e[1].toFixed(4)}`;
    if (seenRecent.has(key)) continue;
    seenRecent.add(key);
    // the stored label is "A to B"; the destination is what this row offers
    const label = r.label.includes(" to ") ? (r.label.split(" to ").pop() ?? r.label) : r.label;
    out.push({ name: label, lon: r.e[0], lat: r.e[1], source: "recent", kind: "you rode here" });
  }
  for (const poi of pois) {
    const name = poi.properties.name;
    if (typeof name !== "string" || name === "") continue;
    const meta = POI_META[poi.properties.kind];
    out.push({
      name,
      lon: poi.geometry.coordinates[0],
      lat: poi.geometry.coordinates[1],
      source: "poi",
      kind: meta?.label ?? poi.properties.kind,
    });
  }
  return out;
}

/** Streets from the tiles already loaded, each reduced to its nearest point.
 *
 * A street is long, so which point matters depends on where you are: "Elm
 * Street" should offer the end you could actually ride to, and its distance
 * should be to that end rather than to some midpoint in another town.
 */
function streetCandidates(query: string, origin: [number, number] | undefined): Candidate[] {
  const out: Candidate[] = [];
  for (const st of netTiles.loadedStreets()) {
    if (matchScore(query, st.name) === 0) continue; // name first: cheap, and most fail
    let best = st.coords[0];
    if (best === undefined) continue;
    if (origin !== undefined) {
      let bestD = Infinity;
      for (const c of st.coords) {
        const d = metresBetween(origin, c);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    out.push({ name: st.name, lon: best[0], lat: best[1], source: "street", kind: "street" });
  }
  return out;
}

/** How many rows the search offers.
 *
 * Every one is graded, and every grade is a routing run on the main thread — five
 * in a row is already a visible pause on a phone. A longer list would mean rows
 * without letters, which is the one thing this search must not show. */
const SEARCH_ROWS = 5;

/** Where distances are measured from: the start if set, else what you're looking at. */
function searchOrigin(): [number, number] | undefined {
  const from = start?.getLngLat();
  if (from) return [from.lng, from.lat];
  const c = map.getCenter();
  return [c.lng, c.lat];
}

/** When the geocoder was last asked. The policy itself is in search.ts, where it
 * can be tested as arithmetic rather than through browser timing. */
let lastGeocodeAt = 0;

async function searchAddress(query: string): Promise<NominatimResult[]> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1" +
    `&viewbox=${BBOX.west},${BBOX.north},${BBOX.east},${BBOX.south}` +
    `&q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`search failed (${resp.status})`);
  return (await resp.json()) as NominatimResult[];
}

/** Moves whenever the rider changes what the router must avoid — a sketchy
 * mark, a filed hazard — so a grade computed before it is never replayed after.
 * Those change where routes go just as surely as a preference does. */
let avoidRevision = 0;
/** The rows currently on screen, so their letters can be withdrawn and redone
 * when the answer they state stops being true. */
let gradedRows: { lngLat: [number, number]; badge: HTMLElement; sub: HTMLElement }[] = [];

/** The letters on screen describe routes from a particular start under
 * particular settings. When either changes they are answers to a question
 * nobody asked any more, so withdraw them and work them out again. */
function regradeVisible(): void {
  if (gradedRows.length === 0) return;
  // Never mid-ride. The "avoid this street" chip writes through saveSketchy,
  // which lands here, and grading is up to five routing runs on the main thread
  // — a stall in guidance while someone is riding, to refresh a search list
  // that isn't even on screen.
  if (navActive) return;
  window.__regradesStarted = (window.__regradesStarted ?? 0) + 1;
  for (const row of gradedRows) {
    if (!row.badge.isConnected) return; // the list is gone; nothing to redo
    row.badge.textContent = "·";
    row.badge.style.background = "";
    // the old letter goes from the tooltip and the label too, not just the pixel
    row.badge.removeAttribute("title");
    row.badge.removeAttribute("aria-label");
    showGrading(row);
    row.sub.textContent = "checking the safest way…";
  }
  void gradeSearchResults(gradedRows);
}

/** Take the placeholders away from a row that will never get a grade.
 *
 * The badge went but the subtitle kept saying "checking the safest way…", so a
 * result the router couldn't reach sat there claiming a computation was still
 * running. Nothing is a better answer than a promise that never resolves. */
function clearGrading(row: { badge: HTMLElement; sub: HTMLElement }): void {
  // Hidden, not removed. Grading resolves after the list is already on screen
  // and being tapped; removing elements re-flowed the rows under the finger
  // that was reaching for one.
  row.badge.style.visibility = "hidden";
  // What the place is and how far stays, when the row knows it: a row that
  // cannot be graded yet is still a useful row, and blanking the only line under
  // the name left it looking broken rather than ungraded.
  const where = row.sub.dataset["where"] ?? "";
  row.sub.style.visibility = where === "" ? "hidden" : "visible";
  row.sub.textContent = where;
  // the letter is withdrawn from assistive technology too, not just from view
  row.badge.removeAttribute("title");
  row.badge.removeAttribute("aria-label");
}

/** Put a row back in play. Without this, hiding was permanent: search with no
 * start, then set one, and the rows stayed blank for ever because nothing ever
 * undid the visibility. */
function showGrading(row: { badge: HTMLElement; sub: HTMLElement }): void {
  row.badge.style.visibility = "";
  row.sub.style.visibility = "";
}

/** Cancels grading when a new search lands: five routes take a moment, and the
 * answers to the last query must not appear against this one's rows. */
const gradeCache = new Map<string, { grade: SafetyGrade; meters: number; minutes: number }>();

/** Put the grade of the safest route on each result.
 *
 * The point of the app is that where you go is a safety decision, and until now
 * it only said so after you had chosen. A destination on the far side of an
 * arterial is a D before you set out, and that is worth knowing while you are
 * still looking at a list.
 *
 * Sequential on purpose. Each route needs the map along its corridor, and five
 * destinations in one neighbourhood overlap almost entirely — so the first costs
 * a corridor's worth of tiles and the rest are close to free, where five in
 * parallel would fetch five times over.
 */
async function gradeSearchResults(
  rows: { lngLat: [number, number]; badge: HTMLElement; sub: HTMLElement }[],
): Promise<void> {
  const ticket = gradeLane.begin();
  gradedRows = rows;
  // One snapshot of every routing input, taken before the first await. Reading
  // them per row let a preference change land mid-grade: the key was built from
  // the old settings and the route computed with the new ones, so the answer was
  // filed under a description of itself that was already wrong.
  const snap = {
    profileId,
    preferFlat,
    avoid: [...avoidTypes],
    walkMaxM,
    avoidRevision,
  };
  const from = start?.getLngLat();
  if (!from) {
    // no start yet: a grade needs somewhere to start from, and inventing one
    // would be a safety claim about a route nobody asked for
    for (const r of rows) clearGrading(r);
    return;
  }
  const a: [number, number] = [from.lng, from.lat];
  // Every row gets a letter, and the list is capped to make that affordable.
  //
  // This used to be a cap of five under a list of eight, which left three rows
  // showing no grade for no reason a reader could see. The letter is the whole
  // point of this app's search — a row without one is a destination with no
  // safety claim — so the list length and this cap are the same number, and
  // SEARCH_ROWS is where it is set.
  const MAX_GRADED = SEARCH_ROWS;
  for (const row of rows.slice(MAX_GRADED)) clearGrading(row);
  for (const row of rows.slice(0, MAX_GRADED)) {
    showGrading(row); // it may have been cleared by an earlier pass
    // hand the page back between routes: five Dijkstras in a row on the main
    // thread is a visible stall on a phone
    await new Promise((r) => setTimeout(r, 0));
    if (ticket.stale()) return; // a newer search owns the list now
    const key = routeCacheKey({
      from: a,
      to: row.lngLat,
      profileId: snap.profileId,
      preferFlat: snap.preferFlat,
      avoid: snap.avoid,
      walkMaxM: snap.walkMaxM,
      avoidRevision: snap.avoidRevision,
    });
    let hit = gradeCache.get(key);
    if (hit === undefined) {
      try {
        const r = await ensureRouter([a, row.lngLat], 1200, 1);
        if (ticket.stale()) return;
        // routed with the snapshot, so the answer matches the key it is filed
        // under even if the rider changes a preference while this is running
        // by id, not by index: the badge says "safest", and relying on the
        // order routeOptions happens to build its candidates in makes that a
        // safety claim held together by an array position
        const opts =
          r === null
            ? undefined
            : planOptions(r, a, row.lngLat, {
                profileId: snap.profileId,
                preferFlat: snap.preferFlat,
                avoid: new Set(snap.avoid),
                walkMaxM: snap.walkMaxM,
              });
        const best = opts?.find((o) => o.id === "safest") ?? opts?.[0];
        if (!best) throw new Error("no route");
        hit = {
          grade: best.grade,
          meters: best.payload.summary.meters,
          minutes: best.payload.summary.minutes,
        };
        gradeCache.set(key, hit);
      } catch {
        // unroutable, or off the edge of the mapped area: say nothing rather
        // than showing a letter we can't stand behind
        if (!ticket.stale()) clearGrading(row);
        continue;
      }
    }
    if (ticket.stale()) return;
    row.badge.textContent = hit.grade;
    row.badge.style.background = GRADE_COLORS[hit.grade];
    row.badge.style.color = GRADE_TEXT[hit.grade];
    row.badge.title = `Safest route here grades ${hit.grade}`;
    row.badge.setAttribute("aria-label", `safest route grades ${hit.grade}`);
    row.sub.textContent = `${fmtDist(hit.meters)} · ${hit.minutes} min by the safest way`;
  }
}

/** Nominatim's answers as candidates, so one ranking covers every source. */
function geocoderCandidates(results: NominatimResult[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of results) {
    const lon = parseFloat(r.lon);
    const lat = parseFloat(r.lat);
    // a malformed answer becomes NaN, which would reach the router and the
    // cache key as a coordinate
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const parts = r.display_name.split(",").map((p) => p.trim());
    out.push({
      name: r.name !== undefined && r.name !== "" ? r.name : (parts[0] ?? r.display_name),
      lon,
      lat,
      source: "geocoder",
      context: parts.slice(1, 3).join(", "),
      // "123 Broadway" comes back as name "123" with the street in display_name,
      // so scoring the short label alone dropped every address query — the one
      // thing this geocoder is still called for.
      match: r.display_name,
    });
  }
  return out;
}

function renderSearchResults(rows: Ranked[], target: "start" | "end" = "end"): void {
  const box = el<HTMLDivElement>("search-results");
  box.innerHTML = "";
  gradeLane.cancel(); // abandon grading for whatever list was here before
  if (rows.length === 0) {
    box.textContent = "no results in this area";
    announce("no results in this area", 700);
    return;
  }
  announce(`${rows.length} place${rows.length === 1 ? "" : "s"} found`, 700);
  const grading: { lngLat: [number, number]; badge: HTMLElement; sub: HTMLElement }[] = [];
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "search-row";
    // Identity, so an arrow-key selection survives the list being rebuilt when
    // the geocoder answers: without it the highlight was destroyed with the DOM
    // and Enter silently took the first row instead of the chosen one.
    row.dataset["key"] = `${r.name}|${r.lon.toFixed(5)},${r.lat.toFixed(5)}`;
    const short = r.name;
    const text = document.createElement("span");
    text.className = "search-text";
    const name = document.createElement("span");
    name.textContent = short;
    name.title = [r.name, r.context].filter((p) => p !== undefined && p !== "").join(" — ");
    const sub = document.createElement("small");
    sub.className = "search-sub";
    // What this place is and how far, until the grade replaces it. The old row
    // said "checking the safest way…" and nothing else, so a list of five said
    // the same thing five times while you waited.
    const where = describeRow(r, (m) => fmtDist(m));
    sub.textContent = where === "" ? "checking the safest way…" : where;
    sub.dataset["where"] = where;
    text.appendChild(name);
    text.appendChild(sub);
    row.appendChild(text);
    const lngLat: [number, number] = [r.lon, r.lat];
    // Still checked, for every source. Saved places and recent trips come from
    // localStorage, which is editable and survives across app versions, and a NaN
    // here reaches the router and the route cache key as a coordinate. I had
    // replaced this with `true` on the grounds that the geocoder path filters
    // already, which left the other four sources unguarded.
    const usable = Number.isFinite(lngLat[0]) && Number.isFinite(lngLat[1]);
    const badge = document.createElement("span");
    badge.className = "search-grade";
    badge.textContent = "·";
    row.appendChild(badge);
    // a malformed answer becomes NaN, which would reach the router and the
    // cache key as a coordinate
    if (usable) grading.push({ lngLat, badge, sub });
    else clearGrading({ badge, sub });
    // the whole row picks the field you searched from — no aiming at a tiny
    // button, which matters on a phone
    const choose = (): void => {
      setPoint(target, lngLat);
      const field = el<HTMLInputElement>(target === "start" ? "from-field" : "search");
      field.value = short;
      field.classList.remove("picking");
      gradeLane.cancel(); // the list is going away; stop routing for it
      if (target === "start") activeField = "end";
      syncOD();
      map.flyTo({ center: lngLat, zoom: 15 });
      box.innerHTML = "";
      // Close the keyboard and give the map back: the place just chosen, and the
      // route about to be drawn to it, are what the rider wants to see now.
      field.blur();
      leaveSearchMode(true);
    };
    text.style.cursor = "pointer";
    text.addEventListener("click", choose);
    const use = document.createElement("button");
    use.textContent = target === "start" ? "start" : "go";
    use.addEventListener("click", choose);
    row.appendChild(use);
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
  // Only for destinations. A grade on the start-picker list would describe the
  // route from the CURRENT start to a candidate start — a journey nobody is
  // taking, labelled as if they were.
  if (target === "end") scheduleGrading(grading);
  else for (const r of grading) clearGrading(r);
}

let gradeTimer: number | undefined;

/** Grade the list once it has stopped changing.
 *
 * The list is now rebuilt on every keystroke, and grading it is up to five routing
 * runs. Typing "playground" therefore queued fifty — each abandoned by the next
 * letter, all of them on the main thread, against a geocoder-rate-limited service
 * that also fetches routing tiles. The rows appear instantly; their letters arrive
 * a moment after the typing stops, which is when they can be read anyway.
 */
function scheduleGrading(
  rows: { lngLat: [number, number]; badge: HTMLElement; sub: HTMLElement }[],
): void {
  window.clearTimeout(gradeTimer);
  gradeTimer = window.setTimeout(() => {
    void gradeSearchResults(rows);
  }, 400);
}

// ---------------------------------------------------------------------------
// safe-shed (reachability)
// ---------------------------------------------------------------------------

/** The reach map for the current centre and budget.
 *
 * The slider fires on every step of a drag, and a bigger budget waits on more
 * tiles than a smaller one — so the flood for a budget already let go of used to
 * finish last and paint over the one asked for. And closing the reach map while
 * one waited left it to resume with no centre at all, which crashed. Each call
 * now owns the reach map only until the next one starts, or the map is closed. */
async function computeShed(): Promise<void> {
  const center = shedCenter;
  if (!center) return;
  const ticket = shedLane.begin();
  await manifestReady;
  if (ticket.stale()) return;
  const budgetKm = Number(el<HTMLInputElement>("shed-budget").value);
  el<HTMLSpanElement>("shed-budget-label").textContent = fmtDistTight(budgetKm * 1000);
  // the flood can reach out to the full budget radius from the center
  const r = await ensureRouter([center], budgetKm * 1000, 2);
  if (ticket.stale() || !shedMode || !r) return;
  const res = r.safeShed(center, budgetKm * 1000, profileId, preferFlat);
  getSource("shed").setData(res.geojson as GeoJSON.GeoJSON);
  el<HTMLDivElement>("shed-info").textContent =
    `${fmtDist(res.reachableKm * 1000)} of streets reachable ` +
    `(${res.pctReachable}% of the network) within a perceived ${fmtDistTight(budgetKm * 1000)}`;
  if (shedMarker) shedMarker.setLngLat(center);
  else {
    shedMarker = new maplibregl.Marker({ color: "#7c3aed" }).setLngLat(center).addTo(map);
    shedMarker.getElement().title = "reachability center";
  }
}

function exitShedMode(): void {
  shedLane.cancel(); // a flood still loading tiles is for a map no longer open
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
      // Escaped, like the hover popup beside it: every field here comes from a
      // city permit feed or MassDOT's work-zone API, so a project named
      // `<img onerror=…>` would have run in the reader's page. The hover popup
      // escaped these and this one did not, which is the kind of gap that
      // survives precisely because the two look alike.
      // MapLibre hands back whatever the feed had, including null, and a permit
      // whose address is three spaces should read as absent rather than as a
      // blank line. An empty string was already absent, as the `||` chain here
      // used to treat it.
      const text = (t: unknown): string =>
        typeof t === "string" && t.trim() !== "" ? esc(t.trim()) : "";
      const title = text(props.name) || text(props.kind) || "construction";
      const address = text(props.address);
      const detail = text(props.detail);
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `🚧 <b>${title}</b><br>${address}` +
            (detail === "" ? "" : `<br>${detail}`) +
            `<br><small>${source} · ${text(props.start) || "?"} → ${text(props.end) || "?"}</small>`,
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

  // hover tooltips on every dot layer (clicks keep their richer popups)
  const hoverHtml: Record<string, (props: Record<string, unknown>) => string> = {
    pois: (p) => {
      const kind = typeof p["kind"] === "string" ? p["kind"] : "";
      const meta = POI_META[kind];
      const name = typeof p["name"] === "string" && p["name"] !== "" ? p["name"] : null;
      return `${meta?.emoji ?? "📍"} <b>${esc(name ?? meta?.label ?? "stop")}</b>` +
        (name ? `<br><small>${meta?.label ?? ""}</small>` : "");
    },
    gateways: () =>
      "🚦 <b>safe crossing</b><br><small>signalized crossing of a busy street</small>",
    hazardpts: (p) => {
      const cat = typeof p["category"] === "string" ? (p["category"] as HazardCategory) : null;
      const note =
        typeof p["note"] === "string" && p["note"] !== "" ? `<br>${esc(p["note"])}` : "";
      const when =
        typeof p["t"] === "number"
          ? `<br><small>${new Date(p["t"]).toLocaleDateString()} · click to remove</small>`
          : "";
      // photo placeholder — filled asynchronously from IndexedDB below
      const photo =
        p["hasPhoto"] === true || p["hasPhoto"] === "true"
          ? `<img data-hazard-photo="${esc(String(p["id"] ?? ""))}" alt=""
               style="max-width:180px;display:block;border-radius:6px;margin-top:4px">`
          : "";
      return `⚠ <b>${cat !== null ? HAZARD_LABELS[cat] : "hazard"}</b>${note}${photo}${when}`;
    },
    "construction-pts": (p) => constructionHtml(p),
    "construction-lines": (p) => constructionHtml(p),
  };
  function constructionHtml(p: Record<string, unknown>): string {
    const name = typeof p["name"] === "string" && p["name"] !== "" ? p["name"] : "construction";
    const kind = typeof p["kind"] === "string" ? ` · ${esc(p["kind"] as string)}` : "";
    const address =
      typeof p["address"] === "string" && p["address"] !== "" ? `<br>${esc(p["address"] as string)}` : "";
    const detail =
      typeof p["detail"] === "string" && p["detail"] !== "" ? `<br>${esc(p["detail"] as string)}` : "";
    const source =
      p["src"] === "massdot_wzdx" ? "MassDOT work zone" : "Cambridge street permit";
    const dates =
      typeof p["start"] === "string" && typeof p["end"] === "string"
        ? ` · ${esc(p["start"] as string)} → ${esc(p["end"] as string)}`
        : "";
    return `🚧 <b>${esc(name)}</b>${kind}${address}${detail}<br><small>${source}${dates}</small>`;
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
  onTap("gateways", (e: MapLayerMouseEvent) => {
    dropHoverCard();
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
      const html =
        segmentHtml(props, { photo: mapillaryToken !== "" }) +
        // "right-click" means nothing on a phone
        `<br><small>${
          window.matchMedia("(hover: none)").matches
            ? "press and hold to mark as sketchy"
            : "right-click to mark as sketchy"
        }</small>`;
      if (!hoverPopup) {
        hoverPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
        hoverPopup.addTo(map);
      }
      hoverPopup.setLngLat(e.lngLat).setHTML(html);
      if (mapillaryToken !== "") {
        window.clearTimeout(segPhotoTimer);
        const popup = hoverPopup;
        const { lng, lat } = e.lngLat;
        // debounce: only fetch once the cursor rests on a segment
        segPhotoTimer = window.setTimeout(() => {
          fillPhotoSlot(popup.getElement(), lng, lat, mapillaryToken, () => popup === hoverPopup);
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
      const props = f.properties as { kind?: string; name?: string };
      const meta = props.kind !== undefined ? POI_META[props.kind] : undefined;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`${meta?.emoji ?? ""} <b>${esc(String(props.name || meta?.label || "?"))}</b>`)
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
      .setHTML(
        `🚴 ${fmtDist(Number(props.fac_m) || 0)} of bike facilities in this block` +
          `<br><small>${fmtDist(Number(props.prot_m) || 0)} protected (path/separated)</small>`,
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
      .setHTML(`elevation ~${fmtClimb(Number(props.elev) || 0)}`)
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
    if (navActive) return;
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
  if (shedMode) {
    shedCenter = [e.lngLat.lng, e.lngLat.lat];
    void computeShed();
    return;
  }
  // Mid-ride the map is for looking at, not re-planning: a stray tap on the
  // handlebars used to silently swap the route out from under the rider.
  if (navActive) {
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
  if (activeField === "start") {
    setPoint("start", e.lngLat);
    activeField = "end";
  } else {
    setPoint("end", e.lngLat);
  }
}

/** The one open spot-menu, so a second right-click (or long-press) replaces it
 * instead of stacking a second card on the map. */
let sketchyPopup: Popup | null = null;

// touch devices have no right-click: a long-press on a street opens this same
// "mark sketchy" popup (wired below the definition)
function openSketchyPopup(lngLat: [number, number]): void {
  sketchyPopup?.remove();
  sketchyPopup = null;
  // the hover card describes the same street
  dropHoverCard();
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
  // closeOnClick would kill this the instant the finger lifts (the lift itself
  // generates a click), which made it untappable on a touchscreen
  const popup = new maplibregl.Popup({ closeOnClick: false, closeButton: true })
    .setLngLat(lngLat)
    .setDOMContent(box)
    .addTo(map);
  sketchyPopup = popup;
  popup.on("close", () => {
    if (sketchyPopup === popup) sketchyPopup = null;
  });
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
/** The layout where the panel is a bottom sheet — the same query the CSS uses. */
const sheetLayout = window.matchMedia("(max-width: 760px), (max-height: 500px)");
/** The half sheet's max-height, as a share of the screen (#panel.half). */
const SHEET_HALF = 0.52;
function setSheet(state: SheetState): void {
  const panel = el<HTMLDivElement>("panel");
  panel.style.maxHeight = "";
  panel.classList.remove("peek", "half", "full");
  panel.classList.add(state);
  const handle = el<HTMLButtonElement>("sheet-handle");
  handle.setAttribute("aria-expanded", String(state !== "peek"));
  handle.setAttribute(
    "aria-label",
    `Panel size: ${state === "peek" ? "collapsed" : state === "half" ? "half open" : "fully open"}`,
  );
}
function currentSheet(): SheetState {
  const panel = el<HTMLDivElement>("panel");
  return SHEET_STATES.find((s) => panel.classList.contains(s)) ?? "half";
}
(function initSheet(): void {
  const panel = el<HTMLDivElement>("panel");
  const handle = el<HTMLButtonElement>("sheet-handle");
  // start collapsed: the map is the point, and a route expands the sheet
  // to "half" on its own (revealSheet)
  if (sheetLayout.matches) setSheet("peek");
  let dragging = false;
  let startY = 0;
  let startH = 0;
  let moved = 0;
  let liveH = 0;
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    liveH = startH;
    moved = 0;
    // kill the max-height transition for the duration: with it on, the sheet
    // lags ~200 ms behind the thumb and the drag feels broken
    panel.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    moved = Math.max(moved, Math.abs(dy));
    liveH = Math.min(window.innerHeight * 0.88, Math.max(70, startH + dy));
    panel.classList.remove("peek", "half", "full");
    panel.style.maxHeight = `${liveH}px`;
  });
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("dragging");
    // snap from where the drag actually ended, not from a mid-animation
    // measurement of the element
    const h = liveH;
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
  // From a keyboard (or a switch, or a screen reader's double-tap, which
  // arrives as a click with no pointer before it): Enter and Space step through
  // the sizes as a tap does; the arrows open and close.
  handle.addEventListener("click", (e: MouseEvent) => {
    if (e.detail !== 0) return; // a real pointer tap, already handled by end()
    const next = SHEET_STATES[(SHEET_STATES.indexOf(currentSheet()) + 1) % 3];
    setSheet(next ?? "half");
  });
  handle.addEventListener("keydown", (e: KeyboardEvent) => {
    const i = SHEET_STATES.indexOf(currentSheet());
    const to =
      e.key === "ArrowUp"
        ? SHEET_STATES[Math.min(2, i + 1)]
        : e.key === "ArrowDown"
          ? SHEET_STATES[Math.max(0, i - 1)]
          : undefined;
    if (to === undefined) return;
    e.preventDefault();
    setSheet(to);
  });
  // some WebViews revoke capture mid-gesture; without this the sheet sticks
  handle.addEventListener("lostpointercapture", end);
})();

/** The trip whose answer was last brought into view, so a re-plan of the same
 * trip (a preference changed, further down the sheet) does not yank the reader
 * away from what they were changing. */
let revealedTrip = "";
/** Set when the next panel repaint should bring the route options into view. */
let scrollToOptions = false;

/** After a route computes, make sure the sheet is at least half-open (mobile),
 * and that the answer is what it shows.
 *
 * "half" alone was not enough: measured on a 390x820 phone, the round-trip
 * block, Recent routes and the rider switch filled the half-open sheet, and "3
 * ROUTE OPTIONS" started at y=784 — the grade and ▶ Navigate needed a scroll
 * nothing hinted at. A new trip now scrolls its options to the top of the
 * sheet; ▶ Navigate is kept at the sheet's foot by CSS. */
function revealSheet(): void {
  const wasPeek = currentSheet() === "peek";
  if (wasPeek) setSheet("half");
  if (!sheetLayout.matches) return;
  const s = start?.getLngLat();
  const e = end?.getLngLat();
  const trip =
    s && e ? `${s.lng.toFixed(5)},${s.lat.toFixed(5)}>${e.lng.toFixed(5)},${e.lat.toFixed(5)}` : "";
  if (!wasPeek && trip === revealedTrip) return;
  revealedTrip = trip;
  scrollToOptions = true;
}

/** Scroll the sheet so the route options sit just under its handle. */
function showOptionsInSheet(): void {
  if (!scrollToOptions) return;
  scrollToOptions = false;
  if (!sheetLayout.matches || document.body.classList.contains("searching")) return;
  const panel = el<HTMLDivElement>("panel");
  const top = el<HTMLDivElement>("options").getBoundingClientRect().top;
  const handle = el<HTMLButtonElement>("sheet-handle").offsetHeight;
  panel.scrollTop += top - (panel.getBoundingClientRect().top + handle + 6);
}

/** iOS scrolls the whole page to bring a focused field above its keyboard, and
 * does not always scroll it back when the keyboard goes: the map and the sheet
 * were left shifted up by the keyboard's height. Nothing here is meant to
 * scroll the page itself, so any offset is leftover. */
function resetPageScroll(): void {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener("resize", () => {
  if (!document.body.classList.contains("searching")) resetPageScroll();
});

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

// ---------------------------------------------------------------------------
// Searching on a phone
//
// The sheet starts collapsed at the bottom of the screen, which is exactly
// where the keyboard opens. Measured on a 390x820 phone: tap "Where to?", type
// "Davis", and the field sat at y=760-800 under a keyboard starting around 480,
// while five results rendered at y=932 — below the screen, and clipped anyway
// by the collapsed sheet's overflow. People were typing into a field they could
// not see and getting answers they could not reach.
//
// It is worst in the Android app. Targeting SDK 35+ forces edge-to-edge, where
// the keyboard overlays the WebView instead of resizing it, so nothing on the
// page even learns the keyboard is there. Rather than depend on that — it
// differs by Android version, WebView, and browser — searching moves the field
// to the top of the screen, where no keyboard reaches, and puts the answers
// directly under it.
// ---------------------------------------------------------------------------

/** Where the sheet was before a search took it over, to put it back. */
let sheetBeforeSearch: SheetState | null = null;

function enterSearchMode(field: HTMLInputElement): void {
  if (!sheetLayout.matches) return;
  if (sheetBeforeSearch === null) sheetBeforeSearch = currentSheet();
  document.body.classList.add("searching");
  const panel = el<HTMLDivElement>("panel");
  // Open at once, not over the 0.2 s transition. Animated, the sheet was still
  // growing when the field was lifted, so the lift ran twice (now and 250 ms
  // later) and iOS, scrolling the focused field into view on its own schedule,
  // could act on either height. "dragging" is the class that already turns the
  // transition off; measuring below forces the full height to apply under it.
  panel.classList.add("dragging");
  setSheet("full");
  // Field to the top of the sheet, just under its (sticky) handle.
  const handle = el<HTMLButtonElement>("sheet-handle");
  const lift = (): void => {
    const gap = field.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    panel.scrollTop += gap - handle.offsetHeight - 6;
  };
  lift();
  window.requestAnimationFrame(() => {
    panel.classList.remove("dragging");
    // content hidden a moment ago (the loop block) may have changed the layout
    lift();
  });
}

/** Leave search mode. `chose` means a place was picked, so the sheet should
 * show the route that is about to appear rather than go back to how it was. */
function leaveSearchMode(chose: boolean): void {
  if (!document.body.classList.contains("searching")) return;
  document.body.classList.remove("searching");
  const before = sheetBeforeSearch ?? "half";
  sheetBeforeSearch = null;
  el<HTMLDivElement>("panel").scrollTop = 0;
  resetPageScroll();
  // A chosen place gets the map back, with the route options under it — "half",
  // the state a computed route asks for anyway (revealSheet). A search walked
  // away from goes back to where it started.
  setSheet(chose ? (before === "full" ? "full" : "half") : before);
}

el<HTMLButtonElement>("from-locate").addEventListener("click", () => {
  // back to riding from wherever you are
  start?.remove();
  start = null;
  fromCurrent = true;
  activeField = "end";
  const f = el<HTMLInputElement>("from-field");
  f.classList.remove("picking");
  f.value = "";
  el<HTMLDivElement>("search-results").innerHTML = "";
  syncOD();
  void requestRoute();
});

el<HTMLButtonElement>("from-pick").addEventListener("click", () => {
  // the next map tap sets the start
  activeField = "start";
  const f = el<HTMLInputElement>("from-field");
  f.classList.add("picking");
  f.value = "";
  f.placeholder = "tap the map to set the start…";
});

el<HTMLButtonElement>("backup-save").addEventListener("click", () => {
  const backup = exportBackup(new Date().toISOString());
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  downloadBlob(blob, `family-bike-router-backup-${new Date().toISOString().slice(0, 10)}.json`);
  const places = listPlaces().length;
  el<HTMLDivElement>("backup-note").textContent =
    `Backed up ${places} saved place${places === 1 ? "" : "s"} and your marks.`;
});

el<HTMLButtonElement>("backup-load").addEventListener("click", () => {
  el<HTMLInputElement>("backup-file").click();
});

el<HTMLInputElement>("backup-file").addEventListener("change", () => {
  const file = el<HTMLInputElement>("backup-file").files?.[0];
  if (!file) return;
  void file
    .text()
    .then((text) => {
      const n = importBackup(JSON.parse(text));
      renderPlacesAndRecent();
      sketchyMarks = loadSketchy();
      applyAvoidPoints();
      renderSketchy();
      el<HTMLDivElement>("backup-note").textContent =
        `Restored ${n} item${n === 1 ? "" : "s"} — ${listPlaces().length} saved places.`;
    })
    .catch((err: unknown) => {
      el<HTMLDivElement>("backup-note").textContent =
        `Couldn't restore that file: ${err instanceof Error ? err.message : String(err)}`;
    });
  el<HTMLInputElement>("backup-file").value = "";
});

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
  start?.remove();
  end?.remove();
  poiMarker?.remove();
  start = end = poiMarker = null;
  loopParams = null;
  endWhatIf();
  clearOptionChips();
  fromCurrent = true;
  activeField = "end";
  el<HTMLInputElement>("from-field").classList.remove("picking");
  el<HTMLInputElement>("from-field").value = "";
  el<HTMLDivElement>("search-results").innerHTML = "";
  syncOD();
  options = [];
  selectedId = null;
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
  if (!start || !end) return;
  const s = start.getLngLat();
  start.setLngLat(end.getLngLat());
  end.setLngLat(s);
  // the names swap with the pins, or the fields describe the trip backwards
  const from = el<HTMLInputElement>("from-field");
  const to = el<HTMLInputElement>("search");
  [from.value, to.value] = [to.value, from.value];
  [autoNamed.start, autoNamed.end] = [autoNamed.end, autoNamed.start];
  fromCurrent = false;
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
  preferFlat = (e.target as HTMLInputElement).checked;
  void requestRoute();
  void computeShed();
  regradeVisible();
});

el<HTMLSelectElement>("walk-max").addEventListener("change", (e: Event) => {
  walkMaxM = Number((e.target as HTMLSelectElement).value);
  writeItem("walkMaxM", String(walkMaxM));
  void requestRoute();
  regradeVisible();
});
// restore the persisted walking budget
walkMaxM = Number(readItem("walkMaxM") ?? "0") || 0;
el<HTMLSelectElement>("walk-max").value = String(walkMaxM);

for (const [cls] of AVOIDABLE) {
  const box = el<HTMLInputElement>(`avoid-${cls}`);
  box.checked = avoidTypes.has(cls);
  box.addEventListener("change", () => {
    if (box.checked) avoidTypes.add(cls);
    else avoidTypes.delete(cls);
    writeItem("avoidTypes", JSON.stringify([...avoidTypes]));
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
      profileId = v;
      void requestRoute();
      void computeShed();
      // the letters were the safest route for a different rider; a cache key
      // can stop a stale one being replayed but cannot take down one already
      // on screen
      regradeVisible();
    }
  });
}

/** Wire an address search to a field, so the origin is searchable too and not
 * only settable by tapping the map or using the current location. */
/** Which field the visible result list belongs to.
 *
 * Both fields render into #search-results, and each attachSearch closure captures
 * its own target. A late geocoder answer for the start field could therefore
 * re-render the list while the reader was typing a destination — and every row in
 * it would then set the START when tapped. Wrong point, silently. */
let searchOwner: HTMLInputElement | null = null;

function attachSearch(input: HTMLInputElement, target: "start" | "end"): void {
  let timer: number | undefined;
  // The geocoder's last answer for the query still in the box, so a keystroke
  // can re-rank without asking again — and so local and remote results appear in
  // one list rather than the local ones being replaced when the network answers.
  let remote: { query: string; rows: Candidate[] } = { query: "", rows: [] };
  /** The row the arrow keys are on, by identity rather than by position. */
  let activeKey: string | null = null;

  const rowsNow = (): HTMLElement[] => [
    ...el<HTMLDivElement>("search-results").querySelectorAll<HTMLElement>(".search-row"),
  ];

  const highlight = (key: string | null): void => {
    activeKey = key;
    for (const row of rowsNow()) {
      row.classList.toggle("active", key !== null && row.dataset["key"] === key);
    }
  };

  const show = (q: string): void => {
    if (searchOwner !== input) return; // the other field owns the list now
    const origin = searchOrigin();
    const candidates = [
      ...localCandidates(),
      ...streetCandidates(q, origin),
      ...(remote.query === q ? remote.rows : []),
    ];
    renderSearchResults(rankSearch(q, candidates, { origin, limit: SEARCH_ROWS }), target);
    // put the selection back where it was, or drop it if that place is gone —
    // never leave it pointing at whatever row inherited the position
    highlight(rowsNow().some((r) => r.dataset["key"] === activeKey) ? activeKey : null);
  };

  input.addEventListener("focus", () => enterSearchMode(input));
  input.addEventListener("blur", () => {
    // Walked away without choosing. Only let the sheet go if nothing is left to
    // tap: blur arrives on touchstart and the click only on touchend, so shrinking
    // the sheet while a list is up would slide the row out from under the finger
    // that was reaching for it. Deferred a tick so focus hopping to the other
    // search field counts as still searching.
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active === el("search") || active === el("from-field")) return;
      if (el<HTMLDivElement>("search-results").childElementCount === 0) leaveSearchMode(false);
    }, 0);
  });

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    searchOwner = input;
    const q = input.value.trim();
    if (q === "") {
      el<HTMLDivElement>("search-results").innerHTML = "";
      return;
    }
    // Local first, on every keystroke, from the first letter. This is the part
    // that makes the box feel like it is answering rather than thinking: 2,500
    // named places and the streets on screen are already here, and waiting 400 ms
    // to ask a geocoder for what we have on the device is waiting for nothing.
    highlight(null); // a new query is a new list
    show(q);

    // Then the geocoder, for house numbers and businesses we do not have — as a
    // fallback, and on its terms. See worthGeocoding and GEOCODE_MIN_GAP_MS.
    const localHits = el<HTMLDivElement>("search-results").querySelectorAll(".search-row").length;
    if (!worthGeocoding(q, localHits)) return;
    timer = window.setTimeout(() => {
      const wait = geocodeDelayMs(Date.now(), lastGeocodeAt);
      if (wait > 0) {
        // too soon: ask again once the floor has passed, rather than dropping the
        // query or hammering the service
        timer = window.setTimeout(() => {
          if (input.value.trim() === q) input.dispatchEvent(new Event("input"));
        }, wait);
        return;
      }
      lastGeocodeAt = Date.now();
      searchAddress(q)
        .then((results) => {
          if (input.value.trim() !== q) return; // a later keystroke moved on
          if (searchOwner !== input) return; // and the other field owns the list
          remote = { query: q, rows: geocoderCandidates(results) };
          // Not while a row is chosen. Re-ranking under a committed selection is
          // how someone ends up riding to a place they did not pick; the answers
          // are kept and merge into the next keystroke's list instead.
          //
          // Deliberately redundant with the highlight restore in show(): either
          // alone keeps the selection, and a test can only kill both together.
          // This one avoids the churn; that one covers re-renders from any other
          // cause, which is where the bug came from in the first place.
          if (activeKey !== null) return;
          show(q);
        })
        .catch(() => {
          // The local list is still on screen and still useful, so this is a
          // footnote rather than an error state — the old code replaced
          // everything with "search unavailable". And only for the query and the
          // field it was asked for: a slow failure used to be able to write over a
          // list the reader had since moved on from.
          if (input.value.trim() !== q || searchOwner !== input) return;
          const box = el<HTMLDivElement>("search-results");
          if (box.querySelector(".search-row") === null) {
            box.textContent = "search unavailable";
          }
        });
    }, GEOCODE_DEBOUNCE_MS);
  });

  // Arrow keys and Enter, because a list you can only reach with a mouse is a
  // list you cannot use one-handed.
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    const rows = rowsNow();
    if (rows.length === 0) return;
    const current = rows.findIndex((r) => r.classList.contains("active"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        e.key === "ArrowDown" ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0);
      const chosen = rows[next === -1 ? 0 : next];
      highlight(chosen?.dataset["key"] ?? null);
      chosen?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter with nothing highlighted takes the first row, which is what the
      // ranking is for: the best answer should need no aiming at all.
      const chosen = rows[current === -1 ? 0 : current];
      chosen?.querySelector<HTMLElement>(".search-text")?.click();
    } else if (e.key === "Escape" && activeKey !== null) {
      // Step back out of the list without wiping the query — and show whatever the
      // geocoder answered while a row was selected, which was deliberately held
      // back then and would otherwise never have appeared at all.
      e.preventDefault();
      e.stopPropagation();
      highlight(null);
      show(input.value.trim());
    }
  });
}
attachSearch(el<HTMLInputElement>("search"), "end");
attachSearch(el<HTMLInputElement>("from-field"), "start");
// once you type over a name we filled in, it's yours and we leave it alone
for (const [kind, id] of [
  ["start", "from-field"],
  ["end", "search"],
] as const) {
  el<HTMLInputElement>(id).addEventListener("input", () => {
    autoNamed[kind] = false;
  });
}

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
    // never wipe the trip out from under an active ride: reset() cleared the
    // route, markers and permalink while navigation kept talking, leaving the
    // rider following a voice over a blank map with no way to recover it
    else if (!navActive) el<HTMLButtonElement>("reset").click();
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
        `<tr><td>${classSwatch(cls, 28, 12)} ${CLASS_LABELS[cls]}</td>` +
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
    `${hereLabel(lon, lat)} — saved reports appear on the map and routes avoid them`;
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
  if (!navActive) {
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
  const near = hazards.find((hz) => distM([hz.lon, hz.lat], at) < 20);
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

/** Share a stats card from a tap (see share.ts): the share sheet when the card
 * is ready and the browser has one, otherwise the picture saved and the text
 * copied — with the button saying so, instead of nothing happening. */
function shareCard(text: string, image: PreparedImage, filename: string, btn: HTMLElement): void {
  void shareImage(text, image, filename, {
    canShare: typeof navigator.canShare === "function" ? (d) => navigator.canShare(d) : undefined,
    share: typeof navigator.share === "function" ? (d) => navigator.share(d) : undefined,
    copy: (t) => navigator.clipboard.writeText(t),
    download: (b, f) => downloadBlob(b, f),
    tell: (message) => {
      const prev = btn.textContent;
      btn.textContent = `✓ ${message}`;
      window.setTimeout(() => {
        btn.textContent = prev;
      }, 2500);
    },
  });
}

/** Cards drawn ahead of the tap, so share() can run inside it. */
let totalsCard: PreparedImage | null = null;
const rideCards = new Map<string, PreparedImage>();

function rideCard(ride: RideSummary): PreparedImage {
  let card = rideCards.get(ride.id);
  if (card === undefined) {
    card = new PreparedImage(drawRideCard(ride));
    rideCards.set(ride.id, card);
  }
  return card;
}

function renderRides(): void {
  const rides = loadRides();
  const totals = rideTotals(rides, new Date());
  el<HTMLDivElement>("ride-totals").innerHTML =
    rides.length === 0
      ? "No rides yet — rides are saved automatically when you Navigate, or use ● Record."
      : `<b>${totals.count}</b> rides · <b>${fmtDist(totals.km * 1000)}</b> total · ` +
        `<b>${totals.movingHours} h</b> moving · longest <b>${fmtDist(totals.longestKm * 1000)}</b> · ` +
        `this month <b>${fmtDist(totals.thisMonthKm * 1000)}</b> · avg <b>${totals.avgProtectedPct}%</b> protected`;
  el<HTMLButtonElement>("rides-share").style.display = rides.length === 0 ? "none" : "inline-block";
  const table = el<HTMLTableElement>("ride-list");
  table.innerHTML =
    rides.length === 0
      ? ""
      : `<tr><th>date</th><th>${unitShort()}</th><th>moving</th>` +
        `<th>avg</th><th>protected</th><th></th></tr>`;
  for (const ride of rides) {
    const tr = table.insertRow();
    const d = new Date(ride.startedAt);
    tr.insertCell().textContent = d.toLocaleDateString([], { month: "short", day: "numeric" });
    tr.insertCell().textContent = fromMeters(ride.meters).toFixed(1);
    tr.insertCell().textContent = `${Math.round(ride.movingS / 60)} min`;
    tr.insertCell().textContent =
      ride.movingS > 0 ? fmtSpeed(ride.meters / ride.movingS) : "–";
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
    // drawn as soon as a finger lands on it; usually ready by the click
    shareBtn.addEventListener("pointerdown", () => {
      rideCard(ride);
    });
    shareBtn.addEventListener("click", () => {
      shareCard(rideShareText(ride), rideCard(ride), "bike-ride.png", shareBtn);
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
  // the totals card is drawn while the list is read, not after the tap
  const rides = loadRides();
  rideCards.clear();
  totalsCard = rides.length > 0 ? new PreparedImage(drawTotalsCard(rideTotals(rides, new Date()))) : null;
  el<HTMLDialogElement>("rides").showModal();
});
el<HTMLButtonElement>("rides-close").addEventListener("click", () => {
  el<HTMLDialogElement>("rides").close();
});
el<HTMLButtonElement>("rides-share").addEventListener("click", () => {
  const totals = rideTotals(loadRides(), new Date());
  totalsCard ??= new PreparedImage(drawTotalsCard(totals));
  shareCard(totalsShareText(totals), totalsCard, "bike-stats.png", el("rides-share"));
});

el<HTMLButtonElement>("rides-clear").addEventListener("click", () => {
  clearRides();
  getSource("history").setData(emptyFC());
  renderRides();
});
el<HTMLDialogElement>("rides").addEventListener("click", (e: MouseEvent) => {
  if (e.target === el<HTMLDialogElement>("rides")) el<HTMLDialogElement>("rides").close();
});
// tap-outside is the reflex on a phone; #hazard was the one dialog ignoring it
el<HTMLDialogElement>("hazard").addEventListener("click", (e: MouseEvent) => {
  if (e.target === el<HTMLDialogElement>("hazard")) el<HTMLDialogElement>("hazard").close();
});

el<HTMLButtonElement>("mapillary-save").addEventListener("click", () => {
  const token = el<HTMLInputElement>("mapillary-token").value.trim();
  mapillaryToken = token;
  if (token === "") removeItem("mapillaryToken");
  else writeItem("mapillaryToken", token);
  clearPhotoCache(); // the shared lookup holds misses fetched with the old token
  el<HTMLSpanElement>("mapillary-status").textContent =
    token === "" ? "cleared" : "✓ saved — hover any street";
});

function openAbout(): void {
  el<HTMLInputElement>("mapillary-token").value = mapillaryToken;
  fillAbout();
  el<HTMLDialogElement>("about").showModal();
}

/** What build this page actually is.
 *
 * Substituted at assembly (scripts/assemble.sh) and at deploy (pages.yml). Baked
 * into the code rather than fetched, because the question it answers is "is the
 * page in front of me the current one?" — and a fetched answer describes the
 * server while the page could be a cached older build, which is precisely the
 * case where a wrong answer costs the most.
 */
// Three plain tokens, not one JSON blob. The first version substituted JSON into
// a double-quoted literal, and sed reads `\"` in a replacement as an escape for
// `"` — so the backslashes vanished and app.js became a syntax error that broke
// the entire app. Values with no quotes in them cannot be mangled that way.
// Filled in by the build (vite.config.ts), not by sed on the output: a
// substitution in the shell once turned app.js into a syntax error.
const BUILD_VERSION = __BUILD_VERSION__;
const BUILD_TIME = __BUILD_TIME__;
const BUILD_COMMIT = __BUILD_COMMIT__;

interface BuildInfo {
  version?: string;
  built?: string;
  commit?: string;
}

/** This build, or null when the placeholders were never substituted — which
 * means the source is being served directly rather than from an assembled
 * bundle or a deploy. */
function thisBuild(): BuildInfo | null {
  if (BUILD_COMMIT.startsWith("__BUILD")) return null;
  return { version: BUILD_VERSION, built: BUILD_TIME, commit: BUILD_COMMIT };
}

function whenBuilt(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "an unrecorded time";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** Say which build this is, and whether the site has a newer one.
 *
 * The second half matters more than the first: a hard refresh that appears to
 * change nothing is indistinguishable from a deploy that never happened, and
 * without this there is no way to tell them apart from inside the app.
 */
async function showBuildStamp(): Promise<void> {
  const line = el<HTMLParagraphElement>("build-stamp");
  const mine = thisBuild();
  if (!mine) {
    line.textContent = "Development build — served straight from source.";
    return;
  }
  const named = mine.version !== undefined && mine.version !== "" && mine.version !== "web";
  const commit = mine.commit === undefined ? "" : ` · ${mine.commit}`;
  line.textContent = named
    ? `You're running ${mine.version}, built ${whenBuilt(mine.built)}${commit}.`
    : `You're running the build from ${whenBuilt(mine.built)}${commit}.`;

  // What the site is serving now, uncached — so a stale page can say so.
  try {
    const resp = await fetch("build.json", { cache: "no-store" });
    if (!resp.ok) return;
    const live = (await resp.json()) as BuildInfo;
    if (live.commit === undefined || live.commit === mine.commit) return;
    const note = document.createElement("span");
    note.className = "stale-build";
    note.textContent =
      ` The site has a newer build (${whenBuilt(live.built)} · ${live.commit}) — ` +
      "this page is a cached copy. Reload to pick it up.";
    line.appendChild(note);
  } catch {
    // offline, or the file isn't there: what this build is remains true
  }
}

// two ways in: the labelled button in the footer, which says what's inside, and
// the ℹ in the header, which is reachable without scrolling the panel
for (const id of ["about-btn", "about-top"]) {
  el<HTMLButtonElement>(id).addEventListener("click", () => {
    openAbout();
    // re-checked on every open: a page left sitting for a day is exactly the one
    // whose reader wants to know whether it is still the current build
    void showBuildStamp();
  });
}
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

const NAV_PITCH = 50;
/** After the rider stops touching the map, the camera takes itself back —
 * otherwise one bump on the handlebars leaves the ride permanently off-centre
 * and you have to keep hunting for the recenter button. */
const REFOLLOW_MS = 10_000;

let navActive = false;
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
/** A new build waits for the ride to end before the page reloads into it. */
const swReload = new DeferredReload(
  () => navActive,
  () => location.reload(),
);
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
  const ride = recorder?.finish(profileId);
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
  if (!navActive) return;
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
  paceKmh: () => PROFILES[profileId].paceKmh,
  solo: () => profileId === "solo",
});

/** Route options from where the rider is to where the ride is going: back onto
 * what is left of a loop, or to the destination. Null when there is nowhere
 * to go (no destination yet). */
function rideOptionsFrom(
  r: Router,
  from: [number, number],
  bias?: Map<number, number>,
): RouteOption[] | null {
  if (navLoop !== null && navOriginalDest === null) {
    const target = loopRejoinPoint(navLoop.payload, rideEngine.loopDoneM);
    if (target !== null) {
      const lead = planOptions(r, from, target.at, routePrefs(), bias)[0];
      if (!lead) return [];
      const back = rejoinOption(lead, navLoop, target.index);
      loopLegs.set(back, { legM: payloadLength(lead.payload), resumeM: target.atM });
      return [back];
    }
    // what is left of the loop is shorter than the way onto it: finish
  }
  return navDest === null ? null : planOptions(r, from, navDest, routePrefs(), bias);
}

/** Re-plan the ride from where the rider is, keeping where it is going: after
 * something changed what the router must avoid. */
function replanRide(): void {
  if (!router || !navLastPos) return;
  try {
    const found = rideOptionsFrom(router, navLastPos);
    const first = found?.[0];
    if (!found || !first) return;
    options = found;
    selectOption(first.id);
    rebuildNavFromSelected();
  } catch {
    showRideAlert("⚠ couldn't re-plan from here — keep to the route", "gps");
    window.setTimeout(hideRideAlert, 4000);
  }
}

function rebuildNavFromSelected(): boolean {
  const sel = options.find((o) => o.id === selectedId);
  if (!sel) return false;
  // a detour to a stop is off the loop; the loop itself is on it from the start
  const leg = loopLegs.get(sel) ?? (navLoop !== null && sel === navLoop ? { legM: 0, resumeM: 0 } : null);
  rideEngine.setRoute(sel.payload, leg);
  return true;
}

/** Distance / ETA line. `straight` marks an off-route estimate (as the crow
 * flies) so the number is honest rather than frozen at its last on-route value. */
function showTrip(t: Extract<RideEffect, { type: "trip" }>): void {
  const eta = new Date(Date.now() + t.minutes * 60_000);
  const clock = eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // "arrive" spelled out pushed this past the banner width, so it wrapped with
  // "PM" alone on a second line and the banner's height twitched all ride
  el<HTMLElement>("nav-remaining").textContent =
    `${t.straight ? "~" : ""}${fmtDist(t.remainingM)} · ${t.minutes} min · eta ${clock}`;
  el<HTMLElement>("nav-speed").textContent = t.speedMps > 0.8 ? fmtSpeedRound(t.speedMps) : "";
}

function showBanner(m: Maneuver | undefined, distToNextM: number): void {
  el<HTMLElement>("nav-icon").textContent = m?.icon ?? "⬆";
  el<HTMLElement>("nav-dist").textContent = navDistText(distToNextM);
  el<HTMLElement>("nav-street").textContent = m?.text ?? "";
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
      if (!navActive) return;
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
        if (!navActive) return;
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
      if (!navActive) {
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
  if (document.visibilityState === "visible" && navActive && isNativeApp()) {
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
  if (navActive) return;
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
function hereLabel(lon: number, lat: number): string {
  const street = el<HTMLElement>("nav-street").textContent?.trim();
  if (navActive && street && !/^[-–]$/.test(street) && !/^⚠/.test(street)) {
    return `on ${street}`;
  }
  const cls = router?.edgeClassAt(lon, lat);
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
  if (!navActive) return;
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
  if (!navActive || !router) return;
  const step = rideEngine.onFix(fix, Date.now());
  if (step === null) return;
  navLastPos = [fix.lon, fix.lat];
  // keep the ride recoverable: Back, a reload or a crash used to lose it all
  if (recorder && ++navFixesSinceStash >= STASH_EVERY_FIXES) {
    navFixesSinceStash = 0;
    stashInProgress(recorder.finish(profileId));
  }
  recorder?.addPoint(Date.now(), fix.lon, fix.lat, router.edgeClassAt(fix.lon, fix.lat), step.alongM);
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
      el<HTMLElement>("nav-icon").textContent = "↩";
      el<HTMLElement>("nav-dist").textContent = "off route";
      el<HTMLElement>("nav-street").textContent = "adjusting…";
      return;
    case "banner":
      showBanner(e.maneuver, e.distToNextM);
      return;
    case "trip":
      showTrip(e);
      return;
    case "reroute":
      rerouteFrom(e.from, e.heading);
      return;
    case "arrived":
      showArrival(e.atStop, e.totalM);
      return;
  }
}

/** A wrong turn: plan the way on from here, and say which way it goes. */
function rerouteFrom(from: [number, number], heading: number | null): void {
  if (!router) return;
  try {
    const bias = heading !== null ? router.headingBias(from, heading) : undefined;
    const found = rideOptionsFrom(router, from, bias);
    if (found !== null) options = found;
    const first = found?.[0];
    if (first) {
      selectOption(first.id);
      rebuildNavFromSelected();
      // tell the rider a new way exists and which way it goes, instead of
      // leaving "adjusting…" up while a fresh route sits undrawn-to
      const back = rideEngine.rejoinBearing();
      showRideAlert(
        back === null ? "⚠ off route — new route ready" : `⚠ off route — head ${compassPoint(back)} to rejoin`,
        "gps",
      );
    }
  } catch {
    showRideAlert("⚠ off route — no way back from here", "gps");
  }
}

function showArrival(atStop: boolean, totalM: number): void {
  if (atStop) {
    el<HTMLElement>("nav-icon").textContent = "🛑";
    el<HTMLElement>("nav-dist").textContent = "At the stop";
    el<HTMLElement>("nav-street").textContent = "tap ▶ resume to ride on";
    el<HTMLButtonElement>("nav-resume").style.display = "inline-block";
    return;
  }
  el<HTMLElement>("nav-icon").textContent = "🏁";
  el<HTMLElement>("nav-dist").textContent = "Arrived";
  el<HTMLElement>("nav-street").textContent = navDestLabel ?? "you're there";
  el<HTMLElement>("nav-remaining").textContent = `${fmtDist(totalM)} ridden`;
  el<HTMLElement>("nav-speed").textContent = "";
  hideRideAlert();
  finishAndSaveRide();
}

async function startNav(): Promise<void> {
  // a ride follows the streets as they are, never a what-if's proposed lane
  clearWhatIf();
  const chosen = options.find((o) => o.id === selectedId);
  navLoop = chosen !== undefined && chosen.id.startsWith("loop") ? chosen : null;
  rideEngine.start();
  if (!rebuildNavFromSelected()) return;
  const destLngLat = end?.getLngLat() ?? start?.getLngLat();
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
  navActive = true;
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
  // Location last, permission first: on Android 14+ the background watcher's
  // foreground service cannot start without it (see navStartLocation).
  await navStartLocation(true);
  // absorb one Back press: on Android the hardware button is a thumb-brush from
  // ending the ride, and there was no guard of any kind
  history.pushState({ navigating: true }, "");
}

function exitNav(): void {
  navActive = false;
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
    options = planOptions(router, navLastPos, poi.geometry.coordinates, routePrefs());
    const first = options[0];
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
  // back to the ride: the destination, or what is left of the loop
  const detourDest = navDest;
  navDest = navOriginalDest;
  navOriginalDest = null;
  try {
    const found = rideOptionsFrom(router, navLastPos);
    const first = found?.[0];
    if (!found || !first) throw new Error("no way back");
    options = found;
    selectOption(first.id);
    rebuildNavFromSelected();
    el<HTMLButtonElement>("nav-resume").style.display = "none";
    hideRideAlert();
    speak("back on the way. let's go!");
  } catch {
    // still on the detour
    navOriginalDest = navDest;
    navDest = detourDest;
    speak("could not plan the way back from here");
  }
});

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
  const already = sketchyMarks.some((m) => distM(m, navLastPos as [number, number]) < 15);
  if (!already) {
    sketchyMarks.push(navLastPos);
    saveSketchy(sketchyMarks);
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
    syncUnitLabels();
    scaleBar.setUnit(getUnits());
    // the number in the box meant a distance, not a digit: keep the distance
    if (wasM > 0) {
      el<HTMLInputElement>("loop-dist").value = String(Math.round(fromMeters(wasM) * 10) / 10);
    }
    renderOptions();
    renderOptionChips();
    const sel = options.find((o) => o.id === selectedId);
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
  if (!navActive) {
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
  if (navActive) {
    askDuringRide("End the ride?", exitNav);
    return;
  }
  if (document.body.classList.contains("searching")) {
    (document.activeElement as HTMLElement | null)?.blur();
    leaveSearchMode(false);
    return;
  }
  if (shedMode) {
    exitShedMode();
    return;
  }
  minimizeApp();
});

map.on("dragstart", () => {
  if (navActive) {
    navFollowing = false;
    setRecentreNeeded(true);
    scheduleRefollow();
  }
});
// A pinch/scroll zoom while navigating is the rider deliberately looking
// further ahead — keep their zoom (the old code re-applied its own every fix,
// so zooming out snapped back within a second) until they tap recenter.
map.on("zoomstart", (e: { originalEvent?: unknown }) => {
  if (navActive && e.originalEvent) {
    navUserZoom = true;
    setRecentreNeeded(true);
  }
});
// The follow camera writes the map every animation frame, which would fight
// (and cancel) the rider's own pinch/scroll before MapLibre could even start
// the gesture. Back off the moment they touch the map, resume shortly after.
let navInteractTimer: number | undefined;
function pauseFollowForInput(): void {
  if (!navActive) return;
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
  if (!navActive) return;
  navUserZoom = true;
  setRecentreNeeded(true);
  scheduleRefollow();
}

/** Hand the camera back to the route once the rider has stopped fiddling. */
function scheduleRefollow(): void {
  window.clearTimeout(navRefollowTimer);
  navRefollowTimer = window.setTimeout(() => {
    if (!navActive) return;
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

// ---------------------------------------------------------------------------
// offline: pre-cache basemap tiles along the selected route (zooms 13-16,
// ~1-tile corridor), and both basemap styles, into the page's own tile cache —
// see tilecache.ts, which is also what reads them back, with or without a
// service worker
// ---------------------------------------------------------------------------

function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latR = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n);
  return [x, y];
}

function routeTiles(track: Track): TileXYZ[] {
  // One tile set serves every basemap mode, so there is no light/dark choice to
  // make here, and nothing to get wrong when a rider flips theme halfway
  // through an offline ride.
  //
  // The basemap stops at z14 (BASEMAP_MAXZOOM) and MapLibre overzooms it for
  // closer views, so z13-14 covers the z13-16 a ride actually displays.
  const tiles = new Map<string, TileXYZ>();
  for (const z of [13, BASEMAP_MAXZOOM]) {
    // sample the track densely enough that no tile is skipped at this zoom
    const stepM = z >= BASEMAP_MAXZOOM ? 250 : 400;
    let nextAt = 0;
    track.coords.forEach((c, i) => {
      if ((track.cumM[i] ?? 0) < nextAt && i !== track.coords.length - 1) return;
      nextAt = (track.cumM[i] ?? 0) + stepM;
      const [x, y] = tileXY(c[0], c[1], z);
      const spread = z >= BASEMAP_MAXZOOM ? 1 : 0; // 3x3 corridor at the deepest zoom
      for (let dx = -spread; dx <= spread; dx++) {
        for (let dy = -spread; dy <= spread; dy++) {
          tiles.set(`${z}/${x + dx}/${y + dy}`, [z, x + dx, y + dy]);
        }
      }
    });
  }
  return [...tiles.values()];
}

el<HTMLButtonElement>("offline-btn").addEventListener("click", () => {
  const sel = options.find((o) => o.id === selectedId);
  if (!sel) return;
  const btn = el<HTMLButtonElement>("offline-btn");
  const tiles = routeTiles(buildTrack(sel.payload));
  btn.disabled = true;
  // Tiles only: the style is built in the page (basemap.ts), so a cold start
  // offline has what it needs to paint them, in either theme.
  void downloadOffline(
    tiles,
    (done, total) => {
      btn.textContent = `⬇ ${done}/${total}…`;
    },
    tileDeps(),
  )
    .then(({ failed }) => {
      // Say so when part of the route did not arrive, rather than "ready" over
      // a map that will have holes in it.
      btn.textContent = failed === 0 ? "✓ offline ready" : `⚠ ${failed} of ${tiles.length} tiles missing`;
    })
    .catch(() => {
      btn.textContent = "offline download failed";
    })
    .finally(() => {
      btn.disabled = false;
      window.setTimeout(() => {
        btn.textContent = "⬇ Offline map";
      }, 4000);
    });
});

// ---------------------------------------------------------------------------
// dark mode (night rides): dark basemap + dark UI, persisted; light until
// the rider turns it on, whatever the system theme (see applyDark below)
// ---------------------------------------------------------------------------

function applyBasemap(): void {
  const dark = document.body.classList.contains("dark");
  const aerial = el<HTMLInputElement>("show-aerial").checked;
  const netOn = el<HTMLInputElement>("show-net").checked;
  // while riding, the map is turned to the heading: drop the basemap's baked
  // labels and draw our own, which stay the right way up
  const plain = navActive;
  const setVis = (): void => {
    // Skip layers that aren't added yet: this runs during map load too, from
    // whichever data callback lands first, and setLayoutProperty throws on an
    // unknown id — which took the calling chain (and the route panel) with it.
    const vis = (id: string, on: boolean): void => {
      if (map.getLayer(id) !== undefined) {
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      }
    };
    vis("aerial", aerial);
    // One theme at a time, its label layers dropped while riding, and the whole
    // basemap off under the aerial view. show() is instant for a theme already
    // installed; ensure() covers the first use of one, then shows it.
    const wanted = {
      theme: (dark ? "dark" : "light") as BasemapTheme,
      labels: !plain,
      on: !aerial,
    };
    basemap.show(wanted);
    void basemap
      .ensure(wanted.theme)
      .then(() => basemap.show(wanted))
      .catch((err: unknown) => {
        // No basemap is a degraded map, not a broken app: the route, the
        // network and the aerial view all still draw, over the ground colour.
        // But say so — "the basemap is quietly missing" is a failure this app
        // has shipped before, and it looks identical to a slow network.
        console.warn("basemap failed to load", err);
      });
    // not gated on the network toggle: with the basemap's labels gone, hiding
    // the network would leave a map with no names on it at all
    vis("street-labels", plain);
    if (map.getLayer("street-labels") !== undefined) {
      map.setPaintProperty("street-labels", "text-color", dark || aerial ? "#f2f5fa" : "#1d2430");
      map.setPaintProperty(
        "street-labels",
        "text-halo-color",
        dark || aerial ? "rgba(10,14,22,0.9)" : "rgba(255,255,255,0.92)",
      );
    }
    if (map.getLayer("route-casing") !== undefined) {
      map.setPaintProperty("route-casing", "line-color", dark || aerial ? "#9db8ff" : "#1440a0");
    }
    if (map.getLayer("alts") !== undefined) {
      map.setPaintProperty("alts", "line-color", dark || aerial ? "#ccc" : "#777");
    }
    // over photos the lanes need contrast: dark halo + thicker, solid lines
    vis("network-casing", aerial && netOn);
    const [lo, hi] = aerial ? [2.0, 5.0] : [1.2, 3.5];
    const width = classWidth(lo, hi);
    for (const m of CLASS_MARKS) {
      const id = `network-mark-${m.id}`;
      if (map.getLayer(id) === undefined) continue;
      map.setPaintProperty(id, "line-width", classWidth(lo, hi, m.scale));
      map.setPaintProperty(id, "line-opacity", plain ? 0.3 : 0.75);
      if (isTick(m)) {
        map.setPaintProperty(id, "line-color", dark && !aerial ? TICK_INK_DARK : MARK_INK);
      }
    }
    for (const layer of ["network", "network-unconfirmed"]) {
      if (map.getLayer(layer) === undefined) continue;
      map.setPaintProperty(layer, "line-width", width);
      // the network is drawn in the same palette as the route, so while riding
      // it steps back: the line you're following has to be the obvious one.
      // This lives here rather than in startNav because any later call would
      // otherwise undo the dim.
      map.setPaintProperty(layer, "line-opacity", plain ? 0.35 : aerial ? 0.95 : 0.75);
    }
  };
  // map.loaded() is false whenever tiles are streaming, and "load" fires only
  // once per map — gate on layer existence instead, or toggles made while
  // tiles load would be silently dropped.
  //
  // "aerial" is the first layer the load handler adds, so its presence means
  // the others are there too. It used to be "osm-dark", one of the raster
  // basemaps; when those gave way to the vector basemap the id stopped
  // existing, this test went permanently false, and every call queued itself
  // behind a "load" event that had already fired — leaving the basemap added
  // but invisible, with nothing logged.
  if (map.getLayer("aerial") !== undefined) setVis();
  else map.once("load", setVis);
}

function applyDark(dark: boolean): void {
  document.body.classList.toggle("dark", dark);
  el<HTMLInputElement>("dark-mode").checked = dark;
  setSystemBarsDark(dark); // the status bar icons follow the app's theme, not the phone's
  applyBasemap();
}

// Light by default: this is a daylight map, and the basemap + safety colours
// are tuned for it. Dark is opt-in and remembered — following the phone's
// system theme turned it on for riders who never asked for it.
applyDark(readItem(DARK_KEY) === "1");

el<HTMLInputElement>("dark-mode").addEventListener("change", (e: Event) => {
  const dark = (e.target as HTMLInputElement).checked;
  writeItem(DARK_KEY, dark ? "1" : "0");
  applyDark(dark);
});

el<HTMLInputElement>("show-aerial").addEventListener("change", applyBasemap);

el<HTMLInputElement>("show-constr").addEventListener("change", (e: Event) => {
  const on = (e.target as HTMLInputElement).checked;
  for (const layer of ["construction-lines-base", "construction-lines", "construction-pts"]) {
    map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
  }
});

renderPlacesAndRecent();

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

// ---------------------------------------------------------------------------
// in-app update check (native app only): compare the bundled build version
// against the latest release published next to the mirrored APK
// ---------------------------------------------------------------------------

// The release asset, not the Pages mirror. Pages has a ~100 GB/month bandwidth
// allowance and the APK is 90 MB, so a thousand downloads would be the entire
// month's budget and would take the site down with it. Release downloads don't
// count against that at all.
const APK_URL =
  "https://github.com/pelednoam/safe-bikes-lanes/releases/latest/download/family-bike-router.apk";

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
    getBtn.href = APK_URL; // plain link: works even if the handler never runs
    const text = el<HTMLElement>("update-text");
    getBtn.addEventListener("click", (ev: Event) => {
      ev.preventDefault();
      // Says where to look, not that it worked.
      //
      // This used to read "downloading…" the instant the button was tapped,
      // before anything had been asked of Android and whatever the answer was —
      // so when the download silently went nowhere, the app still reported
      // success. The wording now names the two places the file can appear and
      // leaves the rider able to tell that it hasn't.
      text.textContent = "asked Android to download it — look in your notifications, then Downloads";
      startDownload(APK_URL, latest.version);
    });
    el<HTMLButtonElement>("update-dismiss").addEventListener("click", () => {
      banner.style.display = "none";
    });
  } catch {
    // offline or first launch — try again next time
  }
}
// a ride interrupted by Back/reload/crash is saved on the next launch rather
// than silently lost
const interrupted = takeInProgress();
if (interrupted !== null) {
  saveRide(interrupted);
  renderRides();
}

void checkAppUpdate();
// after the map exists, so the marker has something to land on
void locateIfAlreadyAllowed();

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
        // Only the stale shell a worker left behind. The bike-tiles* and
        // bike-styles* caches are the rider's downloaded offline maps, which
        // the app reads itself (tilecache.ts) — deleting them here, as this
        // once did on every launch, made "⬇ Offline map" a no-op in the app.
        for (const k of await caches.keys()) {
          if (k.startsWith("family-bike-router")) await caches.delete(k);
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
        swReload.request(); // not mid-ride: held until the ride ends
      });
    }
    // updateViaCache:"none" — always fetch sw.js fresh so updates are detected
    void navigator.serviceWorker
      .register("sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// "Where to build" — the city-facing view of pipeline/priorities.py
//
// Everything shown here was measured offline; the panel only filters, re-sorts
// and explains. The weight sliders change the ordering, never the numbers, so a
// city can disagree with our weighting without needing the pipeline.
// ---------------------------------------------------------------------------

interface ProjectProps {
  pid: string;
  name: string;
  kind: string;
  towns: string;
  cls: string;
  length_m: number;
  score: number;
  join_m: number;
  crashes: number | null;
  dest_unlocked: number | null;
  pop_gaining: number | null;
  cost_proxy: number;
  group: string;
  group_size: number;
  summary: string;
  c_severance: number;
  c_access: number;
  c_crash: number;
  c_coverage: number;
}

interface PriorityMeta {
  built?: string;
  candidates?: number;
  mapped?: number;
  destinations?: number;
  population?: { total?: number; is_headcount?: boolean; source?: string };
  access?: { stranded_pct?: number; budget_m?: number; budget_note?: string };
  model?: {
    weights?: { severance?: number; access?: number; crash?: number; coverage?: number };
  };
  limits?: string[];
}

const WEIGHT_KEYS = ["severance", "access", "crash", "coverage"] as const;
type WeightKey = (typeof WEIGHT_KEYS)[number];

/** The slider positions matching the weighting the pipeline actually ranked with.
 *
 * Read from the data rather than repeated here. These used to be four literals
 * with a comment saying they were the pipeline's weighting — which was true only
 * as long as nobody changed PRIORITY_WEIGHTS, and if anyone had, this list and
 * the /build workspace would have disagreed with the exported score, and with
 * each other, about which project a city should do first.
 */
function publishedWeightPositions(): Record<WeightKey, string> | null {
  const w = priorityMeta?.model?.weights;
  if (w === undefined) return null;
  const vals = WEIGHT_KEYS.map((k) => w[k]);
  if (!vals.every((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    return null;
  }
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const out = {} as Record<WeightKey, string>;
  WEIGHT_KEYS.forEach((k, i) => {
    out[k] = String(Math.round(((vals[i] as number) / total) * 100));
  });
  return out;
}

let projects: ProjectProps[] = [];
/** The loaded layer, kept so re-weighting can repaint it. */
let projectFC: GeoJSON.FeatureCollection | null = null;
/** Extent per project, kept from the panel's own load.
 *
 * Read from the map source instead, selecting a row did nothing at all unless
 * the overlay toggle happened to be on already — the source is only filled when
 * the layer loads. The panel has the geometry in hand; it should use it. */
const projectBounds = new Map<string, [[number, number], [number, number]]>();
let priorityMeta: PriorityMeta | null = null;
let selectedProject: string | null = null;

function weightValues(): Record<WeightKey, number> {
  const raw = {} as Record<WeightKey, number>;
  let total = 0;
  for (const key of WEIGHT_KEYS) {
    const v = Number(el<HTMLInputElement>(`wt-${key}`).value);
    raw[key] = v;
    total += v;
  }
  if (total <= 0) return { severance: 1, access: 0, crash: 0, coverage: 0 };
  for (const key of WEIGHT_KEYS) raw[key] /= total;
  return raw;
}

/** Every project's score under the current weights, for painting the map. */
function scoreAllProjects(): Map<string, number> {
  const w = weightValues();
  return new Map(
    projects.map((p) => [
      p.pid,
      Math.round(
        (w.severance * p.c_severance +
          w.access * p.c_access +
          w.crash * p.c_crash +
          w.coverage * p.c_coverage) *
          1000,
      ) / 1000,
    ]),
  );
}

/** Re-score with the panel's weights. The components are what the pipeline
 * measured; only their relative importance is the reader's to choose. */
function rankedProjects(): ProjectProps[] {
  const w = weightValues();
  const town = el<HTMLSelectElement>("build-town").value;
  const seenGroups = new Set<string>();
  return projects
    .filter(
      (p) =>
        town === "" ||
        // exact, per name: a substring match put Lynnfield under Lynn, North
        // Reading under Reading, and North Andover under Andover
        p.towns
          .split(",")
          .map((t) => t.trim())
          .includes(town),
    )
    .map((p) => ({
      p,
      score:
        w.severance * p.c_severance +
        w.access * p.c_access +
        w.crash * p.c_crash +
        w.coverage * p.c_coverage,
    }))
    .sort((a, b) => b.score - a.score)
    .filter(({ p }) => {
      // one row per gap: alternatives across the same barrier are listed on the
      // row they belong to, not as separate near-identical entries
      if (seenGroups.has(p.group)) return false;
      seenGroups.add(p.group);
      return true;
    })
    .map(({ p, score }) => ({ ...p, score: Math.round(score * 1000) / 1000 }));
}

function focusProject(pid: string): void {
  selectedProject = pid;
  if (!projects.some((p) => p.pid === pid)) return;
  // choosing a project shows the projects: it would be odd to highlight
  // something on an invisible layer
  const toggle = el<HTMLInputElement>("show-build");
  if (!toggle.checked) {
    toggle.checked = true;
    ensureLayer("build");
    ensureLayer("crossings");
    map.setLayoutProperty("build", "visibility", "visible");
    map.setLayoutProperty("crossings", "visibility", "visible");
  }
  if (map.getLayer("build-selected")) {
    map.setFilter("build-selected", ["==", ["get", "pid"], pid]);
    map.setLayoutProperty("build-selected", "visibility", "visible");
  }
  const box = projectBounds.get(pid);
  if (box) map.fitBounds(box, { padding: 90, maxZoom: 16.5, duration: 600 });
  el<HTMLDivElement>("whatif").style.display = "block";
  if (whatIfPid !== null && whatIfPid !== pid) clearWhatIf();
  else el<HTMLDivElement>("whatif-result").textContent = "";
  renderBuildList();
}

/** Repaint the map with the reader's weighting.
 *
 * The layer's colour and width are driven by the score property, so moving the
 * sliders re-sorted the list while the map kept painting our own weighting —
 * the two openly contradicted each other about which project was the big one.
 */
function repaintProjects(scored: Map<string, number>): void {
  if (!projectFC || map.getSource("build") === undefined) return;
  for (const f of projectFC.features) {
    const pid = (f.properties as { pid?: string } | null)?.pid;
    if (pid === undefined || f.properties === null) continue;
    const score = scored.get(pid);
    if (score !== undefined) f.properties["score"] = score;
  }
  (map.getSource("build") as GeoJSONSource).setData(projectFC);
}

// ── what if this were protected? ──────────────────────────────────────────
// The ranked list asserts a project is worth building. This lets the reader
// check it against their own trip, which is the difference between a number
// and an argument.

let whatIfPid: string | null = null;
/** The trip as really planned, kept while the what-if's version of it is on
 * screen. The hypothetical is computed against a street that does not exist, so
 * it lives only in the what-if view: undo, a new plan and starting a ride all
 * leave it, and none of them ever see a router with the project applied (see
 * withUpgraded). */
let whatIfReal: { options: RouteOption[]; selected: RouteOption["id"] | null } | null = null;

/** Leave the what-if view without touching what is drawn — for a new plan,
 * which is about to replace the drawn trip anyway. */
function endWhatIf(): void {
  if (whatIfPid === null && whatIfReal === null) return;
  whatIfPid = null;
  whatIfReal = null;
  el<HTMLButtonElement>("whatif-clear").style.display = "none";
  el<HTMLDivElement>("whatif-result").textContent = "";
}

function whatIfPoints(pid: string): [number, number][] {
  const feature = projectFC?.features.find(
    (f) => (f.properties as { pid?: string } | null)?.pid === pid,
  );
  if (!feature) return [];
  const parts: [number, number][] =
    feature.geometry.type === "MultiLineString"
      ? (feature.geometry.coordinates.flat() as [number, number][])
      : feature.geometry.type === "LineString"
        ? (feature.geometry.coordinates as [number, number][])
        : [];
  return parts;
}

/** Undo: the real trip back on screen, exactly as it was planned. */
function clearWhatIf(): void {
  const real = whatIfReal;
  endWhatIf();
  if (real === null) return;
  // anything still working out a what-if is for a view that is gone
  routeLane.cancel();
  options = real.options;
  const back = real.selected ?? options[0]?.id;
  if (back !== undefined) selectOption(back);
}

async function runWhatIf(pid: string): Promise<void> {
  const out = el<HTMLDivElement>("whatif-result");
  const points = whatIfPoints(pid);
  if (points.length === 0) {
    out.textContent = "couldn't find that project's shape";
    return;
  }
  if (!start || !end) {
    // no trip planned: answer with reach instead, which needs only one point
    const from = start ?? end;
    if (!router || !from) {
      out.textContent = "plan a trip, or set a start, and ask again";
      return;
    }
    const at = from.getLngLat();
    const budget = 2500;
    const r = router;
    const before = r.safeShed([at.lng, at.lat], budget, profileId, preferFlat);
    const { result: after } = withUpgraded(r, points, () =>
      r.safeShed([at.lng, at.lat], budget, profileId, preferFlat),
    );
    whatIfPid = pid;
    el<HTMLButtonElement>("whatif-clear").style.display = "";
    const gain = Math.round((after.reachableKm - before.reachableKm) * 10) / 10;
    out.textContent =
      gain > 0
        ? `From your start, ${fmtDistTight(gain * 1000)} more of kid-safe street comes into ` +
          `reach (${fmtDistTight(before.reachableKm * 1000)} → ` +
          `${fmtDistTight(after.reachableKm * 1000)}).`
        : "From your start, this one doesn't change what's in reach.";
    return;
  }

  // measured against the real trip, even when another what-if is on screen —
  // which goes first, so a failure below leaves the real trip drawn
  clearWhatIf();
  const real = { options, selected: selectedId };
  const chosen = real.options.find((o) => o.id === real.selected) ?? real.options[0];
  if (!chosen) {
    out.textContent = "plan a trip first, then ask";
    return;
  }
  const was = chosen.payload.summary;
  const s = start.getLngLat();
  const d = end.getLngLat();
  const a: [number, number] = [s.lng, s.lat];
  const b: [number, number] = [d.lng, d.lat];
  const ticket = beginPlan();
  const r = await ensureRouter([a, b], 1200, 1);
  if (ticket.stale()) return;
  let hypothetical: RouteOption[] = [];
  let covered = 0;
  try {
    if (r === null) throw new Error("unmapped");
    // applied for this one computation and taken off again before anything
    // else can route: the next trip, a search grade or a ride must never be
    // planned along a lane that has only been proposed
    ({ covered, result: hypothetical } = withUpgraded(r, points, () =>
      planOptions(r, a, b, routePrefs()),
    ));
  } catch {
    hypothetical = [];
  }
  const shown = hypothetical.find((o) => o.id === chosen.id) ?? hypothetical[0];
  if (!shown) {
    out.textContent = "couldn't re-plan with that built";
    return;
  }
  whatIfReal = real;
  whatIfPid = pid;
  options = hypothetical;
  selectOption(shown.id);
  el<HTMLButtonElement>("whatif-clear").style.display = "";
  const now = shown.payload.summary;
  const dM = now.meters - was.meters;
  const dProt = now.pct_protected - was.pct_protected;
  const parts: string[] = [];
  if (dProt !== 0) parts.push(`${dProt > 0 ? "+" : ""}${dProt}% protected`);
  if (Math.abs(dM) >= 50) parts.push(`${dM > 0 ? "+" : "−"}${fmtDist(Math.abs(dM))}`);
  out.innerHTML = "";
  const line = document.createElement("b");
  line.textContent =
    parts.length > 0
      ? `Your trip: ${parts.join(", ")}.`
      : "Your trip doesn't change — this project isn't on your way.";
  out.appendChild(line);
  // never let the phrasing imply more was modelled than actually matched
  out.appendChild(
    document.createTextNode(
      ` Modelled as ${covered} rebuilt segment${covered === 1 ? "" : "s"}, separated,` +
        " with its crash history and crossing penalty removed — the same" +
        " assumption the ranking uses.",
    ),
  );
}

function renderBuildList(): void {
  const box = el<HTMLDivElement>("build-list");
  box.innerHTML = "";
  const ranked = rankedProjects();
  // scored over every project, not the deduped list: the map draws the
  // alternatives too, and they'd otherwise keep our weighting while the rest
  // switched to the reader's
  repaintProjects(scoreAllProjects());
  if (ranked.length === 0) {
    box.textContent = "no candidate projects here";
    return;
  }
  ranked.slice(0, 20).forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "build-row" + (p.pid === selectedProject ? " selected" : "");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", p.pid === selectedProject ? "true" : "false");
    row.setAttribute("data-pid", p.pid);
    const head = document.createElement("div");
    head.className = "build-where";
    const rank = document.createElement("span");
    rank.className = "build-rank";
    rank.textContent = `${i + 1}.`;
    head.appendChild(rank);
    if (p.kind === "spot_fix") {
      // A spot fix is one location, not a length to protect. Rebuilding the
      // heading as "39 m of X" re-imposed the corridor framing the pipeline
      // deliberately avoids, and made the distinction invisible here.
      const badge = document.createElement("span");
      badge.className = "build-badge";
      badge.textContent = "spot fix";
      head.appendChild(badge);
    }
    head.appendChild(
      document.createTextNode(
        `${fmtDist(p.length_m)} of ${p.name}${p.towns ? ` — ${p.towns}` : ""}`,
      ),
    );
    row.appendChild(head);
    const why = document.createElement("div");
    why.className = "build-why";
    // the pipeline's own sentence, minus the "N m of Street (Town)" opener the
    // heading above already carries
    why.textContent = p.summary.split("; ").slice(1).join("; ");
    if (p.kind === "spot_fix") {
      why.textContent = `one location to treat — ${why.textContent}`;
    }
    row.appendChild(why);
    if (p.group_size > 1) {
      const alt = document.createElement("div");
      alt.className = "build-alt";
      alt.textContent = `${p.group_size - 1} other way${p.group_size > 2 ? "s" : ""} across the same gap`;
      row.appendChild(alt);
    }
    const act = (): void => {
      focusProject(p.pid);
    };
    const preview = (on: boolean): void => {
      if (map.getLayer("build-hover") === undefined) return;
      map.setFilter("build-hover", ["==", ["get", "pid"], on ? p.pid : ""]);
      // only useful once the layer is drawable; focusProject turns it on
      map.setLayoutProperty(
        "build-hover",
        "visibility",
        on && el<HTMLInputElement>("show-build").checked ? "visible" : "none",
      );
    };
    row.addEventListener("mouseenter", () => preview(true));
    row.addEventListener("mouseleave", () => preview(false));
    row.addEventListener("focus", () => preview(true));
    row.addEventListener("blur", () => preview(false));
    row.addEventListener("click", act);
    row.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        act();
      }
    });
    box.appendChild(row);
  });
  if (ranked.length > 20) {
    const more = document.createElement("div");
    more.className = "hint";
    // never imply the list is the whole field
    const all = priorityMeta?.candidates ?? ranked.length;
    more.textContent =
      `showing the top 20 of ${ranked.length} mapped project` +
      `${ranked.length === 1 ? "" : "s"}; the CSV has all ${all} that were measured`;
    box.appendChild(more);
  }
}

function describeMeta(meta: PriorityMeta): void {
  const pct = meta.access?.stranded_pct;
  const headcount = meta.population?.is_headcount === true;
  const who = headcount ? "residents" : "homes (estimated from street length)";
  el<HTMLParagraphElement>("build-intro").textContent =
    pct === undefined
      ? "Candidate projects, ranked by how much safe network they'd open up."
      : `${pct}% of ${who} in the mapped towns can't reach a school, playground or ` +
        `library within ${fmtDistTight(meta.access?.budget_m ?? 0)} of ` +
        "perceived distance. These are the projects that would change that most.";
  const limits = meta.limits ?? [];
  // A field the build did not record is not a zero. "Measured 0 candidates
  // against 0 schools" reads as a finished analysis that found nothing, which is
  // the opposite of what a missing count means.
  const counted = (n: number | undefined): string => (n === undefined ? "the" : String(n));
  el<HTMLDivElement>("build-method").textContent =
    `Measured ${counted(meta.candidates)} candidates against ${counted(meta.destinations)} ` +
    `schools, playgrounds and libraries it found (data built ` +
    `${meta.built ?? "an unrecorded date"}). Method and limits are in About.`;

  // The same limits, in full, where someone checking a number will look. A
  // ranking a city might quote in public needs its caveats somewhere citable.
  el<HTMLDivElement>("about-build").style.display = limits.length > 0 ? "block" : "none";
  el<HTMLParagraphElement>("about-build-text").textContent =
    `Every street a kid can't use is cut into candidate projects, and each is ` +
    `measured against the network as it stands: what kid-safe network it would ` +
    `join, how much closer it brings people to ${counted(meta.destinations)} schools, ` +
    `playgrounds and libraries, its recorded bike crashes, and how many ` +
    `residents gain a safe route at all. Population is ${
      meta.population?.source ?? "unavailable"
    }. ${meta.access?.budget_note ?? ""}`;
  const list = el<HTMLUListElement>("about-build-limits");
  list.innerHTML = "";
  for (const limit of limits) {
    const li = document.createElement("li");
    li.textContent = limit;
    list.appendChild(li);
  }
}

/** Decide whether this data build has a ranking at all — 2 KB, at boot.
 *
 * The ranking itself is 2.8 MB and is for cities, not riders, so it waits until
 * someone opens the section or turns the layer on. Loading it at boot meant
 * every phone pulled three megabytes of project geometry to render a panel
 * almost nobody opens. Absent metadata hides the section entirely: a published
 * data snapshot can predate this module. */
let buildMetaStarted = false;
function ensureBuildMeta(): void {
  if (buildMetaStarted) return;
  buildMetaStarted = true;
  void dataReady
    .then(() => loadJson<PriorityMeta>("priorities_meta.json"))
    .then((meta) => {
      priorityMeta = meta;
      // the sliders start where the analysis did, so this list and /build open on
      // the same ranking as the exported score
      const published = publishedWeightPositions();
      if (published) {
        for (const key of WEIGHT_KEYS) el<HTMLInputElement>(`wt-${key}`).value = published[key];
      }
      el<HTMLDetailsElement>("build-box").style.display = "block";
      describeMeta(meta);
    })
    .catch(() => {
      el<HTMLDetailsElement>("build-box").style.display = "none";
    });
}

/** Load the projects themselves, on first real use. */
let buildDataStarted = false;
function ensureBuildData(): void {
  if (buildDataStarted) return;
  buildDataStarted = true;
  el<HTMLDivElement>("build-list").textContent = "loading projects…";
  void dataReady
    .then(() => loadJson<GeoJSON.FeatureCollection>("priorities.geojson"))
    .then((fc) => {
      projectFC = fc;
      projects = fc.features
        .map((f) => f.properties as unknown as ProjectProps)
        .filter((p) => p && typeof p.pid === "string");
      projectBounds.clear();
      for (const f of fc.features) {
        const pid = (f.properties as { pid?: string } | null)?.pid;
        if (pid === undefined) continue;
        const parts: [number, number][] =
          f.geometry.type === "MultiLineString"
            ? (f.geometry.coordinates.flat() as [number, number][])
            : f.geometry.type === "LineString"
              ? (f.geometry.coordinates as [number, number][])
              : [];
        if (parts.length < 2) continue;
        let w = Infinity;
        let sth = Infinity;
        let e = -Infinity;
        let n = -Infinity;
        for (const [lon, lat] of parts) {
          w = Math.min(w, lon);
          e = Math.max(e, lon);
          sth = Math.min(sth, lat);
          n = Math.max(n, lat);
        }
        projectBounds.set(pid, [
          [w, sth],
          [e, n],
        ]);
      }
      const towns = new Set<string>();
      for (const p of projects) {
        for (const t of p.towns.split(",")) {
          const name = t.trim();
          if (name && name !== "-") towns.add(name);
        }
      }
      const select = el<HTMLSelectElement>("build-town");
      select.innerHTML = "";
      const all = document.createElement("option");
      all.value = "";
      all.textContent = `all towns (${projects.length} mapped projects)`;
      select.appendChild(all);
      for (const town of [...towns].sort()) {
        const opt = document.createElement("option");
        opt.value = town;
        opt.textContent = town;
        select.appendChild(opt);
      }
      renderBuildList();
    })
    .catch(() => {
      // metadata said there was a ranking and the ranking didn't load: say so
      // rather than leaving "loading projects…" up forever
      el<HTMLDivElement>("build-list").textContent =
        "couldn't load the projects — check your connection and reopen this section";
      buildDataStarted = false;
    });
}

// wiring: the two toggles, the filter, the sliders, and the CSV
for (const [checkbox, layer] of [
  ["show-access", "access"],
  ["show-build", "build"],
] as const) {
  el<HTMLInputElement>(checkbox).addEventListener("change", (e: Event) => {
    const on = (e.target as HTMLInputElement).checked;
    if (on) ensureLayer(layer);
    map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    if (layer === "build") {
      // spot fixes ride with the projects: same list, drawn as points because a
      // 14 m line can't be seen or tapped at this zoom
      if (on) {
        ensureBuildData();
        ensureLayer("crossings");
      } else if (map.getLayer("build-selected")) {
        map.setLayoutProperty("build-selected", "visibility", "none");
      }
      map.setLayoutProperty("crossings", "visibility", on ? "visible" : "none");
    }
  });
}

/** One project, on one page, for a meeting.
 *
 * Deliberately not a screenshot of the panel: it has to stand alone once it is
 * printed, so it carries the numbers, where they came from, and what they do
 * not mean. A page a city might hand round is exactly where a model's caveats
 * are most likely to get lost. */
function printProject(pid: string): void {
  const p = projects.find((x) => x.pid === pid);
  if (!p) return;
  const meta = priorityMeta;
  const esc = (t: string): string =>
    t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
  const headcount = meta?.population?.is_headcount === true;
  const rows: [string, string][] = [
    ["Where", `${esc(p.name)}${p.towns ? ` — ${esc(p.towns)}` : ""}`],
    ["Length", fmtDist(p.length_m)],
    ["Today", esc(p.cls.replace(/_/g, " "))],
    ["Kind", p.kind === "spot_fix" ? "spot fix (one location)" : "corridor"],
    // join_m is the smaller of the two sides — the streets connected in, not the
    // network they connect to. The /build workspace says it this way too; two
    // surfaces describing one field differently is how a city gets two answers.
    ["Kid-safe streets it would connect in", fmtDist(p.join_m)],
  ];
  if (p.dest_unlocked !== null) {
    rows.push([
      "Schools, playgrounds, libraries on the network it opens",
      String(p.dest_unlocked),
    ]);
  }
  if (p.pop_gaining !== null && headcount) {
    rows.push(["Residents gaining a safe route", Math.round(p.pop_gaining).toLocaleString()]);
  }
  if (p.crashes !== null) rows.push(["Bike crashes since 2021", String(p.crashes)]);
  rows.push([
    "Cost, order of magnitude",
    `$${Math.round(p.cost_proxy).toLocaleString()} — a sorting proxy, not an estimate`,
  ]);

  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(
    `<html><head><title>${esc(p.name)} — where to build</title><style>
      body{font-family:sans-serif;font-size:13px;max-width:640px;margin:24px auto;line-height:1.5}
      h1{font-size:20px;margin:0 0 2px} .sub{color:#555;margin:0 0 14px}
      table{border-collapse:collapse;width:100%;margin-bottom:14px}
      th,td{border-bottom:1px solid #ddd;padding:5px 6px;text-align:left;vertical-align:top}
      th{width:44%;font-weight:600;color:#333}
      .limits{font-size:11.5px;color:#555} .limits li{margin-bottom:3px}
      .method{font-size:11.5px;color:#555;border-top:1px solid #ddd;padding-top:8px}
    </style></head><body>
    <h1>${esc(p.name)}</h1>
    <p class="sub">${esc(p.summary)}</p>
    <table>${rows
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
      .join("")}</table>
    <p class="method"><b>How this was measured.</b> Streets a child can't use are
    cut into candidate projects and each is scored on four things: the kid-safe
    streets it would connect in, how much closer it brings people to
    ${meta?.destinations === undefined ? "the" : String(meta.destinations)} schools,
    playgrounds and libraries it counted, its recorded
    bike crashes, and how many residents gain a safe route at all. Population:
    ${esc(meta?.population?.source ?? "not available")}.
    ${esc(meta?.access?.budget_note ?? "")}
    Data built ${esc(meta?.built ?? "—")}; ${meta?.candidates ?? 0} candidates
    were measured.</p>
    <p class="limits"><b>What these numbers do not mean:</b></p>
    <ul class="limits">${(meta?.limits ?? [])
      .map((l) => `<li>${esc(l)}</li>`)
      .join("")}</ul>
    </body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
}

el<HTMLButtonElement>("build-print").addEventListener("click", () => {
  if (selectedProject !== null) printProject(selectedProject);
});

el<HTMLButtonElement>("whatif-run").addEventListener("click", () => {
  if (selectedProject !== null) void runWhatIf(selectedProject);
});
el<HTMLButtonElement>("whatif-clear").addEventListener("click", clearWhatIf);

el<HTMLSelectElement>("build-town").addEventListener("change", () => {
  selectedProject = null;
  if (map.getLayer("build-selected")) {
    map.setLayoutProperty("build-selected", "visibility", "none");
  }
  renderBuildList();
});

for (const key of WEIGHT_KEYS) {
  el<HTMLInputElement>(`wt-${key}`).addEventListener("input", renderBuildList);
}

el<HTMLButtonElement>("wt-reset").addEventListener("click", () => {
  // back to the pipeline's own weighting, which the exported score used
  const defaults: Record<WeightKey, string> = publishedWeightPositions() ?? {
    severance: "40",
    access: "30",
    crash: "15",
    coverage: "15",
  };
  for (const key of WEIGHT_KEYS) el<HTMLInputElement>(`wt-${key}`).value = defaults[key];
  renderBuildList();
});

el<HTMLButtonElement>("build-csv").addEventListener("click", () => {
  // the full ranking, not the top 20 on screen and not the town filter's slice
  const a = document.createElement("a");
  a.href = dataUrl("priorities.csv");
  a.download = "where-to-build.csv";
  a.click();
});

// clicking a project on the map selects it in the list, and the other way round
onTap("build", (e: MapLayerMouseEvent) => {
  const pid = (e.features?.[0]?.properties as { pid?: string } | undefined)?.pid;
  if (pid !== undefined) {
    if (!el<HTMLDetailsElement>("build-box").open) {
      el<HTMLDetailsElement>("build-box").open = true;
    }
    focusProject(pid);
  }
});
onTap("crossings", (e: MapLayerMouseEvent) => {
  const pid = (e.features?.[0]?.properties as { pid?: string } | undefined)?.pid;
  if (pid !== undefined) {
    if (!el<HTMLDetailsElement>("build-box").open) {
      el<HTMLDetailsElement>("build-box").open = true;
    }
    focusProject(pid);
  }
});
map.on("mouseenter", "crossings", () => {
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "crossings", () => {
  map.getCanvas().style.cursor = "";
});
map.on("mouseenter", "build", () => {
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "build", () => {
  map.getCanvas().style.cursor = "";
});

el<HTMLDetailsElement>("build-box").addEventListener("toggle", () => {
  if (el<HTMLDetailsElement>("build-box").open) ensureBuildData();
});

// at boot, only the 2 KB metadata: it decides whether the section exists
ensureBuildMeta();
