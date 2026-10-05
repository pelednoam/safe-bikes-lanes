// The safety network: its lines, marks, hit layer and hover highlight, and the street names.

import { map } from "./map.js";
import { emptyFC } from "./dom.js";
import { FACILITY_CLASSES } from "../segment.js";
import { CLASS_MARKS, MARK_INK, classWidth } from "./classes.js";

export function initNetworkLayers(): void {
  map.addSource("network", {
    type: "geojson",
    data: emptyFC(),
    generateId: true,
  });
  // dark halo under the network lines — only over aerial imagery, where
  // colored lines otherwise vanish against bright pavement
  map.addLayer({
    id: "network-casing",
    type: "line",
    source: "network",
    layout: { visibility: "none" },
    paint: {
      "line-color": "#111111",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.2, 16, 7.5],
      "line-opacity": 0.85,
    },
  });
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
      "line-width": classWidth(1.2, 3.5),
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
      "line-width": classWidth(1.2, 3.5),
      "line-opacity": 0.75,
      "line-dasharray": [2, 1.4],
    },
  });
  // each class's mark, over its line (see CLASS_MARKS). From z13: below that a
  // street is a hairline and a pattern on it is noise.
  for (const m of CLASS_MARKS) {
    map.addLayer({
      id: `network-mark-${m.id}`,
      type: "line",
      source: "network",
      minzoom: 13,
      filter: ["==", ["get", "cls"], m.cls],
      layout: m.round ? { "line-cap": "round" } : {},
      paint: {
        "line-color": MARK_INK,
        "line-width": classWidth(1.2, 3.5, m.scale),
        "line-dasharray": m.dash,
        "line-opacity": 0.75,
      },
    });
  }
  // invisible hit layer: every street stays hoverable/right-clickable even
  // when the network display is toggled off or covered by other layers
  map.addLayer({
    id: "network-hit",
    type: "line",
    source: "network",
    paint: {
      "line-color": "#000000",
      "line-opacity": 0.02,
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 8, 16, 15],
    },
  });
  // hover highlight: bright halo + boosted core for the segment under the cursor
  // hover highlight driven by feature-state (GPU-side, no per-move re-filter):
  // opacity is 0 for every segment except the one with {hover:true}
  const hoverOn = ["case", ["boolean", ["feature-state", "hover"], false], 1, 0];
  map.addLayer({
    id: "network-hover-halo",
    type: "line",
    source: "network",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 7, 16, 12],
      "line-opacity": ["*", hoverOn, 0.9] as unknown as number,
    },
  });
  map.addLayer({
    id: "network-hover-core",
    type: "line",
    source: "network",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 7],
      "line-opacity": hoverOn as unknown as number,
    },
  });
}

export function initStreetLabels(): void {
  // Street names, drawn from the safety network rather than the basemap, so
  // they stay upright and on their street when the map turns to the heading.
  // Only shown while navigating: the planning view has the basemap's own
  // labels, which cover more than our network does.
  map.addLayer({
    id: "street-labels",
    type: "symbol",
    source: "network",
    filter: ["all", ["has", "name"], ["!=", ["get", "name"], ""]],
    minzoom: 14,
    layout: {
      visibility: "none",
      "symbol-placement": "line",
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 14, 11.5, 17, 14],
      // keep names off tight corners, and don't repeat them every few metres
      "text-max-angle": 35,
      "symbol-spacing": 260,
      "text-padding": 3,
      "text-letter-spacing": 0.01,
    },
    paint: {
      "text-color": "#1d2430",
      "text-halo-color": "rgba(255,255,255,0.92)",
      "text-halo-width": 1.7,
      "text-halo-blur": 0.3,
    },
  });
}
