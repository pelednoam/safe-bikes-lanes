// Getting the app its data: the data source, the routing worker's manifest and
// tiles, the network tiles on screen, construction and points of interest, and what
// the rider is told while it happens.

import { dataSource, loadJson, usingRemoteData } from "../data.js";
import { el, emptyFC } from "./dom.js";
import { esc } from "../segment.js";
import { dataReady, routing } from "./services.js";
import { type ConstructionFC, store } from "./store.js";
import { getUnits } from "../units.js";
import { withRetry } from "../retry.js";
import { WORKER_FAILED } from "../rpc.js";
import { reportCaught } from "../report.js";
import { NetworkTiles } from "../tiles.js";
import { map } from "./map.js";
import { type GeoJSONSource } from "maplibre-gl";
import { HOME, outsideCoverage } from "../coverage.js";
import { type PoiFeature } from "../types.js";
import { readItem } from "../storage.js";

// first launch after a website data refresh downloads layers from the site;
// surface that as progress (native only — bundled loads are instant)
const DATA_STEPS = 4; // tile manifest + network + pois + construction (overlays are lazy)

let dataDone = 0;

export function dataProgress(): void {
  if (usingRemoteData() === null) return;
  dataDone += 1;
  const box = el<HTMLDivElement>("data-update");
  if (dataDone >= DATA_STEPS) box.style.display = "none";
  else {
    box.textContent = `\u2b07 Updating map data\u2026 ${dataDone}/${DATA_STEPS}`;
    box.style.display = "block";
  }
}

// Routing graph is tiled (pipeline/export_web.py): the browser loads only the
// tiles covering a route's corridor, so coverage can scale toward all of MA
// without a giant download. The worker (re)builds the graph over whatever
// tiles are loaded; ensureRouter has it fetch the ones an area needs first.
let announceTimer: number | undefined;

/** Say something to a screen reader without putting it on screen.
 *
 * Route results, grades and search answers all arrive by redrawing part of the
 * panel, which a screen reader does not notice: a blind parent asked for a
 * route and heard nothing at all. `delayMs` lets a burst — a list redrawn on
 * every keystroke — settle into one announcement. */
export function announce(text: string, delayMs = 0): void {
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    const box = document.getElementById("sr-status");
    if (box === null) return;
    // the same words twice in a row are only announced if the node changes
    box.textContent = box.textContent === text ? `${text}\u00a0` : text;
  }, delayMs);
}

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
export function showStage(text: string, sub = ""): void {
  const box = el<HTMLDivElement>("loading");
  box.innerHTML =
    `<span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span>` +
    (sub === "" ? "" : `<small>${esc(sub)}</small>`);
  box.style.display = "flex";
}

/** Have the worker load the tiles covering `points` (± padM metres, plus a
 * margin) and build the graph over them. False if the area has no mapped tiles. */
export async function ensureRouter(
  points: [number, number][],
  padM: number,
  margin = 1,
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
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
  const { ready } = await routing.ensure(points, marginCells, onProgress);
  if (!ready) return false;
  store.routerReady = true;
  return true;
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

export const manifestReady: Promise<void> = dataReady
  .then(() => routing.configure(dataSource(), getUnits()))
  .then(() =>
    withRetry(() => routing.loadManifest(), {
      onRetry: (err, _attempt, delayMs) => {
        // a route finder that never started is not a slow network: waiting
        // and retrying won't bring it back, and the rider should know
        if (err instanceof Error && err.message === WORKER_FAILED) {
          reportCaught("worker", err);
          const errBox = el<HTMLDivElement>("error");
          errBox.textContent = `Can't plan routes: ${WORKER_FAILED}.`;
          errBox.dataset["from"] = "dataload";
          errBox.style.display = "block";
          return;
        }
        dataLoadTrouble("the map data", delayMs);
      },
    }),
  )
  .then(() => {
    dataLoadRecovered();
    el<HTMLDivElement>("loading").style.display = "none";
    dataProgress();
  });

// The display network also tiles, but loads by VIEWPORT rather than by route
// corridor (it's shown by default across the whole visible area). Below this
// zoom individual streets aren't legible and the viewport spans too many
// tiles, so the layer clears — pan/zoom in and it repopulates.
const NET_MIN_ZOOM = 12;

export const netTiles = new NetworkTiles(loadJson);

export const networkReady: Promise<void> = dataReady.then(() =>
  withRetry(() => netTiles.loadManifest(), {
    onRetry: (_err, _attempt, delayMs) => dataLoadTrouble("the street safety map", delayMs),
  }).then(dataLoadRecovered),
);

let netToken = 0;

/** Fill the network source with the streets in the current viewport. */
export async function refreshNetworkTiles(): Promise<void> {
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

let netRefreshTimer: number | undefined;

/** Outside the mapped area there is nothing to draw: no streets, no basemap
 * (it is this area's too), no safety network. A phone located elsewhere
 * opened on a blank grey map with nothing to say why; now the map says what
 * it covers, and takes the rider there. */
function showCoverage(): void {
  const b = map.getBounds();
  const out = !store.navActive && outsideCoverage({
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  });
  el<HTMLDivElement>("outside").style.display = out ? "flex" : "none";
}

export const constructionReady: Promise<void> = dataReady
  .then(() => loadJson<ConstructionFC>("construction.geojson"))
  .then((fc) => {
    store.constructionFC = fc;
  })
  .catch(() => undefined);

/** pois.geojson, fetched and parsed once. The loop planner reads its features
 * and the map's POI layer draws the same collection; each used to load the
 * 786 KB file for itself. null when it could not be loaded. */
export const poisData: Promise<{ features: PoiFeature[] } | null> = dataReady
  .then(() => loadJson<{ features: PoiFeature[] }>("pois.geojson"))
  .catch(() => null);

export const poisReady: Promise<void> = poisData.then((fc) => {
  if (fc) store.pois = fc.features;
});

export function initDataLoad(): void {
  void dataReady.then(() => {
    if (usingRemoteData() !== null) {
      const box = el<HTMLDivElement>("data-update");
      box.textContent = "\u2b07 Updating map data\u2026";
      box.style.display = "block";
    }
  });

  el<HTMLDivElement>("loading").textContent = "loading map…";
  el<HTMLDivElement>("loading").style.display = "block";

  // a jump, not a flight: animating across a continent of empty map is a long
  // wait with nothing to look at
  el<HTMLButtonElement>("outside-go").addEventListener("click", () => {
    map.jumpTo({ center: HOME.center, zoom: HOME.zoom });
  });

  map.on("load", showCoverage);

  map.on("moveend", showCoverage);

  // Debounced: the follow camera drives the map every animation frame while
  // navigating, and each move fires moveend — without this the whole network
  // layer would be re-queried and re-rendered ~60x/second mid-ride.
  map.on("moveend", () => {
    window.clearTimeout(netRefreshTimer);
    netRefreshTimer = window.setTimeout(() => void refreshNetworkTiles(), 300);
  });

  void dataReady
    .then(() => loadJson<{ mapillary?: string }>("keys.json"))
    .then((keys) => {
      store.mapillaryToken = readItem("mapillaryToken") ?? keys.mapillary ?? "";
    })
    .catch(() => undefined);
}
