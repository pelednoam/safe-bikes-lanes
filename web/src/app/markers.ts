// The two ends of the trip on the map: the markers, setting a point, the rider's
// own position, and keeping the start and end fields in step.

import { store } from "./store.js";
import { nativeLocationAllowed } from "../native.js";
import { map } from "./map.js";
import { links } from "./links.js";
import { el } from "./dom.js";
import { type LngLat, type Marker } from "maplibre-gl";
import { maplibregl } from "../maplibre.js";
import { nameEnd } from "./names.js";

export function currentPosition(): Promise<[number, number]> {
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
export async function locateIfAlreadyAllowed(): Promise<void> {
  if (!store.fromCurrent || store.start !== null || !navigator.geolocation) return;
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
    if (!store.fromCurrent || store.start !== null) return; // the rider got there first
    store.start = makeMarker(at, "#2b83ba", "start");
    syncOD();
    map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 14), duration: 600 });
  } catch {
    // no position, revoked between the check and the call, or simply slow:
    // the on-demand path still runs when a route is asked for
  }
}

export function syncOD(): void {
  const f = el<HTMLInputElement>("from-field");
  if (f.classList.contains("picking")) return;
  f.classList.toggle("custom", !store.fromCurrent);
  if (store.fromCurrent) {
    f.value = "";
    f.placeholder = "Your location";
  } else if (f.value === "") {
    // set by tapping/dragging the map rather than typed
    f.placeholder = "Start set on the map";
  }
}

export function makeMarker(lngLat: LngLat | [number, number], color: string, label: string): Marker {
  const m = new maplibregl.Marker({ color, draggable: true });
  m.setLngLat(lngLat).addTo(map);
  m.getElement().title = `${label} (drag to move)`;
  m.on("dragend", () => {
    nameEnd(label === "start" ? "start" : "end");
    void links.requestRoute.call();
    // a grade is the route FROM the start: move it and the letters on screen
    // describe a journey that no longer begins where the rider does
    if (label === "start") links.regradeVisible.call();
  });
  return m;
}

export function setPoint(kind: "start" | "end", lngLat: LngLat | [number, number]): void {
  if (kind === "start") {
    store.fromCurrent = false;
    el<HTMLInputElement>("from-field").classList.remove("picking");
    if (store.start) store.start.setLngLat(lngLat);
    else store.start = makeMarker(lngLat, "#2b83ba", "start");
    links.regradeVisible.call();
  } else {
    if (store.end) store.end.setLngLat(lngLat);
    else store.end = makeMarker(lngLat, "#d7191c", "end");
  }
  syncOD();
  nameEnd(kind);
  void links.requestRoute.call();
}

export function initMarkers(): void {
  // after the map exists, so the marker has something to land on
  void locateIfAlreadyAllowed();
}
