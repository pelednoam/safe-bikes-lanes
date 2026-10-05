// The area overlays (heat, lanes, elevation), flat and as towers, hidden until toggled.

import { map } from "./map.js";
import { emptyFC } from "./dom.js";

export function initOverlayLayers(): void {
  // area overlays (hidden until toggled) sit under the street/route lines;
  // each has a flat (2D) and an extruded (3D) variant
  map.addSource("heatmap", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "heatmap",
    type: "fill",
    source: "heatmap",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.35,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
  });
  map.addLayer({
    id: "heatmap-3d",
    type: "fill-extrusion",
    source: "heatmap",
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-opacity": 0.65,
      // danger towers: cell height = average kid-stress × 25 m
      "fill-extrusion-height": ["*", ["coalesce", ["get", "stress"], 1], 25],
    },
  });
  map.addSource("lanemap", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "lanemap",
    type: "fill",
    source: "lanemap",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.45,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
  });
  map.addLayer({
    id: "lanemap-3d",
    type: "fill-extrusion",
    source: "lanemap",
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-opacity": 0.7,
      // towers of infrastructure: 0.4 m per meter of facility in the cell
      "fill-extrusion-height": ["*", ["coalesce", ["get", "fac_m"], 0], 0.4],
    },
  });
  map.addSource("elevmap", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "elevmap",
    type: "fill",
    source: "elevmap",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.45,
      "fill-outline-color": "rgba(0,0,0,0)",
    },
  });
  map.addLayer({
    id: "elevmap-3d",
    type: "fill-extrusion",
    source: "elevmap",
    layout: { visibility: "none" },
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-opacity": 0.75,
      // exaggerate 4x so the ~50 m hills read clearly
      "fill-extrusion-height": ["*", ["coalesce", ["get", "elev"], 0], 4],
    },
  });
}

export function initGatewayLayer(): void {
  map.addSource("gateways", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "gateways",
    type: "circle",
    source: "gateways",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#1a9850",
      "circle-stroke-width": 2.5,
    },
  });
}
