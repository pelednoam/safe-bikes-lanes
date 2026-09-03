import { CARTO_ATTRIBUTION, CARTO_MAXZOOM, CARTO_TILEJSON, createBasemap, } from "./basemap.js";
import { isNativeApp, isNewerAppVersion, lastNativeSpeechError, nativeSpeak, startDownload, startBackgroundWatcher, stopBackgroundWatcher, webVoiceCount, } from "./native.js";
import { GEOCODE_DEBOUNCE_MS, geocodeDelayMs, matchScore, metresBetween, rank as rankSearch, describe as describeRow, worthGeocoding, } from "./search.js";
import { CLASS_LABELS, cautionsHtml, clearPhotoCache, esc, FACILITY_CLASSES, nearestMapillary, fillSegmentPhoto as fillPhotoSlot, GRADE_COLORS, segmentHtml, } from "./segment.js";
import { bearingDeg, buildAlerts, buildManeuvers, buildTrack, distM, snapToTrack, sunsetTime, trackBearingAhead, trackSlice, } from "./nav.js";
import { addHazard, buildReportText, downscalePhoto, getHazardPhoto, HAZARD_LABELS, listHazards, removeHazard, setHazardCategory, } from "./hazards.js";
import { clearRecent, deletePlace, emojiFor, exportBackup, importBackup, listPlaces, listRecent, pushRecent, savePlace, } from "./places.js";
import { clearRides, deleteRide, loadRides, RideRecorder, rideTotals, saveRide, stashInProgress, takeInProgress, } from "./rides.js";
import { dataUrl, initDataSource, loadJson, usingRemoteData } from "./data.js";
import { buildCues, PROFILES, Router, routeCacheKey, toGPX } from "./router.js";
import { distVoice, fmtDist, fmtClimb, fmtDistTight, fmtSpeed, fromMeters, getUnits, navRound, setUnits, toMeters, unitName, } from "./units.js";
import { NetworkTiles, TileStore } from "./tiles.js";
import { drawRideCard, drawTotalsCard, rideShareText, totalsShareText } from "./sharecard.js";
// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
const CLASS_COLORS = {
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
const POI_META = {
    playground: { emoji: "🛝", label: "playground", color: "#e67e22" },
    ice_cream: { emoji: "🍦", label: "ice cream", color: "#e84393" },
    library: { emoji: "📚", label: "library", color: "#8e44ad" },
    water: { emoji: "🚰", label: "water fountain", color: "#2980b9" },
    restroom: { emoji: "🚻", label: "restroom", color: "#7f8c8d" },
};
const BBOX = { west: -71.60, south: 42.00, east: -70.78, north: 42.63 };
const SKETCHY_KEY = "sketchyMarks";
const DARK_KEY = "darkMode";
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function el(id) {
    const node = document.getElementById(id);
    if (node === null)
        throw new Error(`missing element #${id}`);
    return node;
}
/** Distance to the next turn, bucketed. The banner rounded to 10 m while the
 * voice rounded to 50, so riders heard "in three hundred metres" against a
 * banner reading 280 m and reported it as a bug. Both read this now, so the
 * buckets have to be coarse enough to say out loud. */
// Distances live in metres everywhere inside the app; units.ts is the last step
// before one is shown or spoken, so a rider in Massachusetts reads miles.
const navDistM = navRound;
function navDistText(m) {
    const r = navRound(m);
    return r === 0 ? "now" : fmtDistTight(r);
}
const navDistVoice = distVoice;
function emptyFC() {
    return { type: "FeatureCollection", features: [] };
}
function loadSketchy() {
    try {
        const raw = localStorage.getItem(SKETCHY_KEY);
        if (raw === null)
            return [];
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
function saveSketchy(marks) {
    localStorage.setItem(SKETCHY_KEY, JSON.stringify(marks));
    // this is exactly a change to what the router must avoid, so any grade
    // computed before it is now a claim about a route the app wouldn't plan
    avoidRevision++;
    regradeVisible();
}
// ---------------------------------------------------------------------------
// map setup
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
    container: "map",
    style: {
        version: 8,
        sources: {
            // Carto, not tile.openstreetmap.org. OSM's tile servers are donated
            // infrastructure and their usage policy rules out building a public
            // product on them — they block by referrer, and when that happens the
            // map breaks for every user at once. Carto renders the same OSM data.
            //
            // Vector rather than raster, because Carto now stamps "API KEY REQUIRED"
            // across their raster tiles — see basemap.ts. This one source feeds all
            // four basemap modes; the layers that paint it are injected below, once
            // a GL style has been fetched. The id has to be "carto": it is what
            // those styles' own layers name as their source.
            carto: {
                type: "vector",
                url: CARTO_TILEJSON,
                attribution: CARTO_ATTRIBUTION,
            },
        },
        // vendored SDF glyph ranges (Noto Sans, Latin + Latin-1): the label layer
        // below needs them, and hosting them ourselves keeps labels working
        // offline. Carto's basemap labels are re-pointed at this same stack rather
        // than at their glyph server — see basemap.ts.
        glyphs: "fonts/glyphs/{fontstack}/{range}.pbf",
        // Ground to look at while the basemap styles are in flight. Stays at the
        // bottom of the stack; the fetched layers land on top of it.
        layers: [{ id: "ground", type: "background", paint: { "background-color": "#e9e6e1" } }],
    },
    center: [-71.105, 42.383],
    zoom: 13,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.GeolocateControl({
    trackUserLocation: true,
    positionOptions: { enableHighAccuracy: true },
    fitBoundsOptions: { maxZoom: 16.5 },
}), "top-right");
map.addControl(new maplibregl.ScaleControl({}), "bottom-left");
// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let router = null;
/** Carto's basemap layers, injected under everything this app draws. A theme's
 * style is fetched the first time that theme is shown — see applyBasemap. */
const basemap = createBasemap(map, () => map.getStyle().layers.find((l) => l.id !== "ground")?.id);
let start = null;
let end = null;
// Google-Maps-style flow: origin defaults to the current location; the next
// map tap fills the destination unless the user is explicitly picking a start.
let fromCurrent = true;
let activeField = "end";
let poiMarker = null;
let shedMarker = null;
let profileId = "young_kids";
let preferFlat = false;
let walkMaxM = 0;
const AVOIDABLE = [
    ["lane", "painted lanes"],
    ["buffered", "buffered lanes"],
    ["sharrow", "sharrows"],
    ["moderate_street", "moderate streets"],
    ["busy_street", "busy streets"],
];
let avoidTypes = new Set(JSON.parse(localStorage.getItem("avoidTypes") ?? "[]"));
function syncAvoidSummary() {
    el("avoid-summary").textContent =
        avoidTypes.size === 0 ? "🛡 avoid lane types" : `🛡 avoiding ${avoidTypes.size} lane type${avoidTypes.size > 1 ? "s" : ""}`;
}
let hoverPopup = null;
let options = [];
let selectedId = null;
let shedMode = false;
let shedCenter = null;
let sketchyMarks = loadSketchy();
let pois = [];
let hazards = [];
let mapillaryToken = "";
let constructionFC = null;
/** Sample construction geometries into avoid-points for the router. */
function constructionAvoidPoints(fc) {
    const pts = [];
    const pushCoord = (c) => {
        if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
            pts.push([c[0], c[1]]);
        }
    };
    for (const f of fc.features) {
        const g = f.geometry;
        if (g.type === "Point")
            pushCoord(g.coordinates);
        else if (g.type === "LineString" && Array.isArray(g.coordinates)) {
            for (const c of g.coordinates)
                pushCoord(c);
        }
        else if (Array.isArray(g.coordinates)) {
            for (const part of g.coordinates) {
                if (Array.isArray(part))
                    for (const c of part)
                        pushCoord(c);
            }
        }
    }
    return pts;
}
let hazardPendingLoc = null;
let hazardPhoto = null;
/** Routes avoid both quick sketchy marks and full hazard reports. */
function applyAvoidPoints() {
    router?.setSketchyMarks([
        ...sketchyMarks,
        ...hazards.map((h) => [h.lon, h.lat]),
    ]);
}
let loopParams = null;
let pendingSelect = null;
const dataReady = initDataSource();
// first launch after a website data refresh downloads layers from the site;
// surface that as progress (native only — bundled loads are instant)
const DATA_STEPS = 4; // tile manifest + network + pois + construction (overlays are lazy)
let dataDone = 0;
function dataProgress() {
    if (usingRemoteData() === null)
        return;
    dataDone += 1;
    const box = el("data-update");
    if (dataDone >= DATA_STEPS)
        box.style.display = "none";
    else {
        box.textContent = `\u2b07 Updating map data\u2026 ${dataDone}/${DATA_STEPS}`;
        box.style.display = "block";
    }
}
void dataReady.then(() => {
    if (usingRemoteData() !== null) {
        const box = el("data-update");
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
 */
let onTileProgress;
function showStage(text, sub = "") {
    const box = el("loading");
    box.innerHTML =
        `<span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span>` +
            (sub === "" ? "" : `<small>${esc(sub)}</small>`);
    box.style.display = "flex";
}
async function ensureRouter(points, padM, margin = 1) {
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
    await tiles.ensureCorridor(points, marginCells, onTileProgress);
    if (tiles.loadedCount === 0)
        return null;
    if (router === null || builtTileCount !== tiles.loadedCount) {
        router = new Router(tiles.assemble());
        builtTileCount = tiles.loadedCount;
        applyAvoidPoints();
        if (constructionFC)
            router.setConstructionPoints(constructionAvoidPoints(constructionFC));
        renderSketchy();
    }
    return router;
}
const manifestReady = dataReady
    .then(() => tiles.loadManifest())
    .then(() => {
    void refreshHazards();
    el("loading").style.display = "none";
    dataProgress();
})
    .catch((err) => {
    const errBox = el("error");
    errBox.textContent = `failed to load routing tiles: ${String(err)}`;
    errBox.style.display = "block";
    dataProgress();
});
el("loading").textContent = "loading map…";
el("loading").style.display = "block";
// The display network also tiles, but loads by VIEWPORT rather than by route
// corridor (it's shown by default across the whole visible area). Below this
// zoom individual streets aren't legible and the viewport spans too many
// tiles, so the layer clears — pan/zoom in and it repopulates.
const NET_MIN_ZOOM = 12;
const netTiles = new NetworkTiles(loadJson);
const networkReady = dataReady.then(() => netTiles.loadManifest());
let netToken = 0;
/** Fill the network source with the streets in the current viewport. */
async function refreshNetworkTiles() {
    await networkReady;
    const src = map.getSource("network");
    if (!src)
        return;
    // hidden layer: don't spend bandwidth or battery fetching tiles for it
    // (setNetworkVisible refreshes when it's switched back on)
    if (map.getLayoutProperty("network", "visibility") === "none")
        return;
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
    if (token !== netToken)
        return; // a newer move superseded this fetch
    src.setData({ type: "FeatureCollection", features });
}
// Debounced: the follow camera drives the map every animation frame while
// navigating, and each move fires moveend — without this the whole network
// layer would be re-queried and re-rendered ~60x/second mid-ride.
let netRefreshTimer;
map.on("moveend", () => {
    window.clearTimeout(netRefreshTimer);
    netRefreshTimer = window.setTimeout(() => void refreshNetworkTiles(), 300);
});
void dataReady
    .then(() => loadJson("keys.json"))
    .then((keys) => {
    mapillaryToken = localStorage.getItem("mapillaryToken") ?? keys.mapillary ?? "";
})
    .catch(() => undefined);
const constructionReady = dataReady
    .then(() => loadJson("construction.geojson"))
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
const poisReady = dataReady
    .then(() => loadJson("pois.geojson"))
    .then((fc) => {
    pois = fc.features;
})
    .catch(() => undefined);
function getSource(id) {
    const src = map.getSource(id);
    if (src === undefined)
        throw new Error(`missing source ${id}`);
    return src;
}
// Heavy overlays load their data the first time they're shown, not at startup.
const LAZY_LAYER_FILES = {
    heatmap: "heatmap.geojson",
    lanemap: "lanemap.geojson",
    elevmap: "elevation.geojson",
    gateways: "gateways.geojson",
    access: "access.geojson",
    build: "priorities.geojson",
    crossings: "severance.geojson",
};
const lazyLoaded = new Set();
/** Fetch an overlay's data once, the first time its toggle is turned on. */
function ensureLayer(id) {
    const file = LAZY_LAYER_FILES[id];
    if (file === undefined || lazyLoaded.has(id))
        return;
    lazyLoaded.add(id);
    void dataReady
        .then(() => loadJson(file))
        .then((d) => {
        map.getSource(id).setData(d);
    })
        .catch(() => {
        lazyLoaded.delete(id); // let a later toggle retry
    });
}
function currentPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("no geolocation"));
            return;
        }
        navigator.geolocation.getCurrentPosition((p) => resolve([p.coords.longitude, p.coords.latitude]), (err) => reject(err instanceof Error ? err : new Error(String(err.message))), { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
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
async function locateIfAlreadyAllowed() {
    if (!fromCurrent || start !== null || !navigator.geolocation)
        return;
    try {
        const perms = navigator.permissions;
        if (perms === undefined)
            return; // Safari <16: don't guess, wait to be asked
        const status = await perms.query({ name: "geolocation" });
        if (status.state !== "granted")
            return;
        const at = await currentPosition();
        if (!fromCurrent || start !== null)
            return; // the rider got there first
        start = makeMarker(at, "#2b83ba", "start");
        syncOD();
        map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 14), duration: 600 });
    }
    catch {
        // no position, revoked between the check and the call, or simply slow:
        // the on-demand path still runs when a route is asked for
    }
}
function syncOD() {
    const f = el("from-field");
    if (f.classList.contains("picking"))
        return;
    f.classList.toggle("custom", !fromCurrent);
    if (fromCurrent) {
        f.value = "";
        f.placeholder = "Your location";
    }
    else if (f.value === "") {
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
function revKey(lon, lat) {
    return `${lon.toFixed(4)},${lat.toFixed(4)}`;
}
function revCache() {
    try {
        return JSON.parse(localStorage.getItem(REVGEO_KEY) ?? "{}");
    }
    catch {
        return {};
    }
}
/** The router once it exists, or null if it hasn't within `ms`. */
async function withRouter(ms) {
    const deadline = Date.now() + ms;
    while (router === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 120));
    }
    return router;
}
async function reverseGeocode(lon, lat) {
    const key = revKey(lon, lat);
    const cache = revCache();
    const hit = cache[key];
    if (hit !== undefined)
        return hit;
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
    const local = (await withRouter(10000))?.streetNameAt(lon, lat, 20) ?? null;
    if (local !== null) {
        cache[key] = local;
        try {
            localStorage.setItem(REVGEO_KEY, JSON.stringify(cache));
        }
        catch {
            /* private mode: the name just won't be remembered */
        }
        return local;
    }
    const url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18" +
        `&lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok)
        return null;
    const j = (await resp.json());
    const a = j.address ?? {};
    const street = [a["house_number"], a["road"]].filter((x) => x !== undefined).join(" ");
    const label = (j.name ?? "") ||
        street ||
        a["neighbourhood"] ||
        a["suburb"] ||
        a["city"] ||
        (j.display_name ?? "").split(",")[0] ||
        "";
    if (label !== "") {
        cache[key] = label;
        try {
            localStorage.setItem(REVGEO_KEY, JSON.stringify(cache));
        }
        catch {
            /* private mode: the name just won't be remembered */
        }
    }
    return label === "" ? null : label;
}
/** Name an end in its field, unless the rider typed something there. */
function nameEnd(kind) {
    const marker = kind === "start" ? start : end;
    if (!marker)
        return;
    const field = el(kind === "start" ? "from-field" : "search");
    if (field.value.trim() !== "" && !autoNamed[kind])
        return;
    const { lng, lat } = marker.getLngLat();
    const asked = revKey(lng, lat);
    field.value = "";
    autoNamed[kind] = false;
    void reverseGeocode(lng, lat)
        .then((label) => {
        if (label === null)
            return;
        // the pin may have moved on (or gone) while we were asking
        const now = kind === "start" ? start : end;
        if (!now)
            return;
        const p = now.getLngLat();
        if (revKey(p.lng, p.lat) !== asked)
            return;
        if (field.value.trim() !== "")
            return;
        field.value = label;
        autoNamed[kind] = true;
    })
        .catch(() => undefined); // offline, or Nominatim rate-limiting us
}
function makeMarker(lngLat, color, label) {
    const m = new maplibregl.Marker({ color, draggable: true });
    m.setLngLat(lngLat).addTo(map);
    m.getElement().title = `${label} (drag to move)`;
    m.on("dragend", () => {
        nameEnd(label === "start" ? "start" : "end");
        void requestRoute();
        // a grade is the route FROM the start: move it and the letters on screen
        // describe a journey that no longer begins where the rider does
        if (label === "start")
            regradeVisible();
    });
    return m;
}
function setPoint(kind, lngLat) {
    if (kind === "start") {
        fromCurrent = false;
        el("from-field").classList.remove("picking");
        if (start)
            start.setLngLat(lngLat);
        else
            start = makeMarker(lngLat, "#2b83ba", "start");
        regradeVisible();
    }
    else {
        if (end)
            end.setLngLat(lngLat);
        else
            end = makeMarker(lngLat, "#d7191c", "end");
    }
    syncOD();
    nameEnd(kind);
    void requestRoute();
}
// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------
async function requestRoute() {
    if (!end)
        return;
    await manifestReady;
    const errBox = el("error");
    errBox.style.display = "none";
    const loading = el("loading");
    if (!start) {
        if (!fromCurrent)
            return;
        showStage("Finding your location…");
        loading.style.display = "block";
        try {
            start = makeMarker(await currentPosition(), "#2b83ba", "start");
            syncOD();
        }
        catch {
            loading.style.display = "none";
            errBox.textContent =
                "Couldn't get your location — tap \u201c\ud83d\udccd From\u201d to set a start, or enable location access.";
            errBox.style.display = "block";
            return;
        }
    }
    showStage("Loading the map around your route…");
    onTileProgress = (done, total) => {
        // only once there are enough for the count to mean something
        if (total > 4)
            showStage("Loading the map around your route…", `${done} of ${total}`);
    };
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const s = start.getLngLat();
        const d = end.getLngLat();
        const a = [s.lng, s.lat];
        const b = [d.lng, d.lat];
        poiMarker?.remove();
        poiMarker = null;
        loopParams = null;
        // load the tiles along the corridor, then route; a safe route can detour
        // well outside the straight A–B box, so widen the loaded area once if the
        // first attempt finds nothing.
        const route = (r) => {
            showStage("Finding the safest way…");
            return r.routeOptions(a, b, profileId, preferFlat, undefined, avoidTypes, walkMaxM);
        };
        // a narrow corridor first — it covers ordinary detours and keeps a long
        // trip from pulling a big slice of the map; the retry below widens it
        let r = await ensureRouter([a, b], 1200, 1);
        try {
            if (!r)
                throw new Error("unmapped");
            options = route(r);
            if (!options.length)
                throw new Error("no route");
        }
        catch {
            r = await ensureRouter([a, b], 5000, 2);
            if (!r)
                throw new Error("this area isn't mapped for routing yet");
            options = route(r);
        }
        const fallback = options[0];
        if (!fallback)
            throw new Error("no route found");
        const wanted = pendingSelect;
        pendingSelect = null;
        selectOption(wanted !== null && options.some((o) => o.id === wanted) ? wanted : fallback.id);
        recordRecentRoute([s.lng, s.lat], [d.lng, d.lat]);
        revealSheet();
        frameRoute(fallback);
    }
    catch (err) {
        onTileProgress = undefined;
        options = [];
        selectedId = null;
        renderOptions();
        clearOptionChips();
        errBox.textContent = err instanceof Error ? err.message : String(err);
        errBox.style.display = "block";
    }
    finally {
        loading.style.display = "none";
    }
}
async function requestLoop() {
    await manifestReady;
    const errBox = el("error");
    errBox.style.display = "none";
    if (!start) {
        // A round trip starts where you are, so find that rather than refusing.
        // Telling someone to "click the map to set a start point first" is asking
        // them to do work the app can do, in answer to a button they just pressed.
        showStage("Finding your location…");
        try {
            start = makeMarker(await currentPosition(), "#2b83ba", "start");
            syncOD();
        }
        catch {
            el("loading").style.display = "none";
            errBox.textContent =
                "Couldn't get your location — tap 🗺 next to the start field to pick where the ride begins.";
            errBox.style.display = "block";
            return;
        }
    }
    await poisReady;
    const typed = Number(el("loop-dist").value);
    if (!Number.isFinite(typed) || typed <= 0) {
        errBox.textContent = `How far would you like to ride? Enter a distance in ${unitName()}.`;
        errBox.style.display = "block";
        return;
    }
    const targetM = toMeters(typed);
    const km = targetM / 1000;
    const kind = el("loop-stop").value;
    // null is "no stop wanted" — the router picks a turnaround geometrically,
    // because sometimes the point is just to be out. An empty list is different:
    // it means the stop they asked for has none near enough, which is an error.
    const candidates = kind === "none" ? null : kind === "any" ? pois : pois.filter((p) => p.properties.kind === kind);
    const loading = el("loading");
    showStage("Loading the map around you…");
    onTileProgress = (done, total) => {
        if (total > 4)
            showStage("Loading the map around you…", `${done} of ${total}`);
    };
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const s = start.getLngLat();
        // a loop can range out to roughly half its length from the start
        const r = await ensureRouter([[s.lng, s.lat]], targetM / 2, 2);
        if (!r)
            throw new Error("this area isn't mapped for routing yet");
        onTileProgress = undefined;
        showStage(`Finding a ${fmtDistTight(targetM)} loop…`);
        const { option, poi, more } = r.loopRoute([s.lng, s.lat], targetM, candidates, profileId, preferFlat);
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
    }
    catch (err) {
        errBox.textContent = err instanceof Error ? err.message : String(err);
        errBox.style.display = "block";
    }
    finally {
        onTileProgress = undefined;
        loading.style.display = "none";
    }
}
let optionChips = [];
function clearOptionChips() {
    for (const c of optionChips)
        c.remove();
    optionChips = [];
}
/** Selectable grade·time chips on the map, one per alternative (Google-style,
 * but the lead label is the safety grade, not the ETA). */
function renderOptionChips() {
    clearOptionChips();
    if (options.length < 2)
        return; // no choice to make
    options.forEach((o, i) => {
        const coords = o.payload.geojson.features.flatMap((f) => f.geometry.coordinates);
        if (coords.length === 0)
            return;
        const frac = Math.min(0.9, 0.35 + i * 0.2);
        const pt = coords[Math.floor(coords.length * frac)] ?? coords[coords.length - 1];
        if (!pt)
            return;
        const chip = document.createElement("div");
        chip.className = "opt-chip" + (o.id === selectedId ? " sel" : "");
        chip.style.setProperty("--g", GRADE_COLORS[o.grade]);
        chip.textContent = `${o.grade} · ${o.payload.summary.minutes}m`;
        chip.title = `${o.label}: ${o.gradeReason}`;
        chip.addEventListener("click", (ev) => {
            ev.stopPropagation();
            selectOption(o.id);
        });
        optionChips.push(new maplibregl.Marker({ element: chip }).setLngLat(pt).addTo(map));
    });
}
let panelPaintGen = 0;
/** Run the panel's DOM writes once the route line is actually on the map.
 *
 * The line goes through MapLibre's worker (parse, re-tile, render) while the
 * summary is a synchronous DOM write, so putting both in one task painted the
 * numbers a frame or two before the route appeared — planners read the gap as
 * the app having routed somewhere else and then corrected itself. */
function paintPanelWithRoute(paint) {
    const gen = ++panelPaintGen;
    let done = false;
    let renders = 0;
    let parsed = false;
    const fire = () => {
        if (done || gen !== panelPaintGen)
            return;
        done = true;
        map.off("render", onRender);
        map.off("sourcedata", onData);
        window.clearTimeout(soft);
        window.clearTimeout(hard);
        paint();
    };
    const onData = () => {
        if (map.isSourceLoaded("route"))
            parsed = true;
    };
    // "the source is loaded" is not "the line is drawn" — the frame after parsing
    // is the one that draws it. Waiting for rendered geometry is the real signal;
    // a route that lands off-screen has none, so a couple of frames after the
    // data parsed counts as the map having had its chance.
    const onRender = () => {
        renders++;
        if (map.getLayer("route") === undefined)
            return;
        if (map.queryRenderedFeatures(undefined, { layers: ["route"] }).length > 0)
            fire();
        else if (parsed && renders > 2)
            fire();
    };
    map.on("sourcedata", onData);
    map.on("render", onRender);
    // a map that isn't rendering at all (hidden tab, no WebGL) must not hold the
    // numbers hostage; a busy one gets until the hard stop to draw
    const soft = window.setTimeout(() => {
        if (renders === 0)
            fire();
    }, 600);
    const hard = window.setTimeout(fire, 3000);
}
function selectOption(id) {
    // While navigating, guidance follows its own copy of the track. Swapping the
    // drawn route underneath (a mid-ride hazard mark re-plans) would show one
    // line while the voice read another, so keep them in step.
    const wasNavigating = navActive;
    const chosen = options.find((o) => o.id === id);
    if (!chosen)
        return;
    selectedId = id;
    getSource("route").setData(chosen.payload.geojson);
    const altFeatures = options
        .filter((o) => o.id !== id)
        .flatMap((o) => o.payload.geojson.features);
    getSource("alts").setData({
        type: "FeatureCollection",
        features: altFeatures,
    });
    // the permalink is written now, not with the panel: a reload a beat after
    // routing used to lose the trip
    updateHash();
    paintPanelWithRoute(() => {
        renderOptions();
        renderOptionChips();
        showSummary(chosen);
    });
    if (wasNavigating && navActive) {
        // keep the spoken guidance on the line that is actually drawn
        rebuildNavFromSelected();
    }
}
function renderOptions() {
    const box = el("options");
    box.innerHTML = "";
    if (options.length === 0) {
        box.style.display = "none";
        return;
    }
    box.style.display = "block";
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
        // hovering a card previews that route on the map
        card.addEventListener("mouseenter", () => {
            getSource("route").setData(o.payload.geojson);
        });
        card.addEventListener("mouseleave", () => {
            const sel = options.find((x) => x.id === selectedId);
            if (sel)
                getSource("route").setData(sel.payload.geojson);
        });
        box.appendChild(card);
    }
}
// ---------------------------------------------------------------------------
// summary + ribbon + cautions
// ---------------------------------------------------------------------------
function renderRibbon(option) {
    const holder = el("ribbon");
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
    const ey = (v) => 62 - ((v - eMin) / (eMax - eMin)) * 24;
    let x = 0;
    const rects = [];
    const crossings = [];
    const linePts = [];
    for (const seg of ribbon) {
        const wpx = (seg.m / total) * W;
        const fill = seg.walk === true ? "#8aa4b8" : CLASS_COLORS[seg.cls];
        const segLabel = seg.walk === true ? "walk the bike" : CLASS_LABELS[seg.cls];
        rects.push(`<rect x="${x.toFixed(2)}" y="0" width="${Math.max(wpx, 0.4).toFixed(2)}" height="12"` +
            ` fill="${fill}"><title>${segLabel}: ${fmtDist(seg.m)}</title></rect>`);
        if (seg.crossing) {
            crossings.push(`<text x="${x.toFixed(2)}" y="22" font-size="9" fill="#a33">▲<title>busy crossing</title></text>`);
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
            `<text x="0" y="40" font-size="8" fill="#999">${fmtClimb(eMax)}</text>` +
            `<text x="0" y="68" font-size="8" fill="#999">${fmtClimb(eMin)}</text>` +
            `</svg>`;
}
function showSummary(option) {
    const s = option.payload.summary;
    el("summary").style.display = "block";
    el("s-dist").textContent = fmtDist(s.meters);
    el("s-time").textContent =
        `~${s.minutes} min` + ((s.walk_m ?? 0) > 0 ? ` · 🚶 ${fmtDist(s.walk_m ?? 0)}` : "");
    el("s-prot").textContent = `${s.pct_protected}%`;
    el("s-quiet").textContent = `${s.pct_quiet}%`;
    el("s-detour").textContent =
        s.shortest_meters === undefined || (s.detour_pct ?? 0) <= 0
            ? "same"
            : `+${s.detour_pct}% (${fmtDist(s.shortest_meters)})`;
    const bar = el("classbar");
    bar.innerHTML = "";
    for (const [cls, m] of Object.entries(s.by_class_m)) {
        const seg = document.createElement("i");
        seg.style.cssText = `flex:${m};background:${CLASS_COLORS[cls] ?? "#999"}`;
        seg.title = `${CLASS_LABELS[cls] ?? cls}: ${fmtDist(m)}`;
        bar.appendChild(seg);
    }
    renderRibbon(option);
    const cautions = el("cautions");
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
                photo.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    void showMapillaryPreview(lon, lat);
                });
                div.appendChild(photo);
            }
        }
        cautions.appendChild(div);
    }
    const why = el("why");
    const whyList = el("why-list");
    whyList.innerHTML = "";
    const explanation = s.explanation ?? [];
    why.style.display = explanation.length > 0 ? "block" : "none";
    for (const reason of explanation) {
        const li = document.createElement("li");
        li.textContent = reason;
        whyList.appendChild(li);
    }
    // daylight check: warn when the ride would end near or after sunset
    const sunsetBox = el("sunset");
    const arrival = new Date(Date.now() + s.minutes * 60000);
    const sunset = sunsetTime(new Date(), 42.383, -71.105);
    const marginMin = (sunset.getTime() - arrival.getTime()) / 60000;
    if (marginMin < 30) {
        const sunsetLocal = sunset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        sunsetBox.textContent =
            marginMin < 0
                ? `🌅 this ride ends after sunset (${sunsetLocal}) — lights on, and try dark mode`
                : `🌅 sunset at ${sunsetLocal} — you'd arrive with ~${Math.round(marginMin)} min of light`;
        sunsetBox.style.display = "block";
    }
    else {
        sunsetBox.style.display = "none";
    }
}
// ---------------------------------------------------------------------------
// Mapillary street-level photo previews (free client token; CC BY-SA imagery)
// ---------------------------------------------------------------------------
let segPhotoTimer;
async function showMapillaryPreview(lon, lat) {
    try {
        // the same "nearest, and near enough to be here" rule the street card uses;
        // this used to keep its own narrow-box, newest-wins copy
        const newest = await nearestMapillary(lon, lat, mapillaryToken, "id,thumb_1024_url,captured_at,computed_geometry");
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
        }
        else {
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
    }
    catch {
        window.open(`https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=17`, "_blank");
    }
}
// ---------------------------------------------------------------------------
// GPX + cue sheet
// ---------------------------------------------------------------------------
el("gpx").addEventListener("click", () => {
    const sel = options.find((o) => o.id === selectedId);
    if (!sel)
        return;
    const gpx = toGPX(sel.payload, `Family bike route (${sel.label})`);
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "family-bike-route.gpx";
    a.click();
    URL.revokeObjectURL(a.href);
});
el("print-cues").addEventListener("click", () => {
    const sel = options.find((o) => o.id === selectedId);
    if (!sel)
        return;
    const cues = buildCues(sel.payload);
    const s = sel.payload.summary;
    const rows = cues
        .map((c) => `<tr><td>${fmtDist(c.km * 1000)}</td><td>${esc(c.text)}</td></tr>`)
        .join("");
    const cautionRows = cautionsHtml(s.cautions, fmtDist);
    const win = window.open("", "_blank");
    if (!win)
        return;
    win.document.write(`<html><head><title>Cue sheet</title><style>
      body{font-family:sans-serif;font-size:13px;max-width:520px;margin:20px auto}
      table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:3px 6px}
      td:first-child{white-space:nowrap;font-variant-numeric:tabular-nums}
    </style></head><body>
    <h2>Family bike route — ${sel.label}</h2>
    <p>${fmtDist(s.meters)} · ~${s.minutes} min · ${s.pct_protected}% protected · climb ${fmtClimb(s.climb_m ?? 0)}</p>
    ${cautionRows ? `<ul>${cautionRows}</ul>` : ""}
    <table>${rows}</table>
    </body></html>`);
    win.document.close();
    win.print();
});
// ---------------------------------------------------------------------------
// URL hash permalinks: #s=lon,lat&e=lon,lat&m=profile&f=1
// ---------------------------------------------------------------------------
function updateHash() {
    if (!start)
        return;
    const s = start.getLngLat();
    const base = `s=${s.lng.toFixed(6)},${s.lat.toFixed(6)}&m=${profileId}` +
        (preferFlat ? "&f=1" : "") +
        (walkMaxM > 0 ? `&wk=${walkMaxM}` : "") +
        (avoidTypes.size > 0 ? `&x=${[...avoidTypes].join(",")}` : "");
    let h;
    if (loopParams !== null) {
        h = `${base}&l=${loopParams.km},${loopParams.kind}`;
    }
    else if (end) {
        const d = end.getLngLat();
        h =
            `${base}&e=${d.lng.toFixed(6)},${d.lat.toFixed(6)}` +
                (selectedId !== null && selectedId !== "loop" ? `&o=${selectedId}` : "");
    }
    else {
        return;
    }
    history.replaceState(null, "", `#${h}`);
}
function parseHash() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const parse = (v) => {
        if (v === null)
            return null;
        const parts = v.split(",").map(Number);
        const [lng, lat] = parts;
        if (parts.length !== 2 || lng === undefined || lat === undefined)
            return null;
        if (Number.isNaN(lng) || Number.isNaN(lat))
            return null;
        return [lng, lat];
    };
    const m = params.get("m");
    const legacy = { kids: "young_kids", solo: "solo" };
    const mapped = m !== null ? (legacy[m] ?? m) : null;
    if (mapped === "young_kids" || mapped === "older_kids" || mapped === "solo") {
        profileId = mapped;
        const radio = document.querySelector(`input[name=profile][value=${mapped}]`);
        if (radio)
            radio.checked = true;
    }
    if (params.get("f") === "1") {
        preferFlat = true;
        el("prefer-flat").checked = true;
    }
    const wk = params.get("wk");
    if (wk !== null) {
        walkMaxM = wk === "1" ? 500 : Math.max(0, Math.min(2000, Number(wk) || 0));
        el("walk-max").value = String(walkMaxM);
    }
    const x = params.get("x");
    if (x !== null) {
        const valid = new Set(AVOIDABLE.map(([c]) => c));
        avoidTypes = new Set(x.split(",").filter((t) => valid.has(t)));
        for (const [cls] of AVOIDABLE) {
            el(`avoid-${cls}`).checked = avoidTypes.has(cls);
        }
        syncAvoidSummary();
    }
    const o = params.get("o");
    if (o === "safest" || o === "balanced" || o === "direct")
        pendingSelect = o;
    const s = parse(params.get("s"));
    const e = parse(params.get("e"));
    const l = params.get("l");
    if (s && l !== null) {
        // shared loop: restore controls, place the start, and re-plan it
        const [kmRaw, kind] = l.split(",");
        const km = Number(kmRaw);
        if (km > 0 && kind) {
            el("loop-dist").value = String(Math.round(fromMeters(km * 1000) * 10) / 10);
            el("loop-stop").value = kind;
            start = makeMarker(s, "#2b83ba", "start");
            void requestLoop();
            return;
        }
    }
    if (s)
        setPoint("start", s);
    if (e)
        setPoint("end", e);
}
// share: Web Share API on mobile, clipboard elsewhere
el("share").addEventListener("click", () => {
    const url = window.location.href;
    const btn = el("share");
    const flash = (text) => {
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
function recordRecentRoute(s, e) {
    const sel = options.find((o) => o.id === selectedId) ?? options[0];
    if (!sel)
        return;
    const names = sel.payload.geojson.features
        .map((f) => f.properties.name)
        .filter((n) => n !== null && n !== "");
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
function planBetween(s, e) {
    fromCurrent = false;
    syncOD();
    if (start)
        start.setLngLat(s);
    else
        start = makeMarker(s, "#2b83ba", "start");
    if (end)
        end.setLngLat(e);
    else
        end = makeMarker(e, "#d7191c", "end");
    nameEnd("start");
    nameEnd("end");
    void requestRoute();
}
function promptSavePlace(lon, lat) {
    const name = window.prompt("Name this place (e.g. Home, Work, School):");
    if (name === null || name.trim() === "")
        return;
    savePlace({ name: name.trim(), lon, lat });
    renderPlacesAndRecent();
}
function placeRow(place) {
    const row = document.createElement("div");
    row.className = "search-row";
    const label = document.createElement("span");
    label.textContent = `${emojiFor(place.name)} ${place.name}`;
    row.appendChild(label);
    for (const kind of ["start", "end"]) {
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
function recentRow(route) {
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
function renderPlacesAndRecent() {
    const placesBox = el("places-list");
    placesBox.innerHTML = "";
    const places = listPlaces();
    for (const place of places)
        placesBox.appendChild(placeRow(place));
    const recentBox = el("recent-list");
    recentBox.innerHTML = "";
    const recent = listRecent();
    // collapsed by default; the whole section is hidden when there's no history
    el("recent-box").style.display = recent.length > 0 ? "block" : "none";
    if (recent.length > 0) {
        for (const route of recent.slice(0, 5))
            recentBox.appendChild(recentRow(route));
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
/** Everything already on the device that could answer a query.
 *
 * Assembled per keystroke rather than kept in an index: 2,500 POIs and a
 * viewport of streets is a few thousand string comparisons, which is nothing, and
 * an index would have to be invalidated every time a place is saved, a trip is
 * taken, or the map moves.
 */
function localCandidates() {
    const out = [];
    for (const p of listPlaces()) {
        out.push({ name: p.name, lon: p.lon, lat: p.lat, source: "place", kind: "saved place" });
    }
    // where they went, not where they started: the search box asks "where to?"
    const seenRecent = new Set();
    for (const r of listRecent()) {
        const key = `${r.e[0].toFixed(4)},${r.e[1].toFixed(4)}`;
        if (seenRecent.has(key))
            continue;
        seenRecent.add(key);
        // the stored label is "A to B"; the destination is what this row offers
        const label = r.label.includes(" to ") ? (r.label.split(" to ").pop() ?? r.label) : r.label;
        out.push({ name: label, lon: r.e[0], lat: r.e[1], source: "recent", kind: "you rode here" });
    }
    for (const poi of pois) {
        const name = poi.properties.name;
        if (typeof name !== "string" || name === "")
            continue;
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
function streetCandidates(query, origin) {
    const out = [];
    for (const st of netTiles.loadedStreets()) {
        if (matchScore(query, st.name) === 0)
            continue; // name first: cheap, and most fail
        let best = st.coords[0];
        if (best === undefined)
            continue;
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
function searchOrigin() {
    const from = start?.getLngLat();
    if (from)
        return [from.lng, from.lat];
    const c = map.getCenter();
    return [c.lng, c.lat];
}
/** When the geocoder was last asked. The policy itself is in search.ts, where it
 * can be tested as arithmetic rather than through browser timing. */
let lastGeocodeAt = 0;
async function searchAddress(query) {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1" +
        `&viewbox=${BBOX.west},${BBOX.north},${BBOX.east},${BBOX.south}` +
        `&q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok)
        throw new Error(`search failed (${resp.status})`);
    return (await resp.json());
}
/** Moves whenever the rider changes what the router must avoid — a sketchy
 * mark, a filed hazard — so a grade computed before it is never replayed after.
 * Those change where routes go just as surely as a preference does. */
let avoidRevision = 0;
/** The rows currently on screen, so their letters can be withdrawn and redone
 * when the answer they state stops being true. */
let gradedRows = [];
/** The letters on screen describe routes from a particular start under
 * particular settings. When either changes they are answers to a question
 * nobody asked any more, so withdraw them and work them out again. */
function regradeVisible() {
    if (gradedRows.length === 0)
        return;
    // Never mid-ride. The "avoid this street" chip writes through saveSketchy,
    // which lands here, and grading is up to five routing runs on the main thread
    // — a stall in guidance while someone is riding, to refresh a search list
    // that isn't even on screen.
    if (navActive)
        return;
    window.__regradesStarted = (window.__regradesStarted ?? 0) + 1;
    for (const row of gradedRows) {
        if (!row.badge.isConnected)
            return; // the list is gone; nothing to redo
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
function clearGrading(row) {
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
function showGrading(row) {
    row.badge.style.visibility = "";
    row.sub.style.visibility = "";
}
/** Cancels grading when a new search lands: five routes take a moment, and the
 * answers to the last query must not appear against this one's rows. */
let gradeGen = 0;
const gradeCache = new Map();
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
async function gradeSearchResults(rows) {
    const mine = ++gradeGen;
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
        for (const r of rows)
            clearGrading(r);
        return;
    }
    const a = [from.lng, from.lat];
    // Every row gets a letter, and the list is capped to make that affordable.
    //
    // This used to be a cap of five under a list of eight, which left three rows
    // showing no grade for no reason a reader could see. The letter is the whole
    // point of this app's search — a row without one is a destination with no
    // safety claim — so the list length and this cap are the same number, and
    // SEARCH_ROWS is where it is set.
    const MAX_GRADED = SEARCH_ROWS;
    for (const row of rows.slice(MAX_GRADED))
        clearGrading(row);
    for (const row of rows.slice(0, MAX_GRADED)) {
        showGrading(row); // it may have been cleared by an earlier pass
        // hand the page back between routes: five Dijkstras in a row on the main
        // thread is a visible stall on a phone
        await new Promise((r) => setTimeout(r, 0));
        if (mine !== gradeGen)
            return; // a newer search owns the list now
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
                if (mine !== gradeGen)
                    return;
                // routed with the snapshot, so the answer matches the key it is filed
                // under even if the rider changes a preference while this is running
                // by id, not by index: the badge says "safest", and relying on the
                // order routeOptions happens to build its candidates in makes that a
                // safety claim held together by an array position
                const opts = r?.routeOptions(a, row.lngLat, snap.profileId, snap.preferFlat, undefined, new Set(snap.avoid), snap.walkMaxM);
                const best = opts?.find((o) => o.id === "safest") ?? opts?.[0];
                if (!best)
                    throw new Error("no route");
                hit = {
                    grade: best.grade,
                    meters: best.payload.summary.meters,
                    minutes: best.payload.summary.minutes,
                };
                gradeCache.set(key, hit);
            }
            catch {
                // unroutable, or off the edge of the mapped area: say nothing rather
                // than showing a letter we can't stand behind
                if (mine === gradeGen)
                    clearGrading(row);
                continue;
            }
        }
        if (mine !== gradeGen)
            return;
        row.badge.textContent = hit.grade;
        row.badge.style.background = GRADE_COLORS[hit.grade];
        row.badge.title = `Safest route here grades ${hit.grade}`;
        row.badge.setAttribute("aria-label", `safest route grades ${hit.grade}`);
        row.sub.textContent = `${fmtDist(hit.meters)} · ${hit.minutes} min by the safest way`;
    }
}
/** Nominatim's answers as candidates, so one ranking covers every source. */
function geocoderCandidates(results) {
    const out = [];
    for (const r of results) {
        const lon = parseFloat(r.lon);
        const lat = parseFloat(r.lat);
        // a malformed answer becomes NaN, which would reach the router and the
        // cache key as a coordinate
        if (!Number.isFinite(lon) || !Number.isFinite(lat))
            continue;
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
function renderSearchResults(rows, target = "end") {
    const box = el("search-results");
    box.innerHTML = "";
    gradeGen++; // abandon grading for whatever list was here before
    if (rows.length === 0) {
        box.textContent = "no results in this area";
        return;
    }
    const grading = [];
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
        const lngLat = [r.lon, r.lat];
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
        if (usable)
            grading.push({ lngLat, badge, sub });
        else
            clearGrading({ badge, sub });
        // the whole row picks the field you searched from — no aiming at a tiny
        // button, which matters on a phone
        const choose = () => {
            setPoint(target, lngLat);
            const field = el(target === "start" ? "from-field" : "search");
            field.value = short;
            field.classList.remove("picking");
            gradeGen++; // the list is going away; stop routing for it
            if (target === "start")
                activeField = "end";
            syncOD();
            map.flyTo({ center: lngLat, zoom: 15 });
            box.innerHTML = "";
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
    if (target === "end")
        scheduleGrading(grading);
    else
        for (const r of grading)
            clearGrading(r);
}
let gradeTimer;
/** Grade the list once it has stopped changing.
 *
 * The list is now rebuilt on every keystroke, and grading it is up to five routing
 * runs. Typing "playground" therefore queued fifty — each abandoned by the next
 * letter, all of them on the main thread, against a geocoder-rate-limited service
 * that also fetches routing tiles. The rows appear instantly; their letters arrive
 * a moment after the typing stops, which is when they can be read anyway.
 */
function scheduleGrading(rows) {
    window.clearTimeout(gradeTimer);
    gradeTimer = window.setTimeout(() => {
        void gradeSearchResults(rows);
    }, 400);
}
// ---------------------------------------------------------------------------
// safe-shed (reachability)
// ---------------------------------------------------------------------------
async function computeShed() {
    if (!shedCenter)
        return;
    await manifestReady;
    const budgetKm = Number(el("shed-budget").value);
    el("shed-budget-label").textContent = fmtDistTight(budgetKm * 1000);
    // the flood can reach out to the full budget radius from the center
    const r = await ensureRouter([shedCenter], budgetKm * 1000, 2);
    if (!r)
        return;
    const res = r.safeShed(shedCenter, budgetKm * 1000, profileId, preferFlat);
    getSource("shed").setData(res.geojson);
    el("shed-info").textContent =
        `${fmtDist(res.reachableKm * 1000)} of streets reachable ` +
            `(${res.pctReachable}% of the network) within a perceived ${fmtDistTight(budgetKm * 1000)}`;
    if (shedMarker)
        shedMarker.setLngLat(shedCenter);
    else {
        shedMarker = new maplibregl.Marker({ color: "#7c3aed" }).setLngLat(shedCenter).addTo(map);
        shedMarker.getElement().title = "reachability center";
    }
}
function exitShedMode() {
    shedMode = false;
    shedCenter = null;
    shedMarker?.remove();
    shedMarker = null;
    getSource("shed").setData(emptyFC());
    el("shed-panel").style.display = "none";
    el("shed-btn").textContent = "🗺 Reach map";
    el("shed-info").textContent = "";
}
el("shed-btn").addEventListener("click", () => {
    if (shedMode) {
        exitShedMode();
        return;
    }
    shedMode = true;
    el("shed-btn").textContent = "✕ Exit reach map";
    el("shed-panel").style.display = "block";
    el("shed-info").textContent =
        "click the map (e.g. home) to see everything reachable at your comfort level";
});
el("shed-budget").addEventListener("input", () => {
    void computeShed();
});
// ---------------------------------------------------------------------------
// sketchy marks (personal feedback)
// ---------------------------------------------------------------------------
function renderSketchy() {
    const box = el("sketchy-section");
    const list = el("sketchy-list");
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
function whenIdle(fn, timeout = 3000) {
    if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(fn, { timeout });
    }
    else {
        window.setTimeout(fn, 1200);
    }
}
map.on("load", () => {
    // The basemap: Carto's positron and dark-matter, as vector layers, injected
    // once per theme and thereafter toggled by visibility (see basemap.ts and
    // applyBasemap). This replaces four raster layers — light_all, dark_all and
    // the two _nolabels — which Carto now serves with "API KEY REQUIRED" stamped
    // across the image.
    //
    // Label-free is no longer a separate tile set but the same layers with the
    // label ones hidden, which is what ride mode wants: raster tiles rotate as
    // pictures, so with the map turned to the heading the baked-in labels ride
    // upside-down and slide off their own streets. The names come back as a real
    // symbol layer (see "street-labels"), which MapLibre keeps upright at any
    // bearing.
    //
    // Only the theme in use is fetched; applyBasemap asks for the other the
    // first time someone switches. The insert point is resolved after that fetch,
    // by which time everything added below is on the map — so the basemap lands
    // under it rather than over the route.
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
            "line-opacity": ["*", hoverOn, 0.9],
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
            "line-opacity": hoverOn,
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
        map.on("click", layer, (e) => {
            const f = e.features?.[0];
            if (!f)
                return;
            const props = f.properties;
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
            const text = (t) => typeof t === "string" && t.trim() !== "" ? esc(t.trim()) : "";
            const title = text(props.name) || text(props.kind) || "construction";
            const address = text(props.address);
            const detail = text(props.detail);
            new maplibregl.Popup()
                .setLngLat(e.lngLat)
                .setHTML(`🚧 <b>${title}</b><br>${address}` +
                (detail === "" ? "" : `<br>${detail}`) +
                `<br><small>${source} · ${text(props.start) || "?"} → ${text(props.end) || "?"}</small>`)
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
    map.on("click", "hazardpts", (e) => {
        const f = e.features?.[0];
        if (!f)
            return;
        const props = f.properties;
        if (props.id === undefined)
            return;
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
                if (blob)
                    img.src = URL.createObjectURL(blob);
            });
            box.appendChild(img);
        }
        const rm = document.createElement("button");
        rm.textContent = "✕ remove";
        const popup = new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(box).addTo(map);
        rm.addEventListener("click", () => {
            if (props.id === undefined)
                return;
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
    map.addLayer({
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
    }, "network-casing");
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
    const hoverHtml = {
        pois: (p) => {
            const kind = typeof p["kind"] === "string" ? p["kind"] : "";
            const meta = POI_META[kind];
            const name = typeof p["name"] === "string" && p["name"] !== "" ? p["name"] : null;
            return `${meta?.emoji ?? "📍"} <b>${esc(name ?? meta?.label ?? "stop")}</b>` +
                (name ? `<br><small>${meta?.label ?? ""}</small>` : "");
        },
        gateways: () => "🚦 <b>safe crossing</b><br><small>signalized crossing of a busy street</small>",
        hazardpts: (p) => {
            const cat = typeof p["category"] === "string" ? p["category"] : null;
            const note = typeof p["note"] === "string" && p["note"] !== "" ? `<br>${esc(p["note"])}` : "";
            const when = typeof p["t"] === "number"
                ? `<br><small>${new Date(p["t"]).toLocaleDateString()} · click to remove</small>`
                : "";
            // photo placeholder — filled asynchronously from IndexedDB below
            const photo = p["hasPhoto"] === true || p["hasPhoto"] === "true"
                ? `<img data-hazard-photo="${esc(String(p["id"] ?? ""))}" alt=""
               style="max-width:180px;display:block;border-radius:6px;margin-top:4px">`
                : "";
            return `⚠ <b>${cat !== null ? HAZARD_LABELS[cat] : "hazard"}</b>${note}${photo}${when}`;
        },
        "construction-pts": (p) => constructionHtml(p),
        "construction-lines": (p) => constructionHtml(p),
    };
    function constructionHtml(p) {
        const name = typeof p["name"] === "string" && p["name"] !== "" ? p["name"] : "construction";
        const kind = typeof p["kind"] === "string" ? ` · ${esc(p["kind"])}` : "";
        const address = typeof p["address"] === "string" && p["address"] !== "" ? `<br>${esc(p["address"])}` : "";
        const detail = typeof p["detail"] === "string" && p["detail"] !== "" ? `<br>${esc(p["detail"])}` : "";
        const source = p["src"] === "massdot_wzdx" ? "MassDOT work zone" : "Cambridge street permit";
        const dates = typeof p["start"] === "string" && typeof p["end"] === "string"
            ? ` · ${esc(p["start"])} → ${esc(p["end"])}`
            : "";
        return `🚧 <b>${esc(name)}</b>${kind}${address}${detail}<br><small>${source}${dates}</small>`;
    }
    for (const [layer, html] of Object.entries(hoverHtml)) {
        map.on("mousemove", layer, (e) => {
            map.getCanvas().style.cursor = "pointer";
            const f = e.features?.[0];
            if (!f)
                return;
            hoverPopup?.remove();
            hoverPopup = new maplibregl.Popup({
                closeButton: false,
                closeOnClick: false,
                offset: 10,
            })
                .setLngLat(e.lngLat)
                .setHTML(html(f.properties))
                .addTo(map);
            // hazard photos live in IndexedDB — fill the placeholder if present
            const slot = hoverPopup
                .getElement()
                ?.querySelector("img[data-hazard-photo]");
            const photoId = slot?.dataset["hazardPhoto"];
            if (slot && photoId !== undefined && photoId !== "") {
                void getHazardPhoto(photoId).then((blob) => {
                    if (blob && slot.isConnected)
                        slot.src = URL.createObjectURL(blob);
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
    map.on("click", "gateways", (e) => {
        new maplibregl.Popup({ offset: 10 })
            .setLngLat(e.lngLat)
            .setHTML(hoverHtml["gateways"]?.({}) ?? "")
            .addTo(map);
    });
    // hover inspection on the network and the planned route: highlight the
    // segment and show a safety card
    let hoverStateId = null;
    let lastHoverKey = null;
    const clearHoverState = () => {
        if (hoverStateId !== null) {
            map.setFeatureState({ source: "network", id: hoverStateId }, { hover: false });
            hoverStateId = null;
        }
    };
    const setHoverState = (id) => {
        if (id === hoverStateId)
            return;
        clearHoverState();
        if (id !== undefined) {
            map.setFeatureState({ source: "network", id }, { hover: true });
            hoverStateId = id;
        }
    };
    for (const layer of ["network-hit", "route"]) {
        map.on("mousemove", layer, (e) => {
            map.getCanvas().style.cursor = "crosshair";
            const f = e.features?.[0];
            if (!f)
                return;
            // only rebuild when the segment under the cursor actually changes
            const key = `${layer}:${String(f.id)}`;
            if (key === lastHoverKey)
                return;
            lastHoverKey = key;
            if (layer !== "route")
                setHoverState(f.id);
            else
                clearHoverState();
            const props = f.properties;
            const html = segmentHtml(props, { photo: mapillaryToken !== "" }) +
                // "right-click" means nothing on a phone
                `<br><small>${window.matchMedia("(hover: none)").matches
                    ? "press and hold to mark as sketchy"
                    : "right-click to mark as sketchy"}</small>`;
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
        map.on("contextmenu", layer, (e) => {
            e.preventDefault();
            openSketchyPopup([e.lngLat.lng, e.lngLat.lat]);
        });
    }
    map.on("click", "pois", (e) => {
        const f = e.features?.[0];
        if (!f)
            return;
        const props = f.properties;
        const meta = props.kind !== undefined ? POI_META[props.kind] : undefined;
        new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`${meta?.emoji ?? ""} <b>${esc(String(props.name || meta?.label || "?"))}</b>`)
            .addTo(map);
    });
    map.on("mousemove", "lanemap", (e) => {
        const f = e.features?.[0];
        if (!f)
            return;
        const props = f.properties;
        if (props.fac_m === undefined)
            return;
        hoverPopup?.remove();
        hoverPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
            .setLngLat(e.lngLat)
            .setHTML(`🚴 ${fmtDist(Number(props.fac_m) || 0)} of bike facilities in this block` +
            `<br><small>${fmtDist(Number(props.prot_m) || 0)} protected (path/separated)</small>`)
            .addTo(map);
    });
    map.on("mouseleave", "lanemap", () => {
        hoverPopup?.remove();
        hoverPopup = null;
    });
    map.on("mousemove", "elevmap", (e) => {
        const f = e.features?.[0];
        if (!f)
            return;
        const props = f.properties;
        if (props.elev === undefined)
            return;
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
    void dataReady
        .then(() => loadJson("pois.geojson"))
        .then((d) => {
        map.getSource("pois").setData(d);
    })
        .catch(() => undefined)
        .finally(() => dataProgress());
    void networkReady.then(() => refreshNetworkTiles()).finally(() => dataProgress());
    void constructionReady
        .then(() => {
        if (constructionFC) {
            map.getSource("construction").setData(constructionFC);
        }
    })
        .finally(() => dataProgress());
    parseHash();
});
map.on("click", (e) => {
    // A project line is a thing to inspect, not a place to ride to. Without this
    // the layer's own handler selected the project AND this one dropped a
    // destination pin and re-routed underneath it.
    const inspectable = ["build", "crossings"].filter((id) => map.getLayer(id) !== undefined &&
        map.getLayoutProperty(id, "visibility") === "visible");
    if (inspectable.length > 0 &&
        map.queryRenderedFeatures(e.point, { layers: inspectable }).length > 0) {
        return;
    }
    if (shedMode) {
        shedCenter = [e.lngLat.lng, e.lngLat.lat];
        void computeShed();
        return;
    }
    // Mid-ride the map is for looking at, not re-planning: a stray tap on the
    // handlebars used to silently swap the route out from under the rider.
    if (navActive) {
        // A tap that dismisses the open stops menu is that and nothing else — it
        // must not also offer to throw the ride away. MapLibre's preventDefault
        // doesn't stop other listeners, so the guard lives here, where the acting
        // handler is.
        if (el("nav-stops").getAttribute("aria-expanded") === "true") {
            stopsOpen(false);
            return;
        }
        askDuringRide("End this ride and route to the spot you tapped instead?", () => {
            exitNav();
            setPoint("end", e.lngLat);
            syncOD();
            void requestRoute();
        });
        return;
    }
    if (activeField === "start") {
        setPoint("start", e.lngLat);
        activeField = "end";
    }
    else {
        setPoint("end", e.lngLat);
    }
});
/** The one open spot-menu, so a second right-click (or long-press) replaces it
 * instead of stacking a second card on the map. */
let sketchyPopup = null;
// touch devices have no right-click: a long-press on a street opens this same
// "mark sketchy" popup (wired below the definition)
function openSketchyPopup(lngLat) {
    sketchyPopup?.remove();
    sketchyPopup = null;
    // the hover card describes the same street; two cards over one spot is noise
    hoverPopup?.remove();
    hoverPopup = null;
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
        if (sketchyPopup === popup)
            sketchyPopup = null;
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
let pressTimer;
const canvas = map.getCanvas();
canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1)
        return;
    const touch = e.touches[0];
    if (!touch)
        return;
    const rect = canvas.getBoundingClientRect();
    const px = [touch.clientX - rect.left, touch.clientY - rect.top];
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
for (const evt of ["touchend", "touchmove", "touchcancel"]) {
    canvas.addEventListener(evt, () => {
        window.clearTimeout(pressTimer);
    });
}
// draggable bottom-sheet (mobile): peek / half / full snap states
const SHEET_STATES = ["peek", "half", "full"];
function setSheet(state) {
    const panel = el("panel");
    panel.style.maxHeight = "";
    panel.classList.remove("peek", "half", "full");
    panel.classList.add(state);
}
function currentSheet() {
    const panel = el("panel");
    return SHEET_STATES.find((s) => panel.classList.contains(s)) ?? "half";
}
(function initSheet() {
    const panel = el("panel");
    const handle = el("sheet-handle");
    // start collapsed: the map is the point, and a route expands the sheet
    // to "half" on its own (revealSheet)
    if (window.matchMedia("(max-width: 760px), (max-height: 500px)").matches)
        setSheet("peek");
    let dragging = false;
    let startY = 0;
    let startH = 0;
    let moved = 0;
    let liveH = 0;
    handle.addEventListener("pointerdown", (e) => {
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
    handle.addEventListener("pointermove", (e) => {
        if (!dragging)
            return;
        const dy = startY - e.clientY;
        moved = Math.max(moved, Math.abs(dy));
        liveH = Math.min(window.innerHeight * 0.88, Math.max(70, startH + dy));
        panel.classList.remove("peek", "half", "full");
        panel.style.maxHeight = `${liveH}px`;
    });
    const end = () => {
        if (!dragging)
            return;
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
    // some WebViews revoke capture mid-gesture; without this the sheet sticks
    handle.addEventListener("lostpointercapture", end);
})();
/** After a route computes, make sure the sheet is at least half-open (mobile). */
function revealSheet() {
    if (currentSheet() === "peek")
        setSheet("half");
}
el("from-locate").addEventListener("click", () => {
    // back to riding from wherever you are
    start?.remove();
    start = null;
    fromCurrent = true;
    activeField = "end";
    const f = el("from-field");
    f.classList.remove("picking");
    f.value = "";
    el("search-results").innerHTML = "";
    syncOD();
    void requestRoute();
});
el("from-pick").addEventListener("click", () => {
    // the next map tap sets the start
    activeField = "start";
    const f = el("from-field");
    f.classList.add("picking");
    f.value = "";
    f.placeholder = "tap the map to set the start…";
});
el("backup-save").addEventListener("click", () => {
    const backup = exportBackup(new Date().toISOString());
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `family-bike-router-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    const places = listPlaces().length;
    el("backup-note").textContent =
        `Backed up ${places} saved place${places === 1 ? "" : "s"} and your marks.`;
});
el("backup-load").addEventListener("click", () => {
    el("backup-file").click();
});
el("backup-file").addEventListener("change", () => {
    const file = el("backup-file").files?.[0];
    if (!file)
        return;
    void file
        .text()
        .then((text) => {
        const n = importBackup(JSON.parse(text));
        renderPlacesAndRecent();
        sketchyMarks = loadSketchy();
        applyAvoidPoints();
        renderSketchy();
        el("backup-note").textContent =
            `Restored ${n} item${n === 1 ? "" : "s"} — ${listPlaces().length} saved places.`;
    })
        .catch((err) => {
        el("backup-note").textContent =
            `Couldn't restore that file: ${err instanceof Error ? err.message : String(err)}`;
    });
    el("backup-file").value = "";
});
el("reset").addEventListener("click", () => {
    start?.remove();
    end?.remove();
    poiMarker?.remove();
    start = end = poiMarker = null;
    clearOptionChips();
    fromCurrent = true;
    activeField = "end";
    el("from-field").classList.remove("picking");
    el("from-field").value = "";
    el("search-results").innerHTML = "";
    syncOD();
    options = [];
    selectedId = null;
    renderOptions();
    getSource("route").setData(emptyFC());
    getSource("alts").setData(emptyFC());
    el("summary").style.display = "none";
    el("error").style.display = "none";
    history.replaceState(null, "", "#");
});
el("swap").addEventListener("click", () => {
    if (!start || !end)
        return;
    const s = start.getLngLat();
    start.setLngLat(end.getLngLat());
    end.setLngLat(s);
    // the names swap with the pins, or the fields describe the trip backwards
    const from = el("from-field");
    const to = el("search");
    [from.value, to.value] = [to.value, from.value];
    [autoNamed.start, autoNamed.end] = [autoNamed.end, autoNamed.start];
    fromCurrent = false;
    syncOD();
    void requestRoute();
});
el("loop-btn").addEventListener("click", () => {
    void requestLoop();
});
/** Show/hide the coloured safety network. Driven by the panel checkbox and —
 * because the panel is hidden while navigating — by the nav-mode button too,
 * so both stay in sync from either place. */
function setNetworkVisible(on) {
    el("show-net").checked = on;
    for (const layer of ["network", "network-unconfirmed"]) {
        map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    }
    applyBasemap(); // casing + line widths key off the same flag
    const btn = el("nav-net");
    btn.classList.toggle("active", on);
    btn.title = on ? "Hide the safety-network overlay" : "Show the safety-network overlay";
    // refresh on re-show: tile loading is skipped while the layer is hidden
    if (on)
        void refreshNetworkTiles();
}
el("show-net").addEventListener("change", (e) => {
    setNetworkVisible(e.target.checked);
});
el("nav-net").addEventListener("click", () => {
    setNetworkVisible(!el("show-net").checked);
});
for (const [checkboxId, layers] of [
    ["show-pois", ["pois"]],
    ["show-gates", ["gateways"]],
]) {
    el(checkboxId).addEventListener("change", (e) => {
        const checked = e.target.checked;
        for (const layer of layers) {
            if (checked)
                ensureLayer(layer);
            map.setLayoutProperty(layer, "visibility", checked ? "visible" : "none");
        }
    });
}
el("prefer-flat").addEventListener("change", (e) => {
    preferFlat = e.target.checked;
    void requestRoute();
    void computeShed();
    regradeVisible();
});
el("walk-max").addEventListener("change", (e) => {
    walkMaxM = Number(e.target.value);
    localStorage.setItem("walkMaxM", String(walkMaxM));
    void requestRoute();
    regradeVisible();
});
// restore the persisted walking budget
walkMaxM = Number(localStorage.getItem("walkMaxM") ?? "0") || 0;
el("walk-max").value = String(walkMaxM);
for (const [cls] of AVOIDABLE) {
    const box = el(`avoid-${cls}`);
    box.checked = avoidTypes.has(cls);
    box.addEventListener("change", () => {
        if (box.checked)
            avoidTypes.add(cls);
        else
            avoidTypes.delete(cls);
        localStorage.setItem("avoidTypes", JSON.stringify([...avoidTypes]));
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
const AREA_OVERLAYS = [
    ["show-heat", "heatmap"],
    ["show-elev", "elevmap"],
    ["show-lanes", "lanemap"],
];
function syncOverlays() {
    const threeD = el("show-3d").checked;
    const vis = (on) => (on ? "visible" : "none");
    for (const [checkbox, layer] of AREA_OVERLAYS) {
        const on = el(checkbox).checked;
        map.setLayoutProperty(layer, "visibility", vis(on && !threeD));
        map.setLayoutProperty(`${layer}-3d`, "visibility", vis(on && threeD));
    }
}
for (const [checkbox, layer] of AREA_OVERLAYS) {
    el(checkbox).addEventListener("change", (e) => {
        if (e.target.checked) {
            ensureLayer(layer);
            for (const [other] of AREA_OVERLAYS) {
                if (other !== checkbox)
                    el(other).checked = false;
            }
        }
        syncOverlays();
    });
}
// honor any overlay left enabled by default markup / a restored session
for (const [checkbox, layer] of AREA_OVERLAYS) {
    if (el(checkbox).checked)
        ensureLayer(layer);
}
if (el("show-gates").checked)
    ensureLayer("gateways");
el("show-3d").addEventListener("change", (e) => {
    const on = e.target.checked;
    if (on) {
        map.setTerrain({ source: "dem", exaggeration: 1.3 });
        map.easeTo({ pitch: 60, duration: 800 });
    }
    else {
        map.setTerrain(null);
        map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
    syncOverlays();
});
for (const radio of document.querySelectorAll("input[name=profile]")) {
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
let searchOwner = null;
function attachSearch(input, target) {
    let timer;
    // The geocoder's last answer for the query still in the box, so a keystroke
    // can re-rank without asking again — and so local and remote results appear in
    // one list rather than the local ones being replaced when the network answers.
    let remote = { query: "", rows: [] };
    /** The row the arrow keys are on, by identity rather than by position. */
    let activeKey = null;
    const rowsNow = () => [
        ...el("search-results").querySelectorAll(".search-row"),
    ];
    const highlight = (key) => {
        activeKey = key;
        for (const row of rowsNow()) {
            row.classList.toggle("active", key !== null && row.dataset["key"] === key);
        }
    };
    const show = (q) => {
        if (searchOwner !== input)
            return; // the other field owns the list now
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
    input.addEventListener("input", () => {
        window.clearTimeout(timer);
        searchOwner = input;
        const q = input.value.trim();
        if (q === "") {
            el("search-results").innerHTML = "";
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
        const localHits = el("search-results").querySelectorAll(".search-row").length;
        if (!worthGeocoding(q, localHits))
            return;
        timer = window.setTimeout(() => {
            const wait = geocodeDelayMs(Date.now(), lastGeocodeAt);
            if (wait > 0) {
                // too soon: ask again once the floor has passed, rather than dropping the
                // query or hammering the service
                timer = window.setTimeout(() => {
                    if (input.value.trim() === q)
                        input.dispatchEvent(new Event("input"));
                }, wait);
                return;
            }
            lastGeocodeAt = Date.now();
            searchAddress(q)
                .then((results) => {
                if (input.value.trim() !== q)
                    return; // a later keystroke moved on
                if (searchOwner !== input)
                    return; // and the other field owns the list
                remote = { query: q, rows: geocoderCandidates(results) };
                // Not while a row is chosen. Re-ranking under a committed selection is
                // how someone ends up riding to a place they did not pick; the answers
                // are kept and merge into the next keystroke's list instead.
                //
                // Deliberately redundant with the highlight restore in show(): either
                // alone keeps the selection, and a test can only kill both together.
                // This one avoids the churn; that one covers re-renders from any other
                // cause, which is where the bug came from in the first place.
                if (activeKey !== null)
                    return;
                show(q);
            })
                .catch(() => {
                // The local list is still on screen and still useful, so this is a
                // footnote rather than an error state — the old code replaced
                // everything with "search unavailable". And only for the query and the
                // field it was asked for: a slow failure used to be able to write over a
                // list the reader had since moved on from.
                if (input.value.trim() !== q || searchOwner !== input)
                    return;
                const box = el("search-results");
                if (box.querySelector(".search-row") === null) {
                    box.textContent = "search unavailable";
                }
            });
        }, GEOCODE_DEBOUNCE_MS);
    });
    // Arrow keys and Enter, because a list you can only reach with a mouse is a
    // list you cannot use one-handed.
    input.addEventListener("keydown", (e) => {
        const rows = rowsNow();
        if (rows.length === 0)
            return;
        const current = rows.findIndex((r) => r.classList.contains("active"));
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const next = e.key === "ArrowDown" ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0);
            const chosen = rows[next === -1 ? 0 : next];
            highlight(chosen?.dataset["key"] ?? null);
            chosen?.scrollIntoView({ block: "nearest" });
        }
        else if (e.key === "Enter") {
            e.preventDefault();
            // Enter with nothing highlighted takes the first row, which is what the
            // ranking is for: the best answer should need no aiming at all.
            const chosen = rows[current === -1 ? 0 : current];
            chosen?.querySelector(".search-text")?.click();
        }
        else if (e.key === "Escape" && activeKey !== null) {
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
attachSearch(el("search"), "end");
attachSearch(el("from-field"), "start");
// once you type over a name we filled in, it's yours and we leave it alone
for (const [kind, id] of [
    ["start", "from-field"],
    ["end", "search"],
]) {
    el(id).addEventListener("input", () => {
        autoNamed[kind] = false;
    });
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (el("about").open ||
            el("rides").open ||
            el("hazard").open) {
            return; // dialogs handle it
        }
        if (shedMode)
            exitShedMode();
        // never wipe the trip out from under an active ride: reset() cleared the
        // route, markers and permalink while navigation kept talking, leaving the
        // rider following a voice over a blank map with no way to recover it
        else if (!navActive)
            el("reset").click();
    }
});
// legend
const legend = el("legend");
for (const [cls, label] of Object.entries(CLASS_LABELS)) {
    if (cls === "service")
        continue; // same color as quiet_street
    const sw = document.createElement("i");
    sw.style.background = CLASS_COLORS[cls];
    legend.appendChild(sw);
    const span = document.createElement("span");
    span.textContent = label;
    legend.appendChild(span);
}
function fillAbout() {
    const multTable = el("mult-table");
    if (multTable.rows.length > 0)
        return; // already filled
    const yk = PROFILES.young_kids;
    const rows = Object.entries(yk.mult)
        .sort((a, b) => a[1] - b[1])
        .map(([cls, m]) => `<tr><td><i style="display:inline-block;width:12px;height:5px;border-radius:2px;` +
        `background:${CLASS_COLORS[cls]}"></i> ${CLASS_LABELS[cls]}</td>` +
        `<td>×${m}</td></tr>`);
    rows.push(`<tr><td>painted lane on a busy road</td><td>×${yk.busyLane}</td></tr>`, `<tr><td>buffered lane on a busy road</td><td>×${yk.busyBuffered}</td></tr>`);
    multTable.innerHTML = `<tr><th>street type</th><th>cost</th></tr>${rows.join("")}`;
    void dataReady
        .then(() => loadJson("meta.json"))
        .then((meta) => {
        if (!meta)
            return;
        const remote = usingRemoteData();
        el("built-date").textContent =
            meta.built + (remote !== null ? " (live from the website)" : "");
        const table = el("freshness-table");
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
async function refreshHazards() {
    try {
        hazards = await listHazards();
    }
    catch {
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
        src.setData({
            type: "FeatureCollection",
            features,
        });
    }
}
function openHazardDialog(lon, lat) {
    hazardPendingLoc = [lon, lat];
    hazardPhoto = null;
    el("hazard-category").value = "surface";
    el("hazard-note").value = "";
    el("hazard-photo").value = "";
    const preview = el("hazard-preview");
    preview.style.display = "none";
    preview.src = "";
    el("hazard-loc").textContent =
        `${hereLabel(lon, lat)} — saved reports appear on the map and routes avoid them`;
    el("hazard").showModal();
}
function pendingHazardReport() {
    if (!hazardPendingLoc)
        return null;
    return {
        id: `${Date.now()}`,
        t: Date.now(),
        lon: hazardPendingLoc[0],
        lat: hazardPendingLoc[1],
        category: el("hazard-category").value,
        note: el("hazard-note").value,
        hasPhoto: hazardPhoto !== null,
    };
}
el("hazard-photo").addEventListener("change", () => {
    const file = el("hazard-photo").files?.[0] ?? null;
    hazardPhoto = file;
    const preview = el("hazard-preview");
    if (file) {
        preview.src = URL.createObjectURL(file);
        preview.style.display = "block";
    }
    else {
        preview.style.display = "none";
    }
});
el("hazard-save").addEventListener("click", () => {
    const report = pendingHazardReport();
    if (!report)
        return;
    void (async () => {
        const photo = hazardPhoto ? await downscalePhoto(hazardPhoto) : null;
        await addHazard(report, photo);
        await refreshHazards();
        el("hazard").close();
        speak("hazard saved. routes will avoid it.");
        void requestRoute();
    })().catch(() => {
        el("hazard-loc").textContent = "could not save (storage unavailable)";
    });
});
// Share used to build a message and never save the report, leaving the dialog
// open with no feedback — so a rider who tapped it kept nothing.
el("hazard-share").addEventListener("click", () => {
    el("hazard-save").click();
    const report = pendingHazardReport();
    if (!report)
        return;
    const text = buildReportText(report);
    const files = hazardPhoto !== null
        ? [new File([hazardPhoto], "hazard.jpg", { type: hazardPhoto.type || "image/jpeg" })]
        : [];
    const payload = files.length > 0 ? { text, files } : { text };
    if (typeof navigator.canShare === "function" && navigator.canShare(payload)) {
        void navigator.share(payload).catch(() => undefined);
    }
    else {
        window.location.href = `mailto:?subject=${encodeURIComponent("Bike hazard report")}&body=${encodeURIComponent(text)}`;
    }
});
el("hazard-close").addEventListener("click", () => {
    el("hazard").close();
});
// ── reporting a hazard mid-ride: file first, ask after ────────────────────
// The dialog (category, note, photo) is still how you report from the planning
// map, where you can read and type. Riding, it was three taps and a form at
// 12 km/h, so nobody used it.
let classifyId = null;
let classifyTimer;
function hideClassify() {
    window.clearTimeout(classifyTimer);
    classifyId = null;
    el("nav-classify").style.display = "none";
}
async function quickReport() {
    if (!navActive) {
        if (navLastPos)
            openHazardDialog(navLastPos[0], navLastPos[1]);
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
            await addHazard({ id, t: Date.now(), lon: at[0], lat: at[1], category: "other", note: "", hasPhoto: false }, null);
            await refreshHazards();
        }
        catch {
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
    el("nav-classify").style.display = "flex";
    window.clearTimeout(classifyTimer);
    // long enough to answer at the next light, short enough to stop nagging
    classifyTimer = window.setTimeout(hideClassify, 20000);
}
el("nav-report").addEventListener("click", () => {
    void quickReport();
});
for (const btn of document.querySelectorAll("#nav-classify button")) {
    btn.addEventListener("click", () => {
        const cat = btn.dataset["cat"];
        const id = classifyId;
        hideClassify();
        if (cat === undefined || id === null)
            return;
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
function showRideOnMap(ride) {
    getSource("history").setData({
        type: "Feature",
        geometry: { type: "LineString", coordinates: ride.polyline },
        properties: {},
    });
    const lons = ride.polyline.map((p) => p[0]);
    const lats = ride.polyline.map((p) => p[1]);
    if (lons.length > 1) {
        map.fitBounds([
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
        ], { padding: 60, duration: 800 });
    }
}
/** Share text + a rendered PNG card via the native share sheet; falls back to
 * downloading the image and copying the text. */
function shareContent(text, imagePromise, filename) {
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
        }
        else {
            void navigator.clipboard.writeText(text).catch(() => undefined);
        }
    });
}
function renderRides() {
    const rides = loadRides();
    const totals = rideTotals(rides, new Date());
    el("ride-totals").innerHTML =
        rides.length === 0
            ? "No rides yet — rides are saved automatically when you Navigate, or use ● Record."
            : `<b>${totals.count}</b> rides · <b>${fmtDist(totals.km * 1000)}</b> total · ` +
                `<b>${totals.movingHours} h</b> moving · longest <b>${fmtDist(totals.longestKm * 1000)}</b> · ` +
                `this month <b>${fmtDist(totals.thisMonthKm * 1000)}</b> · avg <b>${totals.avgProtectedPct}%</b> protected`;
    el("rides-share").style.display = rides.length === 0 ? "none" : "inline-block";
    const table = el("ride-list");
    table.innerHTML =
        rides.length === 0
            ? ""
            : `<tr><th>date</th><th>${unitName() === "miles" ? "mi" : "km"}</th><th>moving</th>` +
                `<th>avg</th><th>protected</th><th></th></tr>`;
    for (const ride of rides) {
        const tr = table.insertRow();
        const d = new Date(ride.startedAt);
        tr.insertCell().textContent = d.toLocaleDateString([], { month: "short", day: "numeric" });
        tr.insertCell().textContent = (ride.meters / 1000).toFixed(1);
        tr.insertCell().textContent = `${Math.round(ride.movingS / 60)} min`;
        tr.insertCell().textContent =
            ride.movingS > 0 ? fmtSpeed(ride.meters / ride.movingS) : "–";
        tr.insertCell().textContent = `${ride.pctProtected}% + ${ride.pctQuiet}% quiet`;
        const actions = tr.insertCell();
        const show = document.createElement("button");
        show.textContent = "map";
        show.addEventListener("click", () => {
            showRideOnMap(ride);
            el("rides").close();
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
el("rides-btn").addEventListener("click", () => {
    renderRides();
    el("rides").showModal();
});
el("rides-close").addEventListener("click", () => {
    el("rides").close();
});
el("rides-share").addEventListener("click", () => {
    const totals = rideTotals(loadRides(), new Date());
    shareContent(totalsShareText(totals), drawTotalsCard(totals), "bike-stats.png");
});
el("rides-clear").addEventListener("click", () => {
    clearRides();
    getSource("history").setData(emptyFC());
    renderRides();
});
el("rides").addEventListener("click", (e) => {
    if (e.target === el("rides"))
        el("rides").close();
});
// tap-outside is the reflex on a phone; #hazard was the one dialog ignoring it
el("hazard").addEventListener("click", (e) => {
    if (e.target === el("hazard"))
        el("hazard").close();
});
el("mapillary-save").addEventListener("click", () => {
    const token = el("mapillary-token").value.trim();
    mapillaryToken = token;
    if (token === "")
        localStorage.removeItem("mapillaryToken");
    else
        localStorage.setItem("mapillaryToken", token);
    clearPhotoCache(); // the shared lookup holds misses fetched with the old token
    el("mapillary-status").textContent =
        token === "" ? "cleared" : "✓ saved — hover any street";
});
function openAbout() {
    el("mapillary-token").value = mapillaryToken;
    fillAbout();
    el("about").showModal();
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
const BUILD_VERSION = "__BUILD_VERSION__";
const BUILD_TIME = "__BUILD_TIME__";
const BUILD_COMMIT = "__BUILD_COMMIT__";
/** This build, or null when the placeholders were never substituted — which
 * means the source is being served directly rather than from an assembled
 * bundle or a deploy. */
function thisBuild() {
    if (BUILD_COMMIT.startsWith("__BUILD"))
        return null;
    return { version: BUILD_VERSION, built: BUILD_TIME, commit: BUILD_COMMIT };
}
function whenBuilt(iso) {
    if (iso === undefined || iso === "")
        return "an unrecorded time";
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
async function showBuildStamp() {
    const line = el("build-stamp");
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
        if (!resp.ok)
            return;
        const live = (await resp.json());
        if (live.commit === undefined || live.commit === mine.commit)
            return;
        const note = document.createElement("span");
        note.className = "stale-build";
        note.textContent =
            ` The site has a newer build (${whenBuilt(live.built)} · ${live.commit}) — ` +
                "this page is a cached copy. Reload to pick it up.";
        line.appendChild(note);
    }
    catch {
        // offline, or the file isn't there: what this build is remains true
    }
}
// two ways in: the labelled button in the footer, which says what's inside, and
// the ℹ in the header, which is reachable without scrolling the panel
for (const id of ["about-btn", "about-top"]) {
    el(id).addEventListener("click", () => {
        openAbout();
        // re-checked on every open: a page left sitting for a day is exactly the one
        // whose reader wants to know whether it is still the current build
        void showBuildStamp();
    });
}
el("about-close").addEventListener("click", () => {
    el("about").close();
});
el("about").addEventListener("click", (e) => {
    if (e.target === el("about"))
        el("about").close();
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
const REROUTE_COOLDOWN_MS = 10000;
// Turn calls are timed, not fixed-distance: 90 m is 40 s of warning at a kid's
// pace but only 13 s on a fast descent. Announce N seconds out, clamped so the
// call is never absurdly early or too late to act on.
const ANNOUNCE_FAR_S = 25;
const ANNOUNCE_NEAR_S = 10;
const ANNOUNCE_NOW_S = 4;
const ANNOUNCE_FAR_CLAMP = [60, 200];
const ANNOUNCE_NEAR_CLAMP = [30, 80];
const ANNOUNCE_NOW_CLAMP = [12, 30];
/** Chain the following turn into the call when it lands right after. */
const THEN_CHAIN_M = 45;
/** Snap the dot to the route while within this of it (beyond = show real GPS,
 * so being genuinely off-route is visible rather than hidden). */
const SNAP_DISPLAY_M = 25;
/** Follow-camera zooms: cruising, and tightened near a maneuver. */
// Both land in the same raster-tile zoom bucket on purpose: cruising at 16.4
// fetched z16 tiles and every one of ~150 turns then fetched a fresh z17 set
// and back again, which measured out at roughly 120 MB of basemap over a 42 km
// ride. Staying inside one bucket removes that churn.
const NAV_ZOOM_CRUISE = 16.6;
const NAV_ZOOM_TURN = 17.3;
const NAV_ZOOM_TURN_M = 90;
const NAV_PITCH = 50;
/** After the rider stops touching the map, the camera takes itself back —
 * otherwise one bump on the handlebars leaves the ride permanently off-centre
 * and you have to keep hunting for the recenter button. */
const REFOLLOW_MS = 10000;
/** A single fix this far from the last one is a re-acquisition artefact, not a
 * bicycle. Accepting one near the destination used to latch "arrived!" — voice
 * and banner dead for the rest of the ride. Several in a row are believed (the
 * rider really did move, e.g. after a signal gap). */
const MAX_FIX_JUMP_M = 500;
const IMPLAUSIBLE_FIXES_BEFORE_TRUSTED = 3;
/** Past this far from the end, we are plainly not at the destination any more,
 * so a stale arrival state must clear (also covers starting a new ride while
 * still standing at the old destination). */
const ARRIVAL_CLEAR_M = 80;
let navActive = false;
let navWatchId = null;
let navTrack = null;
let navManeuvers = [];
let navNext = 0;
/** 0 = nothing announced for navNext, 1 = "in X m" said, 2 = "now" said */
let navAnnounceStage = 0;
let navHint = -1;
let navMuted = false;
let navFollowing = true;
let navDest = null;
let navOffCount = 0;
let navDot = null;
let navArrived = false;
let wakeLock = null;
let navAlerts = [];
let navAlertNext = 0;
let navLastPos = null;
/** Set while detouring to a kid stop: where the ride was originally headed. */
let navOriginalDest = null;
let navNextKm = 1;
let navHalfway = false;
let navLastRerouteAt = 0;
/** "go with my street choice": reroutes respect the rider's direction. */
let navMyWay = localStorage.getItem("navMyWay") === "1";
let navPrevPos = null;
let navHeading = null;
// --- smooth motion (the "feels like Google Maps" layer) -------------------
// GPS fixes land ~1/s. Rather than teleporting the dot and firing a competing
// easeTo per fix, every fix sets a TARGET and one rAF loop eases the dot and
// camera toward it continuously.
let navRaf = null;
/** Where the dot is drawn right now, and where it's heading. */
let navPosShown = null;
let navPosTarget = null;
let navBearingShown = 0;
let navBearingTarget = 0;
let navZoomTarget = NAV_ZOOM_CRUISE;
/** Rider's own zoom wins until they hit recenter — no yanking back mid-glance. */
let navUserZoom = false;
/** True mid-gesture: the follow camera keeps its hands off so it can't cut
 * the rider's own pinch/scroll inertia short. */
let navInteracting = false;
let navRefollowTimer;
let navImplausibleFixes = 0;
/** Smoothed pace actually being ridden, held through stops. */
let navPaceKmh = null;
/** Consecutive reroute attempts, for backing off between them. */
let navRerouteTries = 0;
/** Wall clock of the last spoken reroute, so one wrong turn says it once. */
let navRerouteSpokenAt = 0;
/** A persistent wrong turn is mentioned occasionally, not nagged: the riders'
 * logs had "rerouting." nine times in one deviation, with the ETA strobing
 * between the routed and straight-line estimates. */
const REROUTE_ANNOUNCE_MIN_MS = 45000;
/** Persist the in-progress ride every N fixes (cheap; finish() only reads). */
const STASH_EVERY_FIXES = 20;
let navFixesSinceStash = 0;
/** Smoothed speed (m/s) used to time the turn calls. */
let navSpeed = 0;
let navLastFixAt = 0;
let recorder = null;
/** Background (native) watcher id — used instead of a web watch in the app. */
let navBgWatcherId = null;
function finishAndSaveRide() {
    const ride = recorder?.finish(profileId);
    recorder = null;
    stashInProgress(null);
    if (!ride)
        return;
    saveRide(ride);
    speak(`ride saved. ${(ride.meters / 1000).toFixed(1)} kilometers.`, "chat");
}
function vibrate(pattern) {
    if ("vibrate" in navigator)
        navigator.vibrate(pattern);
}
const PRIORITY_RANK = { safety: 3, turn: 2, chat: 1 };
/** Roughly how long a spoken line takes, to space the queue out. */
const SPEECH_MS_PER_CHAR = 62;
const SPEECH_MIN_MS = 900;
let speechQueue = [];
let speaking = false;
function speechDuration(text) {
    return Math.max(SPEECH_MIN_MS, text.length * SPEECH_MS_PER_CHAR);
}
function drainSpeech() {
    if (speaking)
        return;
    const next = speechQueue.shift();
    if (!next)
        return;
    speaking = true;
    const done = () => {
        speaking = false;
        drainSpeech();
    };
    void nativeSpeak(next.text)
        .then((spokenNatively) => {
        if (spokenNatively) {
            window.setTimeout(done, speechDuration(next.text));
            return;
        }
        // typed as always-present, but a WebView can leave it undefined
        const synth = window.speechSynthesis;
        if (!synth) {
            noteVoiceUnavailable();
            window.setTimeout(done, 0);
            return;
        }
        const utter = new SpeechSynthesisUtterance(next.text);
        let ended = false;
        const finish = () => {
            ended = true;
            done();
        };
        utter.rate = 1.05;
        utter.onend = finish;
        utter.onerror = finish;
        synth.speak(utter);
        // The WebView's speechSynthesis exists on Android but ships no voices:
        // speak() returns without a sound, without an error, and without ever
        // firing onend. Ask whether anything is actually being said rather than
        // counting voices, which browsers report late on a cold start.
        window.setTimeout(() => {
            if (!ended && synth.speaking !== true)
                noteVoiceUnavailable();
        }, 400);
        // belt and braces: some engines never fire onend
        window.setTimeout(() => {
            if (speaking)
                finish();
        }, speechDuration(next.text) + 1500);
    })
        .catch(done);
}
/** Say a line and report which engine actually said it.
 *
 * "I can't hear it" has several causes that look identical from the saddle —
 * no engine installed, media volume down, audio on a Bluetooth device in a
 * pannier — and none of them announce themselves. This turns the question into
 * an answer before the ride rather than after it. */
async function runVoiceTest() {
    const box = el("voice-status");
    const line = "Voice test. In 200 meters, turn left onto the path.";
    box.textContent = "testing…";
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
    box.textContent = isNativeApp()
        ? `▶ spoken by the browser engine (${voices} voices), but the app's own ` +
            `engine failed${err !== null ? `: ${err}` : ""} — that's the one that ` +
            "works with the screen off, so turns would go quiet in your pocket."
        : `▶ spoken by the browser (${voices} voices). In the phone app a native ` +
            "engine is used instead, so it keeps talking with the screen off.";
}
el("voice-test").addEventListener("click", () => {
    void runVoiceTest();
});
/** Told the rider once this ride that there is no voice. */
let voiceWarned = false;
function noteVoiceUnavailable() {
    if (voiceWarned)
        return;
    voiceWarned = true;
    const why = lastNativeSpeechError();
    console.warn("voice unavailable", why ?? "no voices");
    if (!navActive)
        return;
    // silence is the worst failure a spoken guide can have: a rider who thinks
    // the voice is coming stops watching the screen
    showRideAlert("🔇 no voice on this phone — watch the screen for turns", "gps");
    window.setTimeout(hideRideAlert, 8000);
}
function speak(text, priority = "turn") {
    if (navMuted)
        return;
    // drop encouragement when there's real guidance waiting, and never let a
    // lower-priority line delay a safety call
    if (priority === "chat" && speechQueue.length > 0)
        return;
    if (speechQueue.some((u) => u.text === text))
        return;
    speechQueue.push({ text, priority });
    speechQueue = speechQueue
        .map((u, i) => ({ u, i }))
        .sort((a, b) => PRIORITY_RANK[b.u.priority] - PRIORITY_RANK[a.u.priority] || a.i - b.i)
        .map(({ u }) => u);
    drainSpeech();
}
/** Abandon anything queued (ride over, or muted). */
function clearSpeech() {
    speechQueue = [];
    speaking = false;
    if ("speechSynthesis" in window)
        window.speechSynthesis.cancel();
}
function rebuildNavFromSelected() {
    const sel = options.find((o) => o.id === selectedId);
    if (!sel)
        return false;
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
/** Distance / ETA line. `straight` marks an off-route estimate (as the crow
 * flies) so the number is honest rather than frozen at its last on-route value. */
function navUpdateTrip(remainingM, straight = false) {
    // ETA off measured pace when we have it, profile pace before then
    // Hold the last measured pace through a stop. Flipping to the profile's pace
    // whenever navSpeed dropped below 1 m/s swung the arrival time by ~6 minutes
    // at every red light, which is useless if you're asking "do we make the 3
    // o'clock thing?".
    if (navSpeed > 1.0) {
        const measured = (navSpeed * 3600) / 1000;
        navPaceKmh = navPaceKmh === null ? measured : navPaceKmh * 0.7 + measured * 0.3;
    }
    const kmh = navPaceKmh ?? PROFILES[profileId].paceKmh;
    const mins = Math.round((remainingM / 1000 / kmh) * 60);
    const eta = new Date(Date.now() + mins * 60000);
    const clock = eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    // "arrive" spelled out pushed this past the banner width, so it wrapped with
    // "PM" alone on a second line and the banner's height twitched all ride
    el("nav-remaining").textContent =
        `${straight ? "~" : ""}${fmtDist(remainingM)} · ${mins} min · eta ${clock}`;
    el("nav-speed").textContent =
        navSpeed > 0.8 ? `${((navSpeed * 3600) / 1000).toFixed(0)} km/h` : "";
}
function navUpdateBanner(distToNext, remainingM) {
    // Once arrived, leave the arrival message up: the next fix a second later
    // used to overwrite it with the last turn instruction, so the rider never
    // actually saw that they'd got there. (Cleared on reroute/resume, which
    // resets navArrived.)
    if (navArrived)
        return;
    const m = navManeuvers[navNext];
    el("nav-icon").textContent = m?.icon ?? "⬆";
    el("nav-dist").textContent = navDistText(distToNext);
    el("nav-street").textContent = m?.text ?? "";
    navUpdateTrip(remainingM);
}
function toFix(pos) {
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
function onLocationError(err) {
    const denied = err.code === 1;
    showRideAlert(denied ? "⚠ location permission denied" : "⚠ GPS signal lost", "gps");
    if (!denied) {
        const now = Date.now();
        if (now - gpsLostSpokenAt > 20000) {
            gpsLostSpokenAt = now;
            speak("lost g p s signal. keep following the road.", "safety");
        }
    }
}
function navOnPosition(pos) {
    navOnFix(toFix(pos));
}
/** A warning the rider can SEE. The spoken version is the primary channel, but
 * it is useless muted or over kids' chatter, and a safety app must not depend on
 * audio alone. Cleared automatically once it's behind us. */
let navAlertUntilM = 0;
function showRideAlert(text, kind = "hazard") {
    if (kind === "hazard")
        window.__navAlertsSeen = (window.__navAlertsSeen ?? 0) + 1;
    const box = el("nav-alert");
    box.textContent = text;
    box.classList.toggle("gps", kind === "gps");
    box.style.display = "block";
}
function hideRideAlert() {
    el("nav-alert").style.display = "none";
    navAlertUntilM = 0;
}
/** Ask the rider something without stopping the ride. window.confirm blocks
 * the page, so guidance, the follow camera and the recorder all froze until it
 * was answered — easy to miss at speed, and indistinguishable from a crash. */
function askDuringRide(question, onYes) {
    const box = el("nav-ask");
    el("nav-ask-text").textContent = question;
    box.style.display = "block";
    el("nav-banner").classList.add("expanded");
    navAskYes = onYes;
}
let navAskYes = null;
function closeAsk() {
    el("nav-ask").style.display = "none";
    navAskYes = null;
}
/** "in 50 meters, you have arrived" is not English. The destination maneuver's
 * wording is written for the moment of arrival, so the staged calls need their
 * own phrasing. Returns null for ordinary turns. */
function arrivalPhrase(voice, metres) {
    return /have arrived/i.test(voice) ? `in ${metres} meters, your destination` : null;
}
/** Where we're going, for the arrival line. */
let navDestLabel = null;
/** Fit the map to a freshly planned route. A link is how routes are shared, and
 * the recipient of a 42 km route was left looking at the default view with 2% of
 * it on screen. Skipped while navigating, where the camera belongs to the rider. */
function frameRoute(option) {
    if (navActive)
        return;
    const coords = option.payload.geojson.features.flatMap((f) => f.geometry.type === "LineString" ? f.geometry.coordinates : []);
    if (coords.length < 2)
        return;
    let w = Infinity;
    let sth = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const [lon, lat] of coords) {
        if (lon < w)
            w = lon;
        if (lon > e)
            e = lon;
        if (lat < sth)
            sth = lat;
        if (lat > n)
            n = lat;
    }
    const phone = window.matchMedia("(max-width: 760px)").matches;
    map.fitBounds([
        [w, sth],
        [e, n],
    ], {
        // leave room for the panel: on a phone it's a bottom sheet, on desktop
        // it's down the left-hand side
        padding: phone
            ? { top: 60, bottom: Math.round(window.innerHeight * 0.5), left: 30, right: 30 }
            : { top: 60, bottom: 60, left: 380, right: 60 },
        duration: 700,
        maxZoom: 16,
    });
}
/** Where the rider is, in words. The hazard dialog used to print raw decimal
 * degrees at them while the app already knew the street name. */
function hereLabel(lon, lat) {
    const street = el("nav-street").textContent?.trim();
    if (navActive && street && !/^[-–]$/.test(street) && !/^⚠/.test(street)) {
        return `on ${street}`;
    }
    const cls = router?.edgeClassAt(lon, lat);
    return cls ? `on a ${cls.replace(/_/g, " ")}` : "at this spot";
}
/** "gather up" is what you say to children. A solo rider heard it 32 times on
 * one ride, which is both odd and easy to stop listening to. */
function ridePhrasing(voice) {
    return profileId === "solo" ? voice.replace(/\bgather up\b/gi, "take care") : voice;
}
/** A bearing as something sayable ("north-east"), for telling an off-route
 * rider which way the new route runs. */
function compassPoint(deg) {
    const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
    return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8] ?? "on";
}
/** Shortest signed angle a -> b, in degrees. */
function angleDelta(a, b) {
    return ((((b - a) % 360) + 540) % 360) - 180;
}
/** One continuous loop drives the dot and the follow camera toward the latest
 * fix. Fixes arrive ~1/s; easing every frame keeps motion smooth instead of
 * teleporting the dot while a queue of 900 ms camera eases fight each other. */
function navAnimate() {
    navRaf = null;
    if (!navActive)
        return;
    if (navPosTarget) {
        const cur = navPosShown ?? navPosTarget;
        const k = 0.18; // keeps up with a fix/sec without looking twitchy
        const next = [
            cur[0] + (navPosTarget[0] - cur[0]) * k,
            cur[1] + (navPosTarget[1] - cur[1]) * k,
        ];
        navPosShown = distM(next, navPosTarget) < 0.3 ? navPosTarget : next;
        navDot?.setLngLat(navPosShown);
    }
    if (navFollowing && navPosShown && !navInteracting) {
        navBearingShown =
            (navBearingShown + angleDelta(navBearingShown, navBearingTarget) * 0.12 + 360) % 360;
        const curZoom = map.getZoom();
        const zoom = navUserZoom ? curZoom : curZoom + (navZoomTarget - curZoom) * 0.06;
        // Only touch the camera when something actually moved. jumpTo fires a full
        // movestart/zoomstart/moveend cycle, so writing every frame spams events
        // (and burns battery) even when the rider is sitting still at a light.
        const c = map.getCenter();
        const moved = Math.abs(c.lng - navPosShown[0]) > 1e-7 ||
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
function navStartAnimation() {
    if (navRaf === null)
        navRaf = requestAnimationFrame(navAnimate);
}
function navStopAnimation() {
    if (navRaf !== null)
        cancelAnimationFrame(navRaf);
    navRaf = null;
    navPosShown = null;
    navPosTarget = null;
}
/** Metres of warning for a turn call: `secs` of riding at the current pace,
 * clamped so it's neither absurdly early nor too late to react. */
function announceDist(secs, [lo, hi]) {
    const speed = navSpeed > 0.8 ? navSpeed : (PROFILES[profileId].paceKmh * 1000) / 3600;
    return Math.max(lo, Math.min(hi, speed * secs));
}
function navOnFix(fix) {
    if (!navActive || !navTrack || !router)
        return;
    const lon = fix.lon;
    const lat = fix.lat;
    // A lone huge jump is the phone re-acquiring off a tower, not the rider.
    // Trust it only if it repeats, so we resync after a real signal gap.
    if (navLastPos && distM(navLastPos, [lon, lat]) > MAX_FIX_JUMP_M) {
        navImplausibleFixes++;
        if (navImplausibleFixes < IMPLAUSIBLE_FIXES_BEFORE_TRUSTED)
            return;
    }
    else {
        navImplausibleFixes = 0;
    }
    navLastPos = [lon, lat];
    if (el("nav-alert").classList.contains("gps"))
        hideRideAlert();
    // smoothed ground speed, for timing the turn calls
    const now = Date.now();
    if (fix.speed !== null && fix.speed !== undefined && fix.speed >= 0) {
        navSpeed = navSpeed === 0 ? fix.speed : navSpeed * 0.6 + fix.speed * 0.4;
    }
    else if (navPrevPos && navLastFixAt) {
        const dt = (now - navLastFixAt) / 1000;
        if (dt > 0.2) {
            const v = distM(navPrevPos, [lon, lat]) / dt;
            if (v < 25)
                navSpeed = navSpeed === 0 ? v : navSpeed * 0.7 + v * 0.3;
        }
    }
    navLastFixAt = now;
    // travel direction: GPS heading when moving, else derived from movement
    const gpsHeading = fix.heading;
    if (gpsHeading !== null && !Number.isNaN(gpsHeading) && (fix.speed ?? 0) > 0.7) {
        navHeading = gpsHeading;
    }
    else if (navPrevPos && distM(navPrevPos, [lon, lat]) > 5) {
        navHeading = (bearingDeg(navPrevPos, [lon, lat]) + 360) % 360;
    }
    if (!navPrevPos || distM(navPrevPos, [lon, lat]) > 3)
        navPrevPos = [lon, lat];
    // keep the ride recoverable: Back, a reload or a crash used to lose it all
    if (recorder && ++navFixesSinceStash >= STASH_EVERY_FIXES) {
        navFixesSinceStash = 0;
        stashInProgress(recorder.finish(profileId));
    }
    const snap = snapToTrack(navTrack, lon, lat, navHint);
    // record against along-route progress rather than raw fix-to-fix distance,
    // which counted GPS wander as forward motion
    recorder?.addPoint(Date.now(), lon, lat, router.edgeClassAt(lon, lat), snap.offM <= OFF_ROUTE_M ? snap.alongM : undefined);
    // Draw the dot ON the route while we're plausibly on it — raw bike GPS
    // wanders 5-15 m, which visibly drifts the dot into buildings and across
    // the street. Beyond SNAP_DISPLAY_M show the true position, so actually
    // being off-route reads as off-route instead of being hidden by snapping.
    navPosTarget = snap.offM <= SNAP_DISPLAY_M ? snap.pos : [lon, lat];
    if (!navDot) {
        const dot = document.createElement("div");
        dot.className = "nav-dot";
        navDot = new maplibregl.Marker({ element: dot }).setLngLat(navPosTarget).addTo(map);
        navPosShown = navPosTarget;
    }
    navStartAnimation();
    // off-route: a few good fixes in a row trigger a reroute to the destination
    // (like Google Maps — ride wherever you like, the route follows you)
    if (snap.offM > OFF_ROUTE_M) {
        // a poor GPS fix shouldn't count as a deviation
        if (fix.accuracy > MAX_GPS_ACCURACY_M)
            return;
        navOffCount++;
        // instant feedback while we make sure it's a real deviation
        el("nav-icon").textContent = "↩";
        el("nav-dist").textContent = "off route";
        el("nav-street").textContent = "adjusting…";
        // keep the trip line live instead of freezing on the last on-route value:
        // straight-line to the destination is the honest estimate while off-route
        if (navDest)
            navUpdateTrip(distM([lon, lat], navDest), true);
        // follow the rider's own direction while they're off the line
        if (navHeading !== null)
            navBearingTarget = navHeading;
        // and say so on screen for as long as it's true — the riders' logs showed
        // "adjusting…" sitting there with no other indication
        showRideAlert("⚠ off route", "gps");
        const now = Date.now();
        // Back off between attempts. A rider standing in a car park can sit >40 m
        // from every routable way, so the old fixed 10 s cooldown re-routed forever
        // and said "rerouting." on every attempt while the banner stayed stuck on
        // "adjusting…" — a loop at exactly the moment you most need a sentence.
        const wait = REROUTE_COOLDOWN_MS * Math.min(2 ** navRerouteTries, 6);
        if (navOffCount >= OFF_ROUTE_STRIKES && navDest && now - navLastRerouteAt > wait) {
            navOffCount = 0;
            navLastRerouteAt = now;
            const useMyWay = navMyWay && navHeading !== null;
            // Rate-limit the announcement by wall time, not by attempt count: a
            // successful reroute puts the rider "on" the new line for a fix, which
            // reset the counter, so continuing the same wrong turn kept re-announcing.
            if (now - navRerouteSpokenAt > REROUTE_ANNOUNCE_MIN_MS) {
                navRerouteSpokenAt = now;
                speak(useMyWay ? "okay, going your way." : "rerouting.", "turn");
                vibrate([80, 60, 80]);
            }
            navRerouteTries++;
            try {
                const bias = useMyWay && navHeading !== null
                    ? router.headingBias([lon, lat], navHeading)
                    : undefined;
                options = router.routeOptions([lon, lat], navDest, profileId, preferFlat, bias, avoidTypes);
                const first = options[0];
                if (first) {
                    selectOption(first.id);
                    rebuildNavFromSelected();
                    // tell the rider a new way exists and which way it goes, instead of
                    // leaving "adjusting…" up while a fresh route sits undrawn-to
                    const back = navTrack ? trackBearingAhead(navTrack, 0, 0) : null;
                    showRideAlert(back === null
                        ? "⚠ off route — new route ready"
                        : `⚠ off route — head ${compassPoint(back)} to rejoin`, "gps");
                }
            }
            catch {
                showRideAlert("⚠ off route — no way back from here", "gps");
            }
        }
        return;
    }
    navOffCount = 0;
    navRerouteTries = 0;
    if (el("nav-alert").classList.contains("gps"))
        hideRideAlert();
    navHint = snap.idx;
    // advance past maneuvers we've already ridden through
    while (navNext < navManeuvers.length - 1 && (navManeuvers[navNext]?.atM ?? 0) < snap.alongM - 20) {
        navNext++;
        navAnnounceStage = 0;
    }
    // ...and go back if the rider overshot and doubled back. navNext only ever
    // advanced, so a turn you missed and returned to was never called again.
    while (navNext > 0 && (navManeuvers[navNext - 1]?.atM ?? 0) > snap.alongM + 20) {
        navNext--;
        navAnnounceStage = 0;
    }
    const next = navManeuvers[navNext];
    const distToNext = Math.max(0, (next?.atM ?? 0) - snap.alongM);
    const remaining = Math.max(0, navTrack.totalM - snap.alongM);
    // un-latch a stale arrival (bad fix, or a new ride begun at the old
    // destination) so the banner and voice come back
    if (navArrived && remaining > ARRIVAL_CLEAR_M)
        navArrived = false;
    // A useless fix still drove the headline distance, which read "now" three
    // times inside 20 m and then jumped back to 100 m. Hold the last good
    // reading and say the signal is poor instead of inventing precision.
    const poorFix = fix.accuracy > MAX_GPS_ACCURACY_M;
    if (poorFix) {
        showRideAlert("⚠ GPS signal poor", "gps");
    }
    else {
        if (el("nav-alert").classList.contains("gps"))
            hideRideAlert();
        navUpdateBanner(distToNext, remaining);
    }
    if (next && !poorFix) {
        // chain a turn that lands right after this one ("left, then right") so a
        // quick pair isn't two calls on top of each other
        const after = navManeuvers[navNext + 1];
        const chain = after && after.atM - next.atM <= THEN_CHAIN_M ? `, then ${after.voice}` : "";
        if (navAnnounceStage < 3 && distToNext <= announceDist(ANNOUNCE_NOW_S, ANNOUNCE_NOW_CLAMP)) {
            speak(`${next.voice}${chain}`);
            vibrate([200]);
            navAnnounceStage = 3;
        }
        else if (navAnnounceStage < 2 &&
            distToNext <= announceDist(ANNOUNCE_NEAR_S, ANNOUNCE_NEAR_CLAMP)) {
            speak(arrivalPhrase(next.voice, navDistM(distToNext)) ??
                `in ${navDistVoice(distToNext)}, ${next.voice}${chain}`);
            vibrate([100]);
            navAnnounceStage = 2;
        }
        else if (navAnnounceStage < 1 &&
            distToNext <= announceDist(ANNOUNCE_FAR_S, ANNOUNCE_FAR_CLAMP)) {
            speak(arrivalPhrase(next.voice, navDistM(distToNext)) ??
                `in ${navDistVoice(distToNext)}, ${next.voice}`);
            navAnnounceStage = 1;
        }
    }
    // hazard alerts (voice + distinct buzz), announced ~100 m out
    while (navAlertNext < navAlerts.length && (navAlerts[navAlertNext]?.atM ?? 0) < snap.alongM - 10) {
        navAlertNext++;
    }
    const alert = navAlerts[navAlertNext];
    if (alert && alert.atM - snap.alongM <= 100) {
        speak(ridePhrasing(alert.voice), "safety");
        vibrate([100, 80, 100]);
        // and put it on screen, held until we're past the hazard
        showRideAlert(`⚠ ${ridePhrasing(alert.voice)}`);
        navAlertUntilM = alert.atM + 30;
        navAlertNext++;
    }
    else if (navAlertUntilM > 0 && snap.alongM > navAlertUntilM) {
        hideRideAlert();
    }
    // kid morale: kilometer milestones and the halfway mark
    // Catch up silently on the first fix: joining a route part-way (a train leg,
    // a cold GPS, a replan) fired "1 kilometer done… 20 kilometers done" one per
    // second before any guidance.
    if (navNextKm === 1 && snap.alongM > 1500) {
        navNextKm = Math.floor(snap.alongM / 1000) + 1;
        navHalfway = snap.alongM >= navTrack.totalM / 2;
    }
    if (snap.alongM >= navNextKm * 1000) {
        speak(`${navNextKm} kilometer${navNextKm > 1 ? "s" : ""} done. nice riding!`, "chat");
        navNextKm++;
    }
    if (!navHalfway && navTrack.totalM > 1500 && snap.alongM >= navTrack.totalM / 2) {
        navHalfway = true;
        speak("halfway there!", "chat");
    }
    if (remaining < 15 && !navArrived) {
        navArrived = true;
        vibrate([200, 100, 200]);
        if (navOriginalDest) {
            speak("arrived at your stop. tap resume when you're ready to ride on.");
            el("nav-icon").textContent = "🛑";
            el("nav-dist").textContent = "At the stop";
            el("nav-street").textContent = "tap ▶ resume to ride on";
            el("nav-resume").style.display = "inline-block";
        }
        else {
            speak(`you have arrived. ${(navTrack.totalM / 1000).toFixed(1)} kilometers — nicely done!`);
            el("nav-icon").textContent = "🏁";
            el("nav-dist").textContent = "Arrived";
            el("nav-street").textContent = navDestLabel ?? "you're there";
            el("nav-remaining").textContent =
                `${(navTrack.totalM / 1000).toFixed(1)} km ridden`;
            el("nav-speed").textContent = "";
            hideRideAlert();
            finishAndSaveRide();
        }
    }
    // dim the ridden part of the route so progress reads at a glance
    getSource("route-done").setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: trackSlice(navTrack, snap.alongM) },
    });
    // Camera targets — the rAF loop eases toward these. Bearing is averaged over
    // the track ahead (a per-segment bearing swings wildly on twisty paths), and
    // held steady when stopped so the map doesn't spin in place.
    if (navSpeed > 0.8 || navBearingTarget === 0) {
        navBearingTarget = trackBearingAhead(navTrack, snap.idx, snap.alongM);
    }
    navZoomTarget = distToNext <= NAV_ZOOM_TURN_M ? NAV_ZOOM_TURN : NAV_ZOOM_CRUISE;
}
async function startNav() {
    if (!rebuildNavFromSelected())
        return;
    const destLngLat = end?.getLngLat() ?? start?.getLngLat();
    if (!destLngLat)
        return;
    navDest = [destLngLat.lng, destLngLat.lat];
    navDestLabel = el("search").value.trim().split(",")[0] || null;
    navOriginalDest = null;
    el("nav-resume").style.display = "none";
    navActive = true;
    navFollowing = true;
    navUserZoom = false;
    navSpeed = 0;
    navLastFixAt = 0;
    navRerouteTries = 0;
    navRerouteSpokenAt = 0;
    navPaceKmh = null;
    navImplausibleFixes = 0;
    voiceWarned = false;
    navBearingShown = map.getBearing();
    navBearingTarget = 0;
    navZoomTarget = NAV_ZOOM_CRUISE;
    recorder = new RideRecorder();
    document.body.classList.add("navigating");
    el("nav-banner").style.display = "block";
    setRecentreNeeded(false);
    map.setLayoutProperty("route-done", "visibility", "visible");
    // label-free basemap, our own upright labels, and the network dimmed behind
    // the route — all of which applyBasemap decides from navActive
    applyBasemap();
    try {
        wakeLock = await navigator.wakeLock.request("screen");
    }
    catch {
        wakeLock = null; // unsupported or denied — navigation still works
    }
    if (isNativeApp()) {
        // native app: background watcher keeps GPS + voice alive with the
        // screen off (shows a persistent notification while navigating)
        navBgWatcherId = await startBackgroundWatcher("Family Bike Router", "Turn-by-turn navigation is running", navOnFix, (message) => {
            showRideAlert(`⚠ ${message}`, "gps");
        });
    }
    if (navBgWatcherId === null) {
        navWatchId = navigator.geolocation.watchPosition(navOnPosition, (err) => onLocationError(err), { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    }
    // absorb one Back press: on Android the hardware button is a thumb-brush from
    // ending the ride, and there was no guard of any kind
    history.pushState({ navigating: true }, "");
    speak("navigation started", "chat");
}
function exitNav() {
    finishAndSaveRide();
    navActive = false;
    // the stops menu belongs to the ride; left open it floated over the planner
    stopsOpen(false);
    navOriginalDest = null;
    navLastPos = null;
    if (navWatchId !== null)
        navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
    if (navBgWatcherId !== null)
        void stopBackgroundWatcher(navBgWatcherId);
    navBgWatcherId = null;
    void wakeLock?.release().catch(() => undefined);
    wakeLock = null;
    closeAsk();
    hideClassify();
    hideRideAlert();
    window.clearTimeout(navRefollowTimer);
    navStopAnimation();
    navDot?.remove();
    navDot = null;
    clearSpeech();
    document.body.classList.remove("navigating");
    el("nav-banner").style.display = "none";
    map.setLayoutProperty("route-done", "visibility", "none");
    applyBasemap(); // restores the network's normal opacity
    getSource("route-done").setData(emptyFC());
    const threeD = el("show-3d").checked;
    map.easeTo({ pitch: threeD ? 60 : 0, bearing: 0, duration: 800 });
}
/** Mid-ride detour: reroute to the nearest kid stop of a kind, remembering
 * the original destination for the resume button. */
function detourToNearest(kind) {
    if (!navActive || !router || !navLastPos)
        return;
    const candidates = pois.filter((p) => p.properties.kind === kind);
    const idx = router.nearestReachable(navLastPos, candidates.map((p) => p.geometry.coordinates), profileId, preferFlat);
    const poi = idx !== null ? candidates[idx] : undefined;
    if (!poi) {
        speak(`no ${kind === "water" ? "water fountain" : kind} found nearby`);
        return;
    }
    try {
        options = router.routeOptions(navLastPos, poi.geometry.coordinates, profileId, preferFlat, undefined, avoidTypes);
        const first = options[0];
        if (!first)
            return;
        selectOption(first.id);
        if (navOriginalDest === null)
            navOriginalDest = navDest;
        navDest = poi.geometry.coordinates;
        rebuildNavFromSelected();
        // offer the way back immediately: this used to appear only on ARRIVAL at
        // the stop, so a mis-tapped detour couldn't be abandoned, and the voice
        // said "tap resume" for a button that wasn't on screen
        el("nav-resume").style.display = "block";
        const label = poi.properties.name || POI_META[kind]?.label || kind;
        speak(`detour: ${label} is ${fmtDist(first.payload.summary.meters)} away. follow the route.`);
    }
    catch (err) {
        speak("could not plan a detour from here");
        void err;
    }
}
el("nav-water").addEventListener("click", () => {
    detourToNearest("water");
});
el("nav-restroom").addEventListener("click", () => {
    detourToNearest("restroom");
});
el("nav-playground").addEventListener("click", () => {
    detourToNearest("playground");
});
el("nav-resume").addEventListener("click", () => {
    if (!router || !navLastPos || !navOriginalDest)
        return;
    try {
        options = router.routeOptions(navLastPos, navOriginalDest, profileId, preferFlat, undefined, avoidTypes);
        const first = options[0];
        if (!first)
            return;
        selectOption(first.id);
        navDest = navOriginalDest;
        navOriginalDest = null;
        rebuildNavFromSelected();
        el("nav-resume").style.display = "none";
        hideRideAlert();
        speak("back on the way. let's go!");
    }
    catch {
        speak("could not plan the way back from here");
    }
});
el("nav-myway").classList.toggle("active", navMyWay);
el("nav-myway").addEventListener("click", () => {
    navMyWay = !navMyWay;
    localStorage.setItem("navMyWay", navMyWay ? "1" : "0");
    el("nav-myway").classList.toggle("active", navMyWay);
    speak(navMyWay
        ? "going your way: reroutes will follow your direction."
        : "back to safest: reroutes return to the safest path.");
});
el("nav-hazard").addEventListener("click", () => {
    if (!navLastPos) {
        // it did nothing at all with no fix yet — a dead button with no feedback
        showRideAlert("⚠ no position yet — can't mark this spot", "gps");
        return;
    }
    // Tapping again because nothing visible happened wrote a duplicate mark, and
    // marks can only be removed from the planning panel, which is hidden while
    // riding. Collapse repeats within a few metres.
    const already = sketchyMarks.some((m) => distM(m, navLastPos) < 15);
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
    const pref = el("units-pref");
    pref.value = getUnits();
    const syncUnitLabels = () => {
        el("loop-unit").textContent = unitName() === "miles" ? "mi" : "km";
    };
    syncUnitLabels();
    pref.addEventListener("change", () => {
        const wasM = toMeters(Number(el("loop-dist").value) || 0);
        setUnits(pref.value === "metric" ? "metric" : "imperial");
        syncUnitLabels();
        // the number in the box meant a distance, not a digit: keep the distance
        if (wasM > 0) {
            el("loop-dist").value = String(Math.round(fromMeters(wasM) * 10) / 10);
        }
        renderOptions();
        renderOptionChips();
        const sel = options.find((o) => o.id === selectedId);
        if (sel)
            showSummary(sel);
        renderPlacesAndRecent();
        renderRides();
    });
}
el("nav-btn").addEventListener("click", () => {
    void startNav();
});
el("nav-exit").addEventListener("click", () => {
    // it used to end the ride outright, and sat 9 px from the mute button
    askDuringRide("End the ride now?", exitNav);
});
el("nav-ask-no").addEventListener("click", closeAsk);
el("nav-ask-yes").addEventListener("click", () => {
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
function setRecentreNeeded(needed) {
    const btn = el("nav-recenter");
    btn.classList.toggle("idle", !needed);
    const label = needed ? "Recentre on me" : "Already following you";
    btn.setAttribute("aria-label", label);
    btn.title = label; // it said "Recentre on me" while the label said otherwise
}
// Layers: twelve of them, so a way back to the state someone can reason about.
// Everything routes through a change event rather than being set directly, so a
// reset takes exactly the path a tap does and can't drift from it.
const LAYER_DEFAULTS = {
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
    // dark-mode is deliberately absent. It follows the system setting and belongs
    // to the rider, not to the map: resetting the layers on a night ride should
    // not white out the screen.
};
el("layers-reset").addEventListener("click", () => {
    for (const [id, want] of Object.entries(LAYER_DEFAULTS)) {
        const box = document.getElementById(id);
        if (!box || box.checked === want)
            continue;
        box.checked = want;
        box.dispatchEvent(new Event("change", { bubbles: true }));
    }
});
// The planner layers belong to a workspace of its own now, so the link leaves
// the rider's app rather than expanding a section inside it.
// The stops menu. The three detours were three of nine buttons in a drawer;
// they are one dock button and a menu that opens upward, out from under the
// thumb that just tapped it.
function stopsOpen(open) {
    el("nav-stops-menu").style.display = open ? "flex" : "none";
    el("nav-stops").setAttribute("aria-expanded", String(open));
}
el("nav-stops").addEventListener("click", (e) => {
    e.stopPropagation();
    stopsOpen(el("nav-stops").getAttribute("aria-expanded") !== "true");
});
// Tapping the map puts it away — and only that. The map's own mid-ride handler
// asks whether to abandon the route, so without swallowing this tap, dismissing
// a menu also offered to throw the ride away.
// Outside a ride the map has no "are you sure", so a tap just closes the menu.
map.on("click", () => {
    if (!navActive)
        stopsOpen(false);
});
for (const id of ["nav-water", "nav-restroom", "nav-playground"]) {
    el(id).addEventListener("click", () => stopsOpen(false));
}
el("nav-mute").addEventListener("click", () => {
    navMuted = !navMuted;
    const btn = el("nav-mute");
    // the icon alone read as decoration at a glance; the word says which it is
    btn.querySelector(".dock-icon").textContent = navMuted ? "🔇" : "🔊";
    btn.querySelector(".dock-label").textContent = navMuted ? "muted" : "voice on";
    btn.classList.toggle("muted", navMuted);
    btn.setAttribute("aria-label", navMuted ? "Voice off — tap to turn on" : "Voice on — tap to mute");
    if (navMuted)
        clearSpeech();
});
el("nav-recenter").addEventListener("click", () => {
    navFollowing = true;
    navUserZoom = false; // hand the zoom back to the follow camera
    setRecentreNeeded(false);
});
window.addEventListener("popstate", () => {
    if (!navActive)
        return;
    // stay on the ride and ask, rather than silently leaving it
    history.pushState({ navigating: true }, "");
    askDuringRide("End the ride?", exitNav);
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
map.on("zoomstart", (e) => {
    if (navActive && e.originalEvent) {
        navUserZoom = true;
        setRecentreNeeded(true);
    }
});
// The follow camera writes the map every animation frame, which would fight
// (and cancel) the rider's own pinch/scroll before MapLibre could even start
// the gesture. Back off the moment they touch the map, resume shortly after.
let navInteractTimer;
function pauseFollowForInput() {
    if (!navActive)
        return;
    navInteracting = true;
    scheduleRefollow();
    window.clearTimeout(navInteractTimer);
    navInteractTimer = window.setTimeout(() => {
        navInteracting = false;
    }, 500);
}
/** The rider took the zoom: keep it until they tap recenter (or until the
 * camera takes itself back — see scheduleRefollow). */
function takeZoomControl() {
    if (!navActive)
        return;
    navUserZoom = true;
    setRecentreNeeded(true);
    scheduleRefollow();
}
/** Hand the camera back to the route once the rider has stopped fiddling. */
function scheduleRefollow() {
    window.clearTimeout(navRefollowTimer);
    navRefollowTimer = window.setTimeout(() => {
        if (!navActive)
            return;
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
map.on("touchstart", (e) => {
    pauseFollowForInput();
    if ((e.originalEvent?.touches.length ?? 0) >= 2)
        takeZoomControl(); // pinch
});
map.on("mousedown", pauseFollowForInput);
// ---------------------------------------------------------------------------
// offline: pre-cache basemap tiles along the selected route (zooms 13-16,
// ~1-tile corridor) into the service worker's tile cache
// ---------------------------------------------------------------------------
const TILE_CACHE = "bike-tiles-v1";
function tileXY(lon, lat, z) {
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const latR = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n);
    return [x, y];
}
function routeTileUrls(track) {
    // One vector tile set serves every basemap mode, so unlike the old raster
    // pair there is no light/dark choice to make here — and nothing to get wrong
    // when a rider flips theme halfway through an offline ride.
    //
    // Carto serves these from tiles-a…d and MapLibre picks a subdomain per tile,
    // so these are written against tiles-a and the service worker canonicalises
    // every sibling host onto it. Caching whichever host we happened to name
    // would leave three quarters of a ride uncached.
    //
    // Vector tiles stop at z14 (CARTO_MAXZOOM) and MapLibre overzooms them for
    // closer views, so z13-14 covers the z13-16 a ride actually displays — far
    // fewer requests than the four raster zooms this used to pull.
    const template = "https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt";
    const urls = new Set();
    for (const z of [13, CARTO_MAXZOOM]) {
        // sample the track densely enough that no tile is skipped at this zoom
        const stepM = z >= CARTO_MAXZOOM ? 250 : 400;
        let nextAt = 0;
        track.coords.forEach((c, i) => {
            if ((track.cumM[i] ?? 0) < nextAt && i !== track.coords.length - 1)
                return;
            nextAt = (track.cumM[i] ?? 0) + stepM;
            const [x, y] = tileXY(c[0], c[1], z);
            const spread = z >= CARTO_MAXZOOM ? 1 : 0; // 3x3 corridor at the deepest zoom
            for (let dx = -spread; dx <= spread; dx++) {
                for (let dy = -spread; dy <= spread; dy++) {
                    urls.add(template
                        .replace("{z}", String(z))
                        .replace("{x}", String(x + dx))
                        .replace("{y}", String(y + dy)));
                }
            }
        });
    }
    return [...urls];
}
el("offline-btn").addEventListener("click", () => {
    const sel = options.find((o) => o.id === selectedId);
    if (!sel)
        return;
    const btn = el("offline-btn");
    const urls = routeTileUrls(buildTrack(sel.payload));
    btn.disabled = true;
    let done = 0;
    void caches
        .open(TILE_CACHE)
        .then(async (cache) => {
        const pool = 6;
        const queue = [...urls];
        const worker = async () => {
            for (;;) {
                const url = queue.shift();
                if (url === undefined)
                    return;
                try {
                    if ((await cache.match(url)) === undefined) {
                        // A real CORS fetch, not mode:"no-cors". MapLibre has to read
                        // these tiles as bytes, and an opaque response stores a body it
                        // can never parse — the ride would report itself cached and still
                        // come up blank. Carto answers with access-control-allow-origin:*.
                        const resp = await fetch(url);
                        if (resp.ok)
                            await cache.put(url, resp);
                    }
                }
                catch {
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
function applyBasemap() {
    const dark = document.body.classList.contains("dark");
    const aerial = el("show-aerial").checked;
    const netOn = el("show-net").checked;
    // while riding, the map is turned to the heading: drop the basemap's baked
    // labels and draw our own, which stay the right way up
    const plain = navActive;
    const setVis = () => {
        // Skip layers that aren't added yet: this runs during map load too, from
        // whichever data callback lands first, and setLayoutProperty throws on an
        // unknown id — which took the calling chain (and the route panel) with it.
        const vis = (id, on) => {
            if (map.getLayer(id) !== undefined) {
                map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
            }
        };
        vis("aerial", aerial);
        // One theme at a time, its label layers dropped while riding, and the whole
        // basemap off under the aerial view. show() is instant for a theme already
        // installed; ensure() covers the first use of one, then shows it.
        const wanted = {
            theme: (dark ? "dark" : "light"),
            labels: !plain,
            on: !aerial,
        };
        basemap.show(wanted);
        void basemap
            .ensure(wanted.theme)
            .then(() => basemap.show(wanted))
            .catch((err) => {
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
            map.setPaintProperty("street-labels", "text-halo-color", dark || aerial ? "rgba(10,14,22,0.9)" : "rgba(255,255,255,0.92)");
        }
        if (map.getLayer("route-casing") !== undefined) {
            map.setPaintProperty("route-casing", "line-color", dark || aerial ? "#9db8ff" : "#1440a0");
        }
        if (map.getLayer("alts") !== undefined) {
            map.setPaintProperty("alts", "line-color", dark || aerial ? "#ccc" : "#777");
        }
        // over photos the lanes need contrast: dark halo + thicker, solid lines
        vis("network-casing", aerial && netOn);
        const width = aerial
            ? ["interpolate", ["linear"], ["zoom"], 12, 2.0, 16, 5.0]
            : ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 3.5];
        for (const layer of ["network", "network-unconfirmed"]) {
            if (map.getLayer(layer) === undefined)
                continue;
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
    if (map.getLayer("aerial") !== undefined)
        setVis();
    else
        map.once("load", setVis);
}
function applyDark(dark) {
    document.body.classList.toggle("dark", dark);
    el("dark-mode").checked = dark;
    applyBasemap();
}
// Light by default: this is a daylight map, and the basemap + safety colours
// are tuned for it. Dark is opt-in and remembered — following the phone's
// system theme turned it on for riders who never asked for it.
applyDark(localStorage.getItem(DARK_KEY) === "1");
el("dark-mode").addEventListener("change", (e) => {
    const dark = e.target.checked;
    localStorage.setItem(DARK_KEY, dark ? "1" : "0");
    applyDark(dark);
});
el("show-aerial").addEventListener("change", applyBasemap);
el("show-constr").addEventListener("change", (e) => {
    const on = e.target.checked;
    for (const layer of ["construction-lines", "construction-pts"]) {
        map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    }
});
renderPlacesAndRecent();
window._map = map;
// ---------------------------------------------------------------------------
// in-app update check (native app only): compare the bundled build version
// against the latest release published next to the mirrored APK
// ---------------------------------------------------------------------------
// The release asset, not the Pages mirror. Pages has a ~100 GB/month bandwidth
// allowance and the APK is 90 MB, so a thousand downloads would be the entire
// month's budget and would take the site down with it. Release downloads don't
// count against that at all.
const APK_URL = "https://github.com/pelednoam/safe-bikes-lanes/releases/latest/download/family-bike-router.apk";
async function checkAppUpdate() {
    if (!isNativeApp())
        return;
    try {
        const bundled = (await (await fetch("version.json")).json());
        const resp = await fetch("https://pelednoam.github.io/safe-bikes-lanes/app/version.json", { cache: "no-store" });
        if (!resp.ok)
            return;
        const latest = (await resp.json());
        if (bundled.version === undefined ||
            latest.version === undefined ||
            !isNewerAppVersion(bundled.version, latest.version)) {
            return;
        }
        const banner = el("update-banner");
        el("update-text").textContent =
            `Update available: ${bundled.version} → ${latest.version}`;
        banner.style.display = "flex";
        const getBtn = el("update-get");
        getBtn.href = APK_URL; // plain link: works even if the handler never runs
        const text = el("update-text");
        getBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            // Says where to look, not that it worked.
            //
            // This used to read "downloading…" the instant the button was tapped,
            // before anything had been asked of Android and whatever the answer was —
            // so when the download silently went nowhere, the app still reported
            // success. The wording now names the two places the file can appear and
            // leaves the rider able to tell that it hasn't.
            text.textContent = "asked Android to download it — look in your notifications, then Downloads";
            startDownload(APK_URL);
        });
        el("update-dismiss").addEventListener("click", () => {
            banner.style.display = "none";
        });
    }
    catch {
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
                for (const k of await caches.keys()) {
                    if (k.startsWith("family-bike-router") || k.startsWith("bike-tiles")) {
                        await caches.delete(k);
                    }
                }
            }
            catch {
                // caches API unavailable in this webview — nothing to clear
            }
            if (had && navigator.serviceWorker.controller && !sessionStorage.getItem("swCleared")) {
                sessionStorage.setItem("swCleared", "1");
                location.reload();
            }
        })();
    }
    else {
        // web PWA: auto-update to the newest build without a hard refresh.
        // Reload once when a NEW service worker takes control — but only if one
        // was already controlling at load (i.e. a genuine update, not first visit,
        // so we never reload-loop on initial install/clients.claim).
        if (navigator.serviceWorker.controller) {
            let reloaded = false;
            navigator.serviceWorker.addEventListener("controllerchange", () => {
                if (reloaded)
                    return;
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
const WEIGHT_KEYS = ["severance", "access", "crash", "coverage"];
/** The slider positions matching the weighting the pipeline actually ranked with.
 *
 * Read from the data rather than repeated here. These used to be four literals
 * with a comment saying they were the pipeline's weighting — which was true only
 * as long as nobody changed PRIORITY_WEIGHTS, and if anyone had, this list and
 * the /build workspace would have disagreed with the exported score, and with
 * each other, about which project a city should do first.
 */
function publishedWeightPositions() {
    const w = priorityMeta?.model?.weights;
    if (w === undefined)
        return null;
    const vals = WEIGHT_KEYS.map((k) => w[k]);
    if (!vals.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
        return null;
    }
    const total = vals.reduce((a, b) => a + b, 0);
    if (total <= 0)
        return null;
    const out = {};
    WEIGHT_KEYS.forEach((k, i) => {
        out[k] = String(Math.round((vals[i] / total) * 100));
    });
    return out;
}
let projects = [];
/** The loaded layer, kept so re-weighting can repaint it. */
let projectFC = null;
/** Extent per project, kept from the panel's own load.
 *
 * Read from the map source instead, selecting a row did nothing at all unless
 * the overlay toggle happened to be on already — the source is only filled when
 * the layer loads. The panel has the geometry in hand; it should use it. */
const projectBounds = new Map();
let priorityMeta = null;
let selectedProject = null;
function weightValues() {
    const raw = {};
    let total = 0;
    for (const key of WEIGHT_KEYS) {
        const v = Number(el(`wt-${key}`).value);
        raw[key] = v;
        total += v;
    }
    if (total <= 0)
        return { severance: 1, access: 0, crash: 0, coverage: 0 };
    for (const key of WEIGHT_KEYS)
        raw[key] /= total;
    return raw;
}
/** Every project's score under the current weights, for painting the map. */
function scoreAllProjects() {
    const w = weightValues();
    return new Map(projects.map((p) => [
        p.pid,
        Math.round((w.severance * p.c_severance +
            w.access * p.c_access +
            w.crash * p.c_crash +
            w.coverage * p.c_coverage) *
            1000) / 1000,
    ]));
}
/** Re-score with the panel's weights. The components are what the pipeline
 * measured; only their relative importance is the reader's to choose. */
function rankedProjects() {
    const w = weightValues();
    const town = el("build-town").value;
    const seenGroups = new Set();
    return projects
        .filter((p) => town === "" ||
        // exact, per name: a substring match put Lynnfield under Lynn, North
        // Reading under Reading, and North Andover under Andover
        p.towns
            .split(",")
            .map((t) => t.trim())
            .includes(town))
        .map((p) => ({
        p,
        score: w.severance * p.c_severance +
            w.access * p.c_access +
            w.crash * p.c_crash +
            w.coverage * p.c_coverage,
    }))
        .sort((a, b) => b.score - a.score)
        .filter(({ p }) => {
        // one row per gap: alternatives across the same barrier are listed on the
        // row they belong to, not as separate near-identical entries
        if (seenGroups.has(p.group))
            return false;
        seenGroups.add(p.group);
        return true;
    })
        .map(({ p, score }) => ({ ...p, score: Math.round(score * 1000) / 1000 }));
}
function focusProject(pid) {
    selectedProject = pid;
    if (!projects.some((p) => p.pid === pid))
        return;
    // choosing a project shows the projects: it would be odd to highlight
    // something on an invisible layer
    const toggle = el("show-build");
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
    if (box)
        map.fitBounds(box, { padding: 90, maxZoom: 16.5, duration: 600 });
    el("whatif").style.display = "block";
    if (whatIfPid !== null && whatIfPid !== pid)
        clearWhatIf();
    else
        el("whatif-result").textContent = "";
    renderBuildList();
}
/** Repaint the map with the reader's weighting.
 *
 * The layer's colour and width are driven by the score property, so moving the
 * sliders re-sorted the list while the map kept painting our own weighting —
 * the two openly contradicted each other about which project was the big one.
 */
function repaintProjects(scored) {
    if (!projectFC || map.getSource("build") === undefined)
        return;
    for (const f of projectFC.features) {
        const pid = f.properties?.pid;
        if (pid === undefined || f.properties === null)
            continue;
        const score = scored.get(pid);
        if (score !== undefined)
            f.properties["score"] = score;
    }
    map.getSource("build").setData(projectFC);
}
// ── what if this were protected? ──────────────────────────────────────────
// The ranked list asserts a project is worth building. This lets the reader
// check it against their own trip, which is the difference between a number
// and an argument.
let whatIfPid = null;
function whatIfPoints(pid) {
    const feature = projectFC?.features.find((f) => f.properties?.pid === pid);
    if (!feature)
        return [];
    const parts = feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates.flat()
        : feature.geometry.type === "LineString"
            ? feature.geometry.coordinates
            : [];
    return parts;
}
function clearWhatIf() {
    whatIfPid = null;
    router?.setUpgradedPoints([]);
    el("whatif-clear").style.display = "none";
    el("whatif-result").textContent = "";
    void requestRoute();
}
async function runWhatIf(pid) {
    const out = el("whatif-result");
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
        const before = router.safeShed([at.lng, at.lat], budget, profileId, preferFlat);
        router.setUpgradedPoints(points);
        const after = router.safeShed([at.lng, at.lat], budget, profileId, preferFlat);
        whatIfPid = pid;
        el("whatif-clear").style.display = "";
        const gain = Math.round((after.reachableKm - before.reachableKm) * 10) / 10;
        out.textContent =
            gain > 0
                ? `From your start, ${gain} km more of kid-safe street comes into reach ` +
                    `(${before.reachableKm} → ${after.reachableKm} km).`
                : "From your start, this one doesn't change what's in reach.";
        return;
    }
    const chosen = options.find((o) => o.id === selectedId) ?? options[0];
    if (!chosen || !router) {
        out.textContent = "plan a trip first, then ask";
        return;
    }
    const was = chosen.payload.summary;
    const covered = router.setUpgradedPoints(points);
    whatIfPid = pid;
    el("whatif-clear").style.display = "";
    await requestRoute();
    const now = (options.find((o) => o.id === selectedId) ?? options[0])?.payload.summary;
    if (!now) {
        out.textContent = "couldn't re-plan with that built";
        return;
    }
    const dKm = Math.round((now.meters - was.meters) / 100) / 10;
    const dProt = now.pct_protected - was.pct_protected;
    const parts = [];
    if (dProt !== 0)
        parts.push(`${dProt > 0 ? "+" : ""}${dProt}% protected`);
    if (Math.abs(dKm) >= 0.1)
        parts.push(`${dKm > 0 ? "+" : ""}${dKm} km`);
    out.innerHTML = "";
    const line = document.createElement("b");
    line.textContent =
        parts.length > 0
            ? `Your trip: ${parts.join(", ")}.`
            : "Your trip doesn't change — this project isn't on your way.";
    out.appendChild(line);
    // never let the phrasing imply more was modelled than actually matched
    out.appendChild(document.createTextNode(` Modelled as ${covered} rebuilt segment${covered === 1 ? "" : "s"}, separated,` +
        " with its crash history and crossing penalty removed — the same" +
        " assumption the ranking uses."));
}
function renderBuildList() {
    const box = el("build-list");
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
        head.appendChild(document.createTextNode(`${fmtDist(p.length_m)} of ${p.name}${p.towns ? ` — ${p.towns}` : ""}`));
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
        const act = () => {
            focusProject(p.pid);
        };
        const preview = (on) => {
            if (map.getLayer("build-hover") === undefined)
                return;
            map.setFilter("build-hover", ["==", ["get", "pid"], on ? p.pid : ""]);
            // only useful once the layer is drawable; focusProject turns it on
            map.setLayoutProperty("build-hover", "visibility", on && el("show-build").checked ? "visible" : "none");
        };
        row.addEventListener("mouseenter", () => preview(true));
        row.addEventListener("mouseleave", () => preview(false));
        row.addEventListener("focus", () => preview(true));
        row.addEventListener("blur", () => preview(false));
        row.addEventListener("click", act);
        row.addEventListener("keydown", (e) => {
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
function describeMeta(meta) {
    const pct = meta.access?.stranded_pct;
    const headcount = meta.population?.is_headcount === true;
    const who = headcount ? "residents" : "homes (estimated from street length)";
    el("build-intro").textContent =
        pct === undefined
            ? "Candidate projects, ranked by how much safe network they'd open up."
            : `${pct}% of ${who} in the mapped towns can't reach a school, playground or ` +
                `library within ${Math.round((meta.access?.budget_m ?? 0) / 100) / 10} km of ` +
                "perceived distance. These are the projects that would change that most.";
    const limits = meta.limits ?? [];
    // A field the build did not record is not a zero. "Measured 0 candidates
    // against 0 schools" reads as a finished analysis that found nothing, which is
    // the opposite of what a missing count means.
    const counted = (n) => (n === undefined ? "the" : String(n));
    el("build-method").textContent =
        `Measured ${counted(meta.candidates)} candidates against ${counted(meta.destinations)} ` +
            `schools, playgrounds and libraries it found (data built ` +
            `${meta.built ?? "an unrecorded date"}). Method and limits are in About.`;
    // The same limits, in full, where someone checking a number will look. A
    // ranking a city might quote in public needs its caveats somewhere citable.
    el("about-build").style.display = limits.length > 0 ? "block" : "none";
    el("about-build-text").textContent =
        `Every street a kid can't use is cut into candidate projects, and each is ` +
            `measured against the network as it stands: what kid-safe network it would ` +
            `join, how much closer it brings people to ${counted(meta.destinations)} schools, ` +
            `playgrounds and libraries, its recorded bike crashes, and how many ` +
            `residents gain a safe route at all. Population is ${meta.population?.source ?? "unavailable"}. ${meta.access?.budget_note ?? ""}`;
    const list = el("about-build-limits");
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
function ensureBuildMeta() {
    if (buildMetaStarted)
        return;
    buildMetaStarted = true;
    void dataReady
        .then(() => loadJson("priorities_meta.json"))
        .then((meta) => {
        priorityMeta = meta;
        // the sliders start where the analysis did, so this list and /build open on
        // the same ranking as the exported score
        const published = publishedWeightPositions();
        if (published) {
            for (const key of WEIGHT_KEYS)
                el(`wt-${key}`).value = published[key];
        }
        el("build-box").style.display = "block";
        describeMeta(meta);
    })
        .catch(() => {
        el("build-box").style.display = "none";
    });
}
/** Load the projects themselves, on first real use. */
let buildDataStarted = false;
function ensureBuildData() {
    if (buildDataStarted)
        return;
    buildDataStarted = true;
    el("build-list").textContent = "loading projects…";
    void dataReady
        .then(() => loadJson("priorities.geojson"))
        .then((fc) => {
        projectFC = fc;
        projects = fc.features
            .map((f) => f.properties)
            .filter((p) => p && typeof p.pid === "string");
        projectBounds.clear();
        for (const f of fc.features) {
            const pid = f.properties?.pid;
            if (pid === undefined)
                continue;
            const parts = f.geometry.type === "MultiLineString"
                ? f.geometry.coordinates.flat()
                : f.geometry.type === "LineString"
                    ? f.geometry.coordinates
                    : [];
            if (parts.length < 2)
                continue;
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
        const towns = new Set();
        for (const p of projects) {
            for (const t of p.towns.split(",")) {
                const name = t.trim();
                if (name && name !== "-")
                    towns.add(name);
            }
        }
        const select = el("build-town");
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
        el("build-list").textContent =
            "couldn't load the projects — check your connection and reopen this section";
        buildDataStarted = false;
    });
}
// wiring: the two toggles, the filter, the sliders, and the CSV
for (const [checkbox, layer] of [
    ["show-access", "access"],
    ["show-build", "build"],
]) {
    el(checkbox).addEventListener("change", (e) => {
        const on = e.target.checked;
        if (on)
            ensureLayer(layer);
        map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
        if (layer === "build") {
            // spot fixes ride with the projects: same list, drawn as points because a
            // 14 m line can't be seen or tapped at this zoom
            if (on) {
                ensureBuildData();
                ensureLayer("crossings");
            }
            else if (map.getLayer("build-selected")) {
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
function printProject(pid) {
    const p = projects.find((x) => x.pid === pid);
    if (!p)
        return;
    const meta = priorityMeta;
    const esc = (t) => t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
    const headcount = meta?.population?.is_headcount === true;
    const rows = [
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
    if (p.crashes !== null)
        rows.push(["Bike crashes since 2021", String(p.crashes)]);
    rows.push([
        "Cost, order of magnitude",
        `$${Math.round(p.cost_proxy).toLocaleString()} — a sorting proxy, not an estimate`,
    ]);
    const win = window.open("", "_blank");
    if (!win)
        return;
    win.document.write(`<html><head><title>${esc(p.name)} — where to build</title><style>
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
    </body></html>`);
    win.document.close();
    win.focus();
    win.print();
}
el("build-print").addEventListener("click", () => {
    if (selectedProject !== null)
        printProject(selectedProject);
});
el("whatif-run").addEventListener("click", () => {
    if (selectedProject !== null)
        void runWhatIf(selectedProject);
});
el("whatif-clear").addEventListener("click", clearWhatIf);
el("build-town").addEventListener("change", () => {
    selectedProject = null;
    if (map.getLayer("build-selected")) {
        map.setLayoutProperty("build-selected", "visibility", "none");
    }
    renderBuildList();
});
for (const key of WEIGHT_KEYS) {
    el(`wt-${key}`).addEventListener("input", renderBuildList);
}
el("wt-reset").addEventListener("click", () => {
    // back to the pipeline's own weighting, which the exported score used
    const defaults = publishedWeightPositions() ?? {
        severance: "40",
        access: "30",
        crash: "15",
        coverage: "15",
    };
    for (const key of WEIGHT_KEYS)
        el(`wt-${key}`).value = defaults[key];
    renderBuildList();
});
el("build-csv").addEventListener("click", () => {
    // the full ranking, not the top 20 on screen and not the town filter's slice
    const a = document.createElement("a");
    a.href = dataUrl("priorities.csv");
    a.download = "where-to-build.csv";
    a.click();
});
// clicking a project on the map selects it in the list, and the other way round
map.on("click", "build", (e) => {
    const pid = e.features?.[0]?.properties?.pid;
    if (pid !== undefined) {
        if (!el("build-box").open) {
            el("build-box").open = true;
        }
        focusProject(pid);
    }
});
map.on("click", "crossings", (e) => {
    const pid = e.features?.[0]?.properties?.pid;
    if (pid !== undefined) {
        if (!el("build-box").open) {
            el("build-box").open = true;
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
el("build-box").addEventListener("toggle", () => {
    if (el("build-box").open)
        ensureBuildData();
});
// at boot, only the 2 KB metadata: it decides whether the section exists
ensureBuildMeta();
