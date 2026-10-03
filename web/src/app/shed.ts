// The reach map: everywhere a child can ride to from a point within a budget, and
// its marker and slider.

import { type Marker } from "maplibre-gl";
import { store } from "./store.js";
import { routing, shedLane } from "./services.js";
import { ensureRouter, manifestReady } from "./data-load.js";
import { el, emptyFC } from "./dom.js";
import { fmtDist, fmtDistTight } from "../units.js";
import { getSource } from "./sources.js";
import { maplibregl } from "../maplibre.js";
import { map } from "./map.js";

let shedMarker: Marker | null = null;

/** The reach map for the current centre and budget.
 *
 * The slider fires on every step of a drag, and a bigger budget waits on more
 * tiles than a smaller one — so the flood for a budget already let go of used to
 * finish last and paint over the one asked for. And closing the reach map while
 * one waited left it to resume with no centre at all, which crashed. Each call
 * now owns the reach map only until the next one starts, or the map is closed. */
export async function computeShed(): Promise<void> {
  const center = store.shedCenter;
  if (!center) return;
  const ticket = shedLane.begin();
  await manifestReady;
  if (ticket.stale()) return;
  const budgetKm = Number(el<HTMLInputElement>("shed-budget").value);
  el<HTMLSpanElement>("shed-budget-label").textContent = fmtDistTight(budgetKm * 1000);
  // the flood can reach out to the full budget radius from the center
  const mapped = await ensureRouter([center], budgetKm * 1000, 2);
  if (ticket.stale() || !store.shedMode || !mapped) return;
  const res = await routing.safeShed(center, budgetKm * 1000, store.profileId, store.preferFlat);
  if (ticket.stale() || !store.shedMode) return;
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

export function exitShedMode(): void {
  shedLane.cancel(); // a flood still loading tiles is for a map no longer open
  store.shedMode = false;
  store.shedCenter = null;
  shedMarker?.remove();
  shedMarker = null;
  getSource("shed").setData(emptyFC());
  el<HTMLDivElement>("shed-panel").style.display = "none";
  el<HTMLButtonElement>("shed-btn").textContent = "🗺 Reach map";
  el<HTMLDivElement>("shed-info").textContent = "";
}

export function initShed(): void {
  el<HTMLButtonElement>("shed-btn").addEventListener("click", () => {
    if (store.shedMode) {
      exitShedMode();
      return;
    }
    store.shedMode = true;
    el<HTMLButtonElement>("shed-btn").textContent = "✕ Exit reach map";
    el<HTMLDivElement>("shed-panel").style.display = "block";
    el<HTMLDivElement>("shed-info").textContent =
      "click the map (e.g. home) to see everything reachable at your comfort level";
  });

  el<HTMLInputElement>("shed-budget").addEventListener("input", () => {
    void computeShed();
  });
}
