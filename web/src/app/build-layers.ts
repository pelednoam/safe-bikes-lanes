// Where-to-build on the map: coverage, projects, the selected and hovered one, spot fixes.

import { map } from "./map.js";
import { emptyFC } from "./dom.js";

export function initBuildLayers(): void {
  // ── where-to-build (cities, not riders) ──────────────────────────────
  // Coverage first, underneath: it's the backdrop the projects are answers to.
  map.addSource("access", { type: "geojson", data: emptyFC() });
  // beforeId: at 35% opacity over the network and route this washed out the
  // safety colours it exists to explain. It's a backdrop.
  map.addLayer(
    {
    id: "access",
    type: "fill",
    source: "access",
    layout: { visibility: "none" },
    paint: {
      "fill-color": [
        "match",
        ["get", "band"],
        "good", "#1a9850",
        "partial", "#fee08b",
        "#d73027",
      ],
      "fill-opacity": 0.35,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
    },
    "network-casing",
  );
  map.addSource("build", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "build",
    type: "line",
    source: "build",
    layout: { visibility: "none", "line-cap": "round" },
    paint: {
      // width and colour both track the score, so the map and the ranked list
      // can't disagree about which project is the big one
      "line-color": [
        "interpolate",
        ["linear"],
        ["get", "score"],
        0, "#8e9aa4",
        0.3, "#f39c12",
        0.6, "#d7191c",
      ],
      "line-width": ["interpolate", ["linear"], ["get", "score"], 0, 2.5, 0.8, 8],
      "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "build-selected",
    type: "line",
    source: "build",
    filter: ["==", ["get", "pid"], ""],
    layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": "#1440a0", "line-width": 11, "line-opacity": 0.45 },
  });
  // Running the mouse down the list should show where each one is without
  // losing the one you picked. Magenta because it appears nowhere else on this
  // map — the safety palette owns every other strong colour here.
  map.addLayer({
    id: "build-hover",
    type: "line",
    source: "build",
    filter: ["==", ["get", "pid"], ""],
    layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": "#e6007e", "line-width": 9, "line-opacity": 0.9 },
  });
  // Spot fixes, as points. They're in the projects layer too, but 14 m of line
  // is invisible at the zoom a city looks at, and these are the cheapest
  // projects on the list.
  map.addSource("crossings", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "crossings",
    type: "circle",
    source: "crossings",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "score"], 0, 4, 0.8, 9],
      "circle-color": "#d7191c",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-opacity": 0.95,
    },
  });
}
