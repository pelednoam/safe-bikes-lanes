// The basemap, the aerial photos and the terrain: the layers under everything else.

import { applyBasemap } from "./dark-mode.js";
import { map } from "./map.js";

/**
 * Run `fn` once the browser is idle, or after `timeout` regardless.
 *
 * requestIdleCallback is missing on iOS Safari, which is exactly where this app
 * runs as an installed PWA, so the fallback is not academic: without it the
 * basemap would simply never appear on an iPhone.
 */
function whenIdle(fn: () => void, timeout = 3000): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout });
  } else {
    window.setTimeout(fn, 1200);
  }
}

export function initBasemapLayers(): void {
  // The basemap: Protomaps' light and dark looks over our own basemap.pmtiles,
  // as vector layers, injected once per theme and thereafter toggled by
  // visibility (see basemap.ts and applyBasemap).
  //
  // Label-free is not a separate tile set but the same layers with the label
  // ones hidden, which is what ride mode wants: raster tiles rotate as
  // pictures, so with the map turned to the heading the baked-in labels ride
  // upside-down and slide off their own streets. The names come back as a real
  // symbol layer (see "street-labels"), which MapLibre keeps upright at any
  // bearing.
  //
  // Only the theme in use is added; applyBasemap adds the other the first time
  // someone switches. The insert point is resolved then, by which time
  // every layer the load handler adds after this one is on the map — so the
  // basemap lands under them rather than over the route.
  //
  // Deferred to the browser's first idle moment rather than run inline. The
  // basemap is decoration and the safety network is the product, so the ninety
  // vector layers wait their turn behind the app's own tiles. It is worth about
  // two tenths of a second on time-to-usable here — small, but free, and the
  // right way round. requestIdleCallback's own timeout is what guarantees it
  // still happens on a busy phone.
  whenIdle(() => applyBasemap());
  // MassGIS 2023 15-cm orthoimagery (free tile service)
  map.addSource("massgis-aerial", {
    type: "raster",
    tiles: [
      "https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/orthos2023/MapServer/tile/{z}/{y}/{x}",
    ],
    tileSize: 256,
    attribution: "MassGIS 2023 orthoimagery",
  });
  map.addLayer({
    id: "aerial",
    type: "raster",
    source: "massgis-aerial",
    layout: { visibility: "none" },
  });
  // terrain DEM: the same AWS terrarium tiles the pipeline samples
  map.addSource("dem", {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 13,
  });
}
