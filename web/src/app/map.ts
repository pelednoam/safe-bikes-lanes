import type { Map as MLMap } from "maplibre-gl";

import { BASEMAP_SOURCE, basemapSource } from "../basemap.js";
import { HOME } from "../coverage.js";
import { maplibregl } from "../maplibre.js";
import { getUnits } from "../units.js";

/** The one map, made when this module is first imported. */
export const map: MLMap = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      // Our own basemap file (basemap.pmtiles, see basemap.ts), not
      // tile.openstreetmap.org or a map company's servers. OSM's tile servers
      // are donated infrastructure whose usage policy rules out a public
      // product leaning on them, and Carto, which the map used before, began
      // stamping "API KEY REQUIRED" across its tiles. Declared here so the
      // basemap's layers, added below as the map loads, have it to draw from.
      [BASEMAP_SOURCE]: basemapSource(),
    },
    // vendored SDF glyph ranges (Noto Sans, Latin + Latin-1): the label layer
    // below needs them, and hosting them ourselves keeps labels working
    // offline. The basemap's labels are pointed at this same stack (basemap.ts).
    glyphs: "fonts/glyphs/{fontstack}/{range}.pbf",
    // Ground to look at while the basemap styles are in flight. Stays at the
    // bottom of the stack; the fetched layers land on top of it.
    layers: [{ id: "ground", type: "background", paint: { "background-color": "#e9e6e1" } }],
  },
  center: HOME.center,
  zoom: HOME.zoom,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(
  new maplibregl.GeolocateControl({
    trackUserLocation: true,
    positionOptions: { enableHighAccuracy: true },
    fitBoundsOptions: { maxZoom: 16.5 },
  }),
  "top-right",
);
// in the rider's unit: it read "500 m" under a panel that said miles
export const scaleBar = new maplibregl.ScaleControl({ unit: getUnits() });
map.addControl(scaleBar, "bottom-left");
