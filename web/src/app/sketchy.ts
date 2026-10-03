// The marked spots: places the rider flagged to avoid, their list in the options,
// and the popup for adding or removing one.

import { links } from "./links.js";
import { writeItem } from "../storage.js";
import { SKETCHY_KEY, store } from "./store.js";
import { el } from "./dom.js";
import { h, render } from "preact";
import { SketchyList } from "../ui/Lists.js";
import { map } from "./map.js";
import { applyAvoidPoints } from "./avoid.js";
import { type Popup } from "maplibre-gl";
import { maplibregl } from "../maplibre.js";
import { promptSavePlace } from "./places.js";

export function saveSketchy(marks: [number, number][]): void {
  writeItem(SKETCHY_KEY, JSON.stringify(marks));
  // this is exactly a change to what the router must avoid, so any grade
  // computed before it is now a claim about a route the app wouldn't plan
  store.avoidRevision++;
  links.regradeVisible.call();
}

export function renderSketchy(): void {
  el<HTMLDivElement>("sketchy-section").style.display = store.sketchyMarks.length > 0 ? "block" : "none";
  render(
    h(SketchyList, {
      marks: store.sketchyMarks,
      onFly: (mark) => map.flyTo({ center: mark, zoom: 16 }),
      onRemove: (i) => {
        store.sketchyMarks = store.sketchyMarks.filter((_, j) => j !== i);
        saveSketchy(store.sketchyMarks);
        applyAvoidPoints();
        renderSketchy();
        void links.requestRoute.call();
      },
    }),
    el<HTMLDivElement>("sketchy-list"),
  );
}

/** The one open spot-menu, so a second right-click (or long-press) replaces it
 * instead of stacking a second card on the map. */
export let sketchyPopup: Popup | null = null;

// touch devices have no right-click: a long-press on a street opens this same
// "mark sketchy" popup (wired below the definition)
export function openSketchyPopup(lngLat: [number, number]): void {
  sketchyPopup?.remove();
  sketchyPopup = null;
  // the hover card describes the same street
  links.dropHoverCard.call();
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
    if (sketchyPopup === popup) sketchyPopup = null;
  });
  btn.addEventListener("click", () => {
    store.sketchyMarks.push(lngLat);
    saveSketchy(store.sketchyMarks);
    applyAvoidPoints();
    renderSketchy();
    popup.remove();
    void links.requestRoute.call();
  });
  report.addEventListener("click", () => {
    popup.remove();
    links.openHazardDialog.call(lngLat[0], lngLat[1]);
  });
  star.addEventListener("click", () => {
    popup.remove();
    promptSavePlace(lngLat[0], lngLat[1]);
  });
}

export function initSketchy(): void {
  links.renderSketchy.set(renderSketchy);
  // At load, not when a router is first built: that was load when the whole
  // graph came down at startup, and since the graph is tiled a router exists
  // only once a route is asked for, so the marks on the device went unlisted
  // until then.
  renderSketchy();
}
