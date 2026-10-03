// Where a search's answers come from: what is already on the device, the street
// names the map knows, and the geocoder, which is asked last and no faster than it
// allows.

import { COVERAGE } from "../coverage.js";
import { type Candidate, matchScore, metresBetween } from "../search.js";
import { listPlaces, listRecent } from "../places.js";
import { store } from "./store.js";
import { POI_META } from "./classes.js";
import { netTiles } from "./data-load.js";
import { map } from "./map.js";

interface NominatimResult {
  display_name: string;
  lon: string;
  lat: string;
  /** jsonv2's short label ("Kendall/MIT"), when it has one: the full
   * display_name is five commas of address that no row has space for. */
  name?: string;
}

/** Everything already on the device that could answer a query.
 *
 * Assembled per keystroke rather than kept in an index: 2,500 POIs and a
 * viewport of streets is a few thousand string comparisons, which is nothing, and
 * an index would have to be invalidated every time a place is saved, a trip is
 * taken, or the map moves.
 */
export function localCandidates(): Candidate[] {
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
  for (const poi of store.pois) {
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
export function streetCandidates(query: string, origin: [number, number] | undefined): Candidate[] {
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
export const SEARCH_ROWS = 5;

/** Where distances are measured from: the start if set, else what you're looking at. */
export function searchOrigin(): [number, number] | undefined {
  const from = store.start?.getLngLat();
  if (from) return [from.lng, from.lat];
  const c = map.getCenter();
  return [c.lng, c.lat];
}


export async function searchAddress(query: string): Promise<NominatimResult[]> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1" +
    `&viewbox=${COVERAGE.west},${COVERAGE.north},${COVERAGE.east},${COVERAGE.south}` +
    `&q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`search failed (${resp.status})`);
  return (await resp.json()) as NominatimResult[];
}

/** Nominatim's answers as candidates, so one ranking covers every source. */
export function geocoderCandidates(results: NominatimResult[]): Candidate[] {
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
