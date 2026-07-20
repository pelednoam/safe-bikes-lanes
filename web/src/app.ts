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

import { Router } from "./router.js";
import type { ProtectionClass, RideMode, RouteSummary } from "./types.js";

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

const BBOX = { west: -71.18, south: 42.34, east: -71.05, north: 42.43 } as const;

// ---------------------------------------------------------------------------
// DOM helpers
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
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({}), "bottom-left");

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let router: Router | null = null;
let start: Marker | null = null;
let end: Marker | null = null;
let mode: RideMode = "kids";
let hoverPopup: Popup | null = null;

const routerReady: Promise<void> = Router.load("data/graph.json")
  .then((r) => {
    router = r;
    el<HTMLDivElement>("loading").style.display = "none";
  })
  .catch((err: unknown) => {
    const errBox = el<HTMLDivElement>("error");
    errBox.textContent = `failed to load routing graph: ${String(err)}`;
    errBox.style.display = "block";
  });
el<HTMLDivElement>("loading").textContent = "loading routing graph…";
el<HTMLDivElement>("loading").style.display = "block";

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
// routing (in-browser)
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
  // let the loading indicator paint before the (brief) synchronous search
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const s = start.getLngLat();
    const d = end.getLngLat();
    const data = router.route([s.lng, s.lat], [d.lng, d.lat], mode);
    getSource("route").setData(data.safest.geojson as GeoJSON.GeoJSON);
    getSource("shortest").setData(data.shortest.geojson as GeoJSON.GeoJSON);
    showSummary(data.safest.summary);
    updateHash();
  } catch (err) {
    errBox.textContent = err instanceof Error ? err.message : String(err);
    errBox.style.display = "block";
  } finally {
    loading.style.display = "none";
  }
}

function showSummary(s: RouteSummary): void {
  el<HTMLDivElement>("summary").style.display = "block";
  el<HTMLElement>("s-dist").textContent = fmtDist(s.meters);
  el<HTMLElement>("s-time").textContent = `~${s.minutes} min`;
  el<HTMLElement>("s-prot").textContent = `${s.pct_protected}%`;
  el<HTMLElement>("s-quiet").textContent = `${s.pct_quiet}%`;
  el<HTMLElement>("s-detour").textContent =
    (s.detour_pct ?? 0) <= 0
      ? "same"
      : `+${s.detour_pct}% (${fmtDist(s.shortest_meters ?? 0)})`;
  const bar = el<HTMLDivElement>("classbar");
  bar.innerHTML = "";
  for (const [cls, m] of Object.entries(s.by_class_m) as [ProtectionClass, number][]) {
    const seg = document.createElement("i");
    seg.style.cssText = `flex:${m};background:${CLASS_COLORS[cls] ?? "#999"}`;
    seg.title = `${CLASS_LABELS[cls] ?? cls}: ${fmtDist(m)}`;
    bar.appendChild(seg);
  }
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
    div.textContent = `⚠ ${c.name}: ${fmtDist(c.meters)} of ${CLASS_LABELS[c.cls] ?? c.cls}`;
    cautions.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// URL hash permalinks: #s=lon,lat&e=lon,lat&m=kids
// ---------------------------------------------------------------------------

function updateHash(): void {
  if (!start || !end) return;
  const s = start.getLngLat();
  const d = end.getLngLat();
  const h =
    `s=${s.lng.toFixed(6)},${s.lat.toFixed(6)}` +
    `&e=${d.lng.toFixed(6)},${d.lat.toFixed(6)}&m=${mode}`;
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
  if (m === "kids" || m === "solo") {
    mode = m;
    const radio = document.querySelector<HTMLInputElement>(`input[name=mode][value=${m}]`);
    if (radio) radio.checked = true;
  }
  const s = parse(params.get("s"));
  const e = parse(params.get("e"));
  if (s) setPoint("start", s);
  if (e) setPoint("end", e);
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
// layers + interaction wiring
// ---------------------------------------------------------------------------

map.on("load", () => {
  map.addSource("network", { type: "geojson", data: "data/network.geojson" });
  map.addLayer({
    id: "network",
    type: "line",
    source: "network",
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 3.5],
      "line-opacity": 0.75,
    },
  });
  map.addSource("shortest", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "shortest",
    type: "line",
    source: "shortest",
    layout: { visibility: "none" },
    paint: { "line-color": "#555", "line-width": 3, "line-dasharray": [2, 2] },
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

  // hover inspection on the network and the planned route
  for (const layer of ["network", "route"]) {
    map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "crosshair";
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as { cls?: ProtectionClass; name?: string; crashes?: number };
      const cls = props.cls;
      const label = cls !== undefined ? CLASS_LABELS[cls] ?? cls : "?";
      const crashes =
        props.crashes !== undefined && props.crashes > 0
          ? `<br>bike crashes nearby (2021-26): ${props.crashes}`
          : "";
      hoverPopup?.remove();
      hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(`<b>${props.name ?? "unnamed"}</b><br>${label}${crashes}`)
        .addTo(map);
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      hoverPopup?.remove();
      hoverPopup = null;
    });
  }

  parseHash();
});

map.on("click", (e: MapMouseEvent) => {
  if (!start) setPoint("start", e.lngLat);
  else if (!end) setPoint("end", e.lngLat);
});

el<HTMLButtonElement>("reset").addEventListener("click", () => {
  start?.remove();
  end?.remove();
  start = end = null;
  getSource("route").setData(emptyFC());
  getSource("shortest").setData(emptyFC());
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

el<HTMLInputElement>("show-net").addEventListener("change", (e: Event) => {
  const checked = (e.target as HTMLInputElement).checked;
  map.setLayoutProperty("network", "visibility", checked ? "visible" : "none");
});

el<HTMLInputElement>("show-short").addEventListener("change", (e: Event) => {
  const checked = (e.target as HTMLInputElement).checked;
  map.setLayoutProperty("shortest", "visibility", checked ? "visible" : "none");
});

for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=mode]")) {
  radio.addEventListener("change", () => {
    if (radio.checked && (radio.value === "kids" || radio.value === "solo")) {
      mode = radio.value;
      void requestRoute();
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
  if (e.key === "Escape") el<HTMLButtonElement>("reset").click();
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
