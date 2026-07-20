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

import { buildCues, PROFILES, Router, toGPX } from "./router.js";
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

const BBOX = { west: -71.18, south: 42.34, east: -71.05, north: 42.43 } as const;
const SKETCHY_KEY = "sketchyMarks";

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
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({}), "bottom-left");

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let router: Router | null = null;
let start: Marker | null = null;
let end: Marker | null = null;
let poiMarker: Marker | null = null;
let shedMarker: Marker | null = null;
let profileId: ProfileId = "young_kids";
let preferFlat = false;
let hoverPopup: Popup | null = null;
let options: RouteOption[] = [];
let selectedId: RouteOption["id"] | null = null;
let shedMode = false;
let shedCenter: [number, number] | null = null;
let sketchyMarks: [number, number][] = loadSketchy();
let pois: PoiFeature[] = [];
let loopParams: { km: number; kind: string } | null = null;
let pendingSelect: RouteOption["id"] | null = null;

const routerReady: Promise<void> = Router.load("data/graph.json")
  .then((r) => {
    router = r;
    router.setSketchyMarks(sketchyMarks);
    renderSketchy();
    el<HTMLDivElement>("loading").style.display = "none";
  })
  .catch((err: unknown) => {
    const errBox = el<HTMLDivElement>("error");
    errBox.textContent = `failed to load routing graph: ${String(err)}`;
    errBox.style.display = "block";
  });
el<HTMLDivElement>("loading").textContent = "loading routing graph…";
el<HTMLDivElement>("loading").style.display = "block";

const poisReady: Promise<void> = fetch("data/pois.geojson")
  .then((r) => (r.ok ? r.json() : { features: [] }))
  .then((fc: { features: PoiFeature[] }) => {
    pois = fc.features;
  })
  .catch(() => undefined);

function getSource(id: string): GeoJSONSource {
  const src = map.getSource(id);
  if (src === undefined) throw new Error(`missing source ${id}`);
  return src as GeoJSONSource;
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
    if (start) start.setLngLat(lngLat);
    else start = makeMarker(lngLat, "#2b83ba", "start");
  } else {
    if (end) end.setLngLat(lngLat);
    else end = makeMarker(lngLat, "#d7191c", "end");
  }
  void requestRoute();
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

async function requestRoute(): Promise<void> {
  if (!start || !end) return;
  await routerReady;
  if (!router) return;
  const errBox = el<HTMLDivElement>("error");
  errBox.style.display = "none";
  const loading = el<HTMLDivElement>("loading");
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
    if (!fallback) throw new Error("no route found");
    const wanted = pendingSelect;
    pendingSelect = null;
    selectOption(wanted !== null && options.some((o) => o.id === wanted) ? wanted : fallback.id);
  } catch (err) {
    options = [];
    selectedId = null;
    renderOptions();
    errBox.textContent = err instanceof Error ? err.message : String(err);
    errBox.style.display = "block";
  } finally {
    loading.style.display = "none";
  }
}

async function requestLoop(): Promise<void> {
  await routerReady;
  if (!router) return;
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
    const { option, poi } = router.loopRoute(
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
    rects.push(
      `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(wpx, 0.4).toFixed(2)}" height="12"` +
        ` fill="${CLASS_COLORS[seg.cls]}"><title>${CLASS_LABELS[seg.cls]}: ${fmtDist(seg.m)}</title></rect>`,
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
  el<HTMLElement>("s-time").textContent = `~${s.minutes} min`;
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
      const a = document.createElement("a");
      a.href = `https://maps.google.com/maps?q=&layer=c&cbll=${c.lat},${c.lon}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "street view";
      div.appendChild(a);
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
  const base = `s=${s.lng.toFixed(6)},${s.lat.toFixed(6)}&m=${profileId}` + (preferFlat ? "&f=1" : "");
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
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// safe-shed (reachability)
// ---------------------------------------------------------------------------

async function computeShed(): Promise<void> {
  if (!shedCenter) return;
  await routerReady;
  if (!router) return;
  const budgetKm = Number(el<HTMLInputElement>("shed-budget").value);
  el<HTMLSpanElement>("shed-budget-label").textContent = `${budgetKm} km`;
  const res = router.safeShed(shedCenter, budgetKm * 1000, profileId, preferFlat);
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
      router?.setSketchyMarks(sketchyMarks);
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
    map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "crosshair";
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as {
        cls?: ProtectionClass;
        name?: string;
        crashes?: number;
        source?: string;
      };
      const cls = props.cls;
      const label = cls !== undefined ? CLASS_LABELS[cls] ?? cls : "?";
      const crashes =
        props.crashes !== undefined && props.crashes > 0
          ? `<br>bike crashes nearby (2021-26): ${props.crashes}`
          : "";
      const unconfirmed =
        props.source === "osm" && cls !== undefined && FACILITY_CLASSES.includes(cls)
          ? "<br><i>facility per OSM only (not in official layers yet)</i>"
          : "";
      hoverPopup?.remove();
      hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${props.name ?? "unnamed"}</b><br>${label}${crashes}${unconfirmed}` +
            `<br><small>right-click to mark as sketchy</small>`,
        )
        .addTo(map);
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
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

  parseHash();
});

map.on("click", (e: MapMouseEvent) => {
  if (shedMode) {
    shedCenter = [e.lngLat.lng, e.lngLat.lat];
    void computeShed();
    return;
  }
  if (!start) setPoint("start", e.lngLat);
  else if (!end) setPoint("end", e.lngLat);
});

// touch devices have no right-click: a long-press on a street opens the
// same "mark sketchy" popup
function openSketchyPopup(lngLat: [number, number]): void {
  const btn = document.createElement("button");
  btn.textContent = "⚠ mark this spot as sketchy";
  const popup = new maplibregl.Popup().setLngLat(lngLat).setDOMContent(btn).addTo(map);
  btn.addEventListener("click", () => {
    sketchyMarks.push(lngLat);
    saveSketchy(sketchyMarks);
    router?.setSketchyMarks(sketchyMarks);
    renderSketchy();
    popup.remove();
    void requestRoute();
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
      layers: ["network", "network-unconfirmed", "route"].filter((l) => map.getLayer(l)),
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

// collapsible panel for small screens
el<HTMLButtonElement>("panel-collapse").addEventListener("click", () => {
  const panel = el<HTMLDivElement>("panel");
  const collapsed = panel.classList.toggle("collapsed");
  el<HTMLButtonElement>("panel-collapse").textContent = collapsed ? "▴" : "▾";
});

el<HTMLButtonElement>("reset").addEventListener("click", () => {
  start?.remove();
  end?.remove();
  poiMarker?.remove();
  start = end = poiMarker = null;
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

for (const [checkboxId, layers] of [
  ["show-net", ["network", "network-unconfirmed"]],
  ["show-pois", ["pois"]],
  ["show-gates", ["gateways"]],
] as [string, string[]][]) {
  el<HTMLInputElement>(checkboxId).addEventListener("change", (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked;
    for (const layer of layers) {
      map.setLayoutProperty(layer, "visibility", checked ? "visible" : "none");
    }
  });
}

el<HTMLInputElement>("prefer-flat").addEventListener("change", (e: Event) => {
  preferFlat = (e.target as HTMLInputElement).checked;
  void requestRoute();
  void computeShed();
});

// the two area overlays are mutually exclusive to stay readable; in 3D view
// the extruded variants replace the flat fills and terrain turns on
function syncOverlays(): void {
  const threeD = el<HTMLInputElement>("show-3d").checked;
  const heat = el<HTMLInputElement>("show-heat").checked;
  const elev = el<HTMLInputElement>("show-elev").checked;
  const vis = (on: boolean): "visible" | "none" => (on ? "visible" : "none");
  map.setLayoutProperty("heatmap", "visibility", vis(heat && !threeD));
  map.setLayoutProperty("heatmap-3d", "visibility", vis(heat && threeD));
  map.setLayoutProperty("elevmap", "visibility", vis(elev && !threeD));
  map.setLayoutProperty("elevmap-3d", "visibility", vis(elev && threeD));
}

el<HTMLInputElement>("show-heat").addEventListener("change", (e: Event) => {
  if ((e.target as HTMLInputElement).checked) {
    el<HTMLInputElement>("show-elev").checked = false;
  }
  syncOverlays();
});

el<HTMLInputElement>("show-elev").addEventListener("change", (e: Event) => {
  if ((e.target as HTMLInputElement).checked) {
    el<HTMLInputElement>("show-heat").checked = false;
  }
  syncOverlays();
});

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
    if (el<HTMLDialogElement>("about").open) return; // dialog handles it
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
  void fetch("data/meta.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((meta: DataMeta | null) => {
      if (!meta) return;
      el<HTMLElement>("built-date").textContent = meta.built;
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

el<HTMLButtonElement>("about-btn").addEventListener("click", () => {
  fillAbout();
  el<HTMLDialogElement>("about").showModal();
});
el<HTMLButtonElement>("about-close").addEventListener("click", () => {
  el<HTMLDialogElement>("about").close();
});
el<HTMLDialogElement>("about").addEventListener("click", (e: MouseEvent) => {
  if (e.target === el<HTMLDialogElement>("about")) el<HTMLDialogElement>("about").close();
});

// offline support (PWA)
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("sw.js");
}
