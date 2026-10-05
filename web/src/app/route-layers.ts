// The route on the map: the reach map, the alternatives, the line, its marks, the part ridden, the ride history.

import { map } from "./map.js";
import { emptyFC } from "./dom.js";
import { CLASS_MARKS, MARK_INK } from "./classes.js";

export function initRouteLayers(): void {
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
  // the same marks on the route itself, which is drawn in the same colours
  for (const m of CLASS_MARKS) {
    map.addLayer({
      id: `route-mark-${m.id}`,
      type: "line",
      source: "route",
      filter: ["all", ["==", ["get", "cls"], m.cls], ["!=", ["get", "walk"], true]],
      layout: { "line-join": "round", ...(m.round ? { "line-cap": "round" as const } : {}) },
      paint: {
        "line-color": MARK_INK,
        "line-width": Math.min(9, 5 * m.scale),
        "line-dasharray": m.dash,
      },
    });
  }
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
}

export function initHistoryLayers(): void {
  map.addSource("history", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "history",
    type: "line",
    source: "history",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#8b5cf6", "line-width": 4, "line-opacity": 0.8 },
  });
}
