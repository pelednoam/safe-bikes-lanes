// What a tap on the map does, and the long press on a phone that marks a street
// sketchy: stops menu, cards, the reach map, a ride in progress, the start and
// destination.

import { type MapLayerMouseEvent, type MapMouseEvent } from "maplibre-gl";
import { el } from "./dom.js";
import { askDuringRide, stopsOpen } from "./nav-banner.js";
import { store } from "./store.js";
import { TAP_ORDER, type TapTarget, tapTargets } from "./taps.js";
import { map } from "./map.js";
import { computeShed } from "./shed.js";
import { exitNav } from "./nav-session.js";
import { setPoint, syncOD } from "./markers.js";
import { requestRoute } from "./plan-route.js";
import { openSketchyPopup } from "./sketchy.js";

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
    if (store.navActive) return;
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
  if (store.shedMode) {
    store.shedCenter = [e.lngLat.lng, e.lngLat.lat];
    void computeShed();
    return;
  }
  // Mid-ride the map is for looking at, not re-planning: a stray tap on the
  // handlebars used to silently swap the route out from under the rider.
  if (store.navActive) {
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
  if (store.activeField === "start") {
    setPoint("start", e.lngLat);
    store.activeField = "end";
  } else {
    setPoint("end", e.lngLat);
  }
}

export function initMapTaps(): void {
  map.on("click", (e: MapMouseEvent) => {
    onMapTap(e);
  });

  // a press and hold on a street, on a phone (no right-click there), marks it sketchy
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
}
