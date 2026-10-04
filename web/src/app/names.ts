// What a place is called: the name the rider typed, or the street the map is over,
// looked up once and kept.
//
// A permalink (or a tap on the map) sets a destination that has no name, and
// the field sat empty: the trip was drawn but the panel couldn't say where to,
// and the voice announced "you have arrived" at nowhere in particular. Ask
// Nominatim once per spot, remember the answer, and never make routing wait
// for it — a name is a nicety, the route is the product.

import { readJson, trimRecord, writeItem } from "../storage.js";
import { store } from "./store.js";
import { routing } from "./services.js";
import { el } from "./dom.js";

const REVGEO_KEY = "bike-revgeo-v1";

/** Which fields we filled in ourselves, and may therefore overwrite. */
export const autoNamed = { start: false, end: false };

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

/** Whether the router has a graph, waiting up to `ms` for one. */
async function withRouter(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!store.routerReady && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
  }
  return store.routerReady;
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
  const local = (await withRouter(10_000)) ? await routing.streetNameAt(lon, lat, 20) : null;
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
export function nameEnd(kind: "start" | "end"): void {
  const marker = kind === "start" ? store.start : store.end;
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
      const now = kind === "start" ? store.start : store.end;
      if (!now) return;
      const p = now.getLngLat();
      if (revKey(p.lng, p.lat) !== asked) return;
      if (field.value.trim() !== "") return;
      field.value = label;
      autoNamed[kind] = true;
    })
    .catch(() => undefined); // offline, or Nominatim rate-limiting us
}
