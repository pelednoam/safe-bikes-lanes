import { bearingDeg, buildAlerts, buildManeuvers, buildTrack, distM, snapToTrack, sunsetTime, trackBearing, } from "./nav.js";
import { addHazard, buildReportText, downscalePhoto, getHazardPhoto, HAZARD_LABELS, listHazards, removeHazard, } from "./hazards.js";
import { clearRides, deleteRide, loadRides, RideRecorder, rideTotals, saveRide, } from "./rides.js";
import { buildCues, PROFILES, Router, toGPX } from "./router.js";
import { drawRideCard, drawTotalsCard, rideShareText, totalsShareText } from "./sharecard.js";
// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
const CLASS_LABELS = {
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
const GRADE_COLORS = {
    A: "#1a9850",
    B: "#66bd63",
    C: "#fdae61",
    D: "#f46d43",
    F: "#d73027",
};
const POI_META = {
    playground: { emoji: "🛝", label: "playground", color: "#e67e22" },
    ice_cream: { emoji: "🍦", label: "ice cream", color: "#e84393" },
    library: { emoji: "📚", label: "library", color: "#8e44ad" },
    water: { emoji: "🚰", label: "water fountain", color: "#2980b9" },
    restroom: { emoji: "🚻", label: "restroom", color: "#7f8c8d" },
};
const BBOX = { west: -71.18, south: 42.34, east: -71.05, north: 42.43 };
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
function fmtDist(m) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
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
}
// ---------------------------------------------------------------------------
// map setup
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
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
let start = null;
let end = null;
let poiMarker = null;
let shedMarker = null;
let profileId = "young_kids";
let preferFlat = false;
let hoverPopup = null;
let options = [];
let selectedId = null;
let shedMode = false;
let shedCenter = null;
let sketchyMarks = loadSketchy();
let pois = [];
let hazards = [];
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
const routerReady = Router.load("data/graph.json")
    .then((r) => {
    router = r;
    applyAvoidPoints();
    renderSketchy();
    void refreshHazards();
    el("loading").style.display = "none";
})
    .catch((err) => {
    const errBox = el("error");
    errBox.textContent = `failed to load routing graph: ${String(err)}`;
    errBox.style.display = "block";
});
el("loading").textContent = "loading routing graph…";
el("loading").style.display = "block";
const poisReady = fetch("data/pois.geojson")
    .then((r) => (r.ok ? r.json() : { features: [] }))
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
function makeMarker(lngLat, color, label) {
    const m = new maplibregl.Marker({ color, draggable: true });
    m.setLngLat(lngLat).addTo(map);
    m.getElement().title = `${label} (drag to move)`;
    m.on("dragend", () => {
        void requestRoute();
    });
    return m;
}
function setPoint(kind, lngLat) {
    if (kind === "start") {
        if (start)
            start.setLngLat(lngLat);
        else
            start = makeMarker(lngLat, "#2b83ba", "start");
    }
    else {
        if (end)
            end.setLngLat(lngLat);
        else
            end = makeMarker(lngLat, "#d7191c", "end");
    }
    void requestRoute();
}
// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------
async function requestRoute() {
    if (!start || !end)
        return;
    await routerReady;
    if (!router)
        return;
    const errBox = el("error");
    errBox.style.display = "none";
    const loading = el("loading");
    loading.textContent = "routing…";
    loading.style.display = "block";
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const s = start.getLngLat();
        const d = end.getLngLat();
        poiMarker?.remove();
        poiMarker = null;
        loopParams = null;
        options = router.routeOptions([s.lng, s.lat], [d.lng, d.lat], profileId, preferFlat);
        const fallback = options[0];
        if (!fallback)
            throw new Error("no route found");
        const wanted = pendingSelect;
        pendingSelect = null;
        selectOption(wanted !== null && options.some((o) => o.id === wanted) ? wanted : fallback.id);
    }
    catch (err) {
        options = [];
        selectedId = null;
        renderOptions();
        errBox.textContent = err instanceof Error ? err.message : String(err);
        errBox.style.display = "block";
    }
    finally {
        loading.style.display = "none";
    }
}
async function requestLoop() {
    await routerReady;
    if (!router)
        return;
    const errBox = el("error");
    errBox.style.display = "none";
    if (!start) {
        errBox.textContent = "click the map to set a start point first";
        errBox.style.display = "block";
        return;
    }
    await poisReady;
    const km = Number(el("loop-dist").value);
    const kind = el("loop-stop").value;
    const candidates = kind === "any" ? pois : pois.filter((p) => p.properties.kind === kind);
    const loading = el("loading");
    loading.textContent = "planning loop…";
    loading.style.display = "block";
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        const s = start.getLngLat();
        const { option, poi } = router.loopRoute([s.lng, s.lat], km * 1000, candidates, profileId, preferFlat);
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
    }
    catch (err) {
        errBox.textContent = err instanceof Error ? err.message : String(err);
        errBox.style.display = "block";
    }
    finally {
        loading.style.display = "none";
    }
}
function selectOption(id) {
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
    renderOptions();
    showSummary(chosen);
    updateHash();
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
        rects.push(`<rect x="${x.toFixed(2)}" y="0" width="${Math.max(wpx, 0.4).toFixed(2)}" height="12"` +
            ` fill="${CLASS_COLORS[seg.cls]}"><title>${CLASS_LABELS[seg.cls]}: ${fmtDist(seg.m)}</title></rect>`);
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
            `<text x="0" y="40" font-size="8" fill="#999">${Math.round(eMax)} m</text>` +
            `<text x="0" y="68" font-size="8" fill="#999">${Math.round(eMin)} m</text>` +
            `</svg>`;
}
function showSummary(option) {
    const s = option.payload.summary;
    el("summary").style.display = "block";
    el("s-dist").textContent = fmtDist(s.meters);
    el("s-time").textContent = `~${s.minutes} min`;
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
            const a = document.createElement("a");
            a.href = `https://maps.google.com/maps?q=&layer=c&cbll=${c.lat},${c.lon}`;
            a.target = "_blank";
            a.rel = "noopener";
            a.textContent = "street view";
            div.appendChild(a);
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
        .map((c) => `<tr><td>${c.km.toFixed(1)} km</td><td>${c.text}</td></tr>`)
        .join("");
    const cautionRows = s.cautions
        .map((c) => `<li>⚠ ${c.name}: ${fmtDist(c.meters)} of ${CLASS_LABELS[c.cls] ?? c.cls}</li>`)
        .join("");
    const win = window.open("", "_blank");
    if (!win)
        return;
    win.document.write(`<html><head><title>Cue sheet</title><style>
      body{font-family:sans-serif;font-size:13px;max-width:520px;margin:20px auto}
      table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:3px 6px}
      td:first-child{white-space:nowrap;font-variant-numeric:tabular-nums}
    </style></head><body>
    <h2>Family bike route — ${sel.label}</h2>
    <p>${fmtDist(s.meters)} · ~${s.minutes} min · ${s.pct_protected}% protected · climb ${s.climb_m ?? 0} m</p>
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
    const base = `s=${s.lng.toFixed(6)},${s.lat.toFixed(6)}&m=${profileId}` + (preferFlat ? "&f=1" : "");
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
            el("loop-dist").value = String(km);
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
// address search (Nominatim, bounded to our area)
// ---------------------------------------------------------------------------
async function searchAddress(query) {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1" +
        `&viewbox=${BBOX.west},${BBOX.north},${BBOX.east},${BBOX.south}` +
        `&q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok)
        throw new Error(`search failed (${resp.status})`);
    return (await resp.json());
}
function renderSearchResults(results) {
    const box = el("search-results");
    box.innerHTML = "";
    if (results.length === 0) {
        box.textContent = "no results in Cambridge/Somerville";
        return;
    }
    for (const r of results) {
        const row = document.createElement("div");
        row.className = "search-row";
        const name = document.createElement("span");
        name.textContent = r.display_name.split(",").slice(0, 3).join(",");
        name.title = r.display_name;
        row.appendChild(name);
        const lngLat = [parseFloat(r.lon), parseFloat(r.lat)];
        for (const kind of ["start", "end"]) {
            const btn = document.createElement("button");
            btn.textContent = kind;
            btn.addEventListener("click", () => {
                setPoint(kind, lngLat);
                map.flyTo({ center: lngLat, zoom: 15 });
                box.innerHTML = "";
            });
            row.appendChild(btn);
        }
        box.appendChild(row);
    }
}
// ---------------------------------------------------------------------------
// safe-shed (reachability)
// ---------------------------------------------------------------------------
async function computeShed() {
    if (!shedCenter)
        return;
    await routerReady;
    if (!router)
        return;
    const budgetKm = Number(el("shed-budget").value);
    el("shed-budget-label").textContent = `${budgetKm} km`;
    const res = router.safeShed(shedCenter, budgetKm * 1000, profileId, preferFlat);
    getSource("shed").setData(res.geojson);
    el("shed-info").textContent =
        `${res.reachableKm} km of streets reachable (${res.pctReachable}% of the network) ` +
            `within a perceived ${budgetKm} km`;
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
    map.addSource("heatmap", { type: "geojson", data: "data/heatmap.geojson" });
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
    map.addSource("elevmap", { type: "geojson", data: "data/elevation.geojson" });
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
    map.addSource("network", { type: "geojson", data: "data/network.geojson" });
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
    map.addSource("route", { type: "geojson", data: emptyFC() });
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
    map.addSource("gateways", { type: "geojson", data: "data/gateways.geojson" });
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
    map.addSource("pois", { type: "geojson", data: "data/pois.geojson" });
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
    // hover inspection on the network and the planned route
    for (const layer of ["network", "network-unconfirmed", "route"]) {
        map.on("mousemove", layer, (e) => {
            map.getCanvas().style.cursor = "crosshair";
            const f = e.features?.[0];
            if (!f)
                return;
            const props = f.properties;
            const cls = props.cls;
            const label = cls !== undefined ? CLASS_LABELS[cls] ?? cls : "?";
            const crashes = props.crashes !== undefined && props.crashes > 0
                ? `<br>bike crashes nearby (2021-26): ${props.crashes}`
                : "";
            const unconfirmed = props.source === "osm" && cls !== undefined && FACILITY_CLASSES.includes(cls)
                ? "<br><i>facility per OSM only (not in official layers yet)</i>"
                : "";
            hoverPopup?.remove();
            hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
                .setLngLat(e.lngLat)
                .setHTML(`<b>${props.name ?? "unnamed"}</b><br>${label}${crashes}${unconfirmed}` +
                `<br><small>right-click to mark as sketchy</small>`)
                .addTo(map);
        });
        map.on("mouseleave", layer, () => {
            map.getCanvas().style.cursor = "";
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
            .setHTML(`${meta?.emoji ?? ""} <b>${props.name || meta?.label || "?"}</b>`)
            .addTo(map);
    });
    map.on("mousemove", "elevmap", (e) => {
        const f = e.features?.[0];
        if (!f)
            return;
        const props = f.properties;
        if (props.elev === undefined)
            return;
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
    parseHash();
});
map.on("click", (e) => {
    if (shedMode) {
        shedCenter = [e.lngLat.lng, e.lngLat.lat];
        void computeShed();
        return;
    }
    if (!start)
        setPoint("start", e.lngLat);
    else if (!end)
        setPoint("end", e.lngLat);
});
// touch devices have no right-click: a long-press on a street opens the
// same "mark sketchy" popup
function openSketchyPopup(lngLat) {
    const box = document.createElement("div");
    const btn = document.createElement("button");
    btn.textContent = "⚠ mark this spot as sketchy";
    box.appendChild(btn);
    const report = document.createElement("button");
    report.textContent = "📷 report hazard…";
    box.appendChild(report);
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
            layers: ["network", "network-unconfirmed", "route"].filter((l) => map.getLayer(l)),
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
// collapsible panel for small screens
el("panel-collapse").addEventListener("click", () => {
    const panel = el("panel");
    const collapsed = panel.classList.toggle("collapsed");
    el("panel-collapse").textContent = collapsed ? "▴" : "▾";
});
el("reset").addEventListener("click", () => {
    start?.remove();
    end?.remove();
    poiMarker?.remove();
    start = end = poiMarker = null;
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
    void requestRoute();
});
el("loop-btn").addEventListener("click", () => {
    void requestLoop();
});
for (const [checkboxId, layers] of [
    ["show-net", ["network", "network-unconfirmed"]],
    ["show-pois", ["pois"]],
    ["show-gates", ["gateways"]],
]) {
    el(checkboxId).addEventListener("change", (e) => {
        const checked = e.target.checked;
        for (const layer of layers) {
            map.setLayoutProperty(layer, "visibility", checked ? "visible" : "none");
        }
    });
}
el("prefer-flat").addEventListener("change", (e) => {
    preferFlat = e.target.checked;
    void requestRoute();
    void computeShed();
});
// the two area overlays are mutually exclusive to stay readable; in 3D view
// the extruded variants replace the flat fills and terrain turns on
function syncOverlays() {
    const threeD = el("show-3d").checked;
    const heat = el("show-heat").checked;
    const elev = el("show-elev").checked;
    const vis = (on) => (on ? "visible" : "none");
    map.setLayoutProperty("heatmap", "visibility", vis(heat && !threeD));
    map.setLayoutProperty("heatmap-3d", "visibility", vis(heat && threeD));
    map.setLayoutProperty("elevmap", "visibility", vis(elev && !threeD));
    map.setLayoutProperty("elevmap-3d", "visibility", vis(elev && threeD));
}
el("show-heat").addEventListener("change", (e) => {
    if (e.target.checked) {
        el("show-elev").checked = false;
    }
    syncOverlays();
});
el("show-elev").addEventListener("change", (e) => {
    if (e.target.checked) {
        el("show-heat").checked = false;
    }
    syncOverlays();
});
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
        }
    });
}
const searchInput = el("search");
let searchTimer;
searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 3) {
        el("search-results").innerHTML = "";
        return;
    }
    searchTimer = window.setTimeout(() => {
        searchAddress(q)
            .then(renderSearchResults)
            .catch(() => {
            el("search-results").textContent = "search unavailable";
        });
    }, 400);
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (el("about").open ||
            el("rides").open ||
            el("hazard").open) {
            return; // dialogs handle it
        }
        if (shedMode)
            exitShedMode();
        else
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
    void fetch("data/meta.json")
        .then((r) => (r.ok ? r.json() : null))
        .then((meta) => {
        if (!meta)
            return;
        el("built-date").textContent = meta.built;
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
        `at ${lat.toFixed(5)}, ${lon.toFixed(5)} — saved reports appear on the map and routes avoid them`;
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
el("hazard-share").addEventListener("click", () => {
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
el("nav-report").addEventListener("click", () => {
    if (navLastPos)
        openHazardDialog(navLastPos[0], navLastPos[1]);
});
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
            : `<b>${totals.count}</b> rides · <b>${totals.km} km</b> total · ` +
                `<b>${totals.movingHours} h</b> moving · longest <b>${totals.longestKm} km</b> · ` +
                `this month <b>${totals.thisMonthKm} km</b> · avg <b>${totals.avgProtectedPct}%</b> protected`;
    el("rides-share").style.display = rides.length === 0 ? "none" : "inline-block";
    const table = el("ride-list");
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
el("about-btn").addEventListener("click", () => {
    fillAbout();
    el("about").showModal();
});
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
const ANNOUNCE_FAR_M = 90;
const ANNOUNCE_NOW_M = 25;
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
let recorder = null;
let recordMode = false;
let recordWatchId = null;
/** Free-record auto-stop: end the ride after this long with no movement. */
const RECORD_IDLE_STOP_MS = 10 * 60000;
function finishAndSaveRide() {
    const ride = recorder?.finish(profileId);
    recorder = null;
    if (!ride)
        return;
    saveRide(ride);
    speak(`ride saved. ${(ride.meters / 1000).toFixed(1)} kilometers.`);
}
function vibrate(pattern) {
    if ("vibrate" in navigator)
        navigator.vibrate(pattern);
}
function speak(text) {
    if (navMuted || !("speechSynthesis" in window))
        return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    window.speechSynthesis.speak(utter);
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
function navUpdateBanner(distToNext, remainingM) {
    const m = navManeuvers[navNext];
    el("nav-icon").textContent = m?.icon ?? "⬆";
    el("nav-dist").textContent =
        distToNext < 15 ? "now" : fmtDist(Math.round(distToNext / 10) * 10);
    el("nav-street").textContent = m?.text ?? "";
    const mins = Math.round((remainingM / 1000 / PROFILES[profileId].paceKmh) * 60);
    el("nav-remaining").textContent =
        `${fmtDist(remainingM)} to go · ~${mins} min`;
}
function navOnPosition(pos) {
    if (!navActive || !navTrack || !router)
        return;
    const lon = pos.coords.longitude;
    const lat = pos.coords.latitude;
    navLastPos = [lon, lat];
    // travel direction: GPS heading when moving, else derived from movement
    const gpsHeading = pos.coords.heading;
    if (gpsHeading !== null && !Number.isNaN(gpsHeading) && (pos.coords.speed ?? 0) > 0.7) {
        navHeading = gpsHeading;
    }
    else if (navPrevPos && distM(navPrevPos, [lon, lat]) > 5) {
        navHeading = (bearingDeg(navPrevPos, [lon, lat]) + 360) % 360;
    }
    if (!navPrevPos || distM(navPrevPos, [lon, lat]) > 3)
        navPrevPos = [lon, lat];
    recorder?.addPoint(Date.now(), lon, lat, router.edgeClassAt(lon, lat));
    if (!navDot) {
        const dot = document.createElement("div");
        dot.className = "nav-dot";
        navDot = new maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(map);
    }
    else {
        navDot.setLngLat([lon, lat]);
    }
    const snap = snapToTrack(navTrack, lon, lat, navHint);
    // off-route: a few good fixes in a row trigger a reroute to the destination
    // (like Google Maps — ride wherever you like, the route follows you)
    if (snap.offM > OFF_ROUTE_M) {
        // a poor GPS fix shouldn't count as a deviation
        if (pos.coords.accuracy > MAX_GPS_ACCURACY_M)
            return;
        navOffCount++;
        // instant feedback while we make sure it's a real deviation
        el("nav-icon").textContent = "↩";
        el("nav-dist").textContent = "off route";
        el("nav-street").textContent = "adjusting…";
        const now = Date.now();
        if (navOffCount >= OFF_ROUTE_STRIKES && navDest && now - navLastRerouteAt > REROUTE_COOLDOWN_MS) {
            navOffCount = 0;
            navLastRerouteAt = now;
            const useMyWay = navMyWay && navHeading !== null;
            speak(useMyWay ? "okay, going your way." : "rerouting.");
            vibrate([80, 60, 80]);
            try {
                const bias = useMyWay && navHeading !== null
                    ? router.headingBias([lon, lat], navHeading)
                    : undefined;
                options = router.routeOptions([lon, lat], navDest, profileId, preferFlat, bias);
                const first = options[0];
                if (first) {
                    selectOption(first.id);
                    rebuildNavFromSelected();
                }
            }
            catch {
                el("nav-street").textContent = "off route — can't reroute here";
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
    }
    else if (next && navAnnounceStage < 1 && distToNext <= ANNOUNCE_FAR_M) {
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
            el("nav-dist").textContent = "🛑";
            el("nav-street").textContent = "at the stop — resume when ready";
            el("nav-resume").style.display = "inline-block";
        }
        else {
            speak(`you have arrived. ${(navTrack.totalM / 1000).toFixed(1)} kilometers — nicely done!`);
            el("nav-dist").textContent = "🏁";
            el("nav-street").textContent = "arrived!";
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
async function startNav() {
    if (!rebuildNavFromSelected())
        return;
    const destLngLat = end?.getLngLat() ?? start?.getLngLat();
    if (!destLngLat)
        return;
    navDest = [destLngLat.lng, destLngLat.lat];
    navOriginalDest = null;
    el("nav-resume").style.display = "none";
    navActive = true;
    navFollowing = true;
    recorder = new RideRecorder();
    document.body.classList.add("navigating");
    el("nav-banner").style.display = "block";
    el("nav-recenter").style.display = "none";
    try {
        wakeLock = await navigator.wakeLock.request("screen");
    }
    catch {
        wakeLock = null; // unsupported or denied — navigation still works
    }
    navWatchId = navigator.geolocation.watchPosition(navOnPosition, () => {
        el("nav-street").textContent = "location unavailable — check permissions";
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    speak("navigation started");
}
function exitNav() {
    finishAndSaveRide();
    navActive = false;
    navOriginalDest = null;
    navLastPos = null;
    if (navWatchId !== null)
        navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
    void wakeLock?.release().catch(() => undefined);
    wakeLock = null;
    navDot?.remove();
    navDot = null;
    if ("speechSynthesis" in window)
        window.speechSynthesis.cancel();
    document.body.classList.remove("navigating");
    el("nav-banner").style.display = "none";
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
        options = router.routeOptions(navLastPos, poi.geometry.coordinates, profileId, preferFlat);
        const first = options[0];
        if (!first)
            return;
        selectOption(first.id);
        if (navOriginalDest === null)
            navOriginalDest = navDest;
        navDest = poi.geometry.coordinates;
        rebuildNavFromSelected();
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
        options = router.routeOptions(navLastPos, navOriginalDest, profileId, preferFlat);
        const first = options[0];
        if (!first)
            return;
        selectOption(first.id);
        navDest = navOriginalDest;
        navOriginalDest = null;
        rebuildNavFromSelected();
        el("nav-resume").style.display = "none";
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
    if (!navLastPos)
        return;
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
function recordOnPosition(pos) {
    if (!recordMode || !recorder)
        return;
    const lon = pos.coords.longitude;
    const lat = pos.coords.latitude;
    navLastPos = [lon, lat];
    if (!navDot) {
        const dot = document.createElement("div");
        dot.className = "nav-dot";
        navDot = new maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(map);
    }
    else {
        navDot.setLngLat([lon, lat]);
    }
    recorder.addPoint(Date.now(), lon, lat, router?.edgeClassAt(lon, lat) ?? null);
    el("nav-dist").textContent = fmtDist(recorder.metersSoFar);
    const mins = Math.round(recorder.durationSoFar / 60);
    el("nav-remaining").textContent = `recording · ${mins} min`;
    if (navFollowing) {
        map.easeTo({ center: [lon, lat], zoom: 16, duration: 900 });
    }
    if (Date.now() - recorder.lastMovedAt > RECORD_IDLE_STOP_MS) {
        speak("no movement for a while.");
        stopRecording();
    }
}
function startRecording() {
    if (navActive || recordMode)
        return;
    recordMode = true;
    recorder = new RideRecorder();
    navFollowing = true;
    document.body.classList.add("navigating");
    el("nav-banner").style.display = "block";
    el("nav-tools").style.display = "none";
    el("nav-icon").textContent = "🔴";
    el("nav-dist").textContent = "0 m";
    el("nav-street").textContent = "recording ride…";
    el("nav-remaining").textContent = "";
    void navigator.wakeLock
        ?.request("screen")
        .then((wl) => {
        wakeLock = wl;
    })
        .catch(() => undefined);
    recordWatchId = navigator.geolocation.watchPosition(recordOnPosition, () => {
        el("nav-street").textContent = "location unavailable — check permissions";
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    speak("recording. ride on!");
}
function stopRecording() {
    if (!recordMode)
        return;
    recordMode = false;
    if (recordWatchId !== null)
        navigator.geolocation.clearWatch(recordWatchId);
    recordWatchId = null;
    finishAndSaveRide();
    void wakeLock?.release().catch(() => undefined);
    wakeLock = null;
    navDot?.remove();
    navDot = null;
    navLastPos = null;
    document.body.classList.remove("navigating");
    el("nav-banner").style.display = "none";
    el("nav-tools").style.display = "block";
}
el("record-btn").addEventListener("click", () => {
    if (recordMode)
        stopRecording();
    else
        startRecording();
});
el("nav-btn").addEventListener("click", () => {
    void startNav();
});
el("nav-exit").addEventListener("click", () => {
    if (recordMode)
        stopRecording();
    else
        exitNav();
});
el("nav-mute").addEventListener("click", () => {
    navMuted = !navMuted;
    el("nav-mute").textContent = navMuted ? "🔇" : "🔊";
    if (navMuted && "speechSynthesis" in window)
        window.speechSynthesis.cancel();
});
el("nav-recenter").addEventListener("click", () => {
    navFollowing = true;
    el("nav-recenter").style.display = "none";
});
map.on("dragstart", () => {
    if (navActive) {
        navFollowing = false;
        el("nav-recenter").style.display = "inline-block";
    }
});
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
    const dark = document.body.classList.contains("dark");
    const template = dark
        ? "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
        : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    const urls = new Set();
    for (const z of [13, 14, 15, 16]) {
        // sample the track densely enough that no tile is skipped at this zoom
        const stepM = z >= 16 ? 150 : 400;
        let nextAt = 0;
        track.coords.forEach((c, i) => {
            if ((track.cumM[i] ?? 0) < nextAt && i !== track.coords.length - 1)
                return;
            nextAt = (track.cumM[i] ?? 0) + stepM;
            const [x, y] = tileXY(c[0], c[1], z);
            const spread = z >= 15 ? 1 : 0; // 3x3 corridor at high zooms
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
                        const resp = await fetch(url, { mode: "no-cors" });
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
function applyDark(dark) {
    document.body.classList.toggle("dark", dark);
    el("dark-mode").checked = dark;
    const setVis = () => {
        map.setLayoutProperty("osm-dark", "visibility", dark ? "visible" : "none");
        map.setLayoutProperty("osm", "visibility", dark ? "none" : "visible");
        map.setPaintProperty("route-casing", "line-color", dark ? "#9db8ff" : "#1440a0");
        map.setPaintProperty("alts", "line-color", dark ? "#aaa" : "#777");
    };
    if (map.loaded())
        setVis();
    else
        map.once("load", setVis);
}
const storedDark = localStorage.getItem(DARK_KEY);
const initialDark = storedDark !== null
    ? storedDark === "1"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
applyDark(initialDark);
el("dark-mode").addEventListener("change", (e) => {
    const dark = e.target.checked;
    localStorage.setItem(DARK_KEY, dark ? "1" : "0");
    applyDark(dark);
});
// offline support (PWA)
if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("sw.js");
}
