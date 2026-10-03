// The map's data sources, and the layers that load from their own file the first
// time they are needed.

import { type GeoJSONSource } from "maplibre-gl";
import { map } from "./map.js";
import { loadJson } from "../data.js";
import { dataReady } from "./services.js";

export function getSource(id: string): GeoJSONSource {
  const src = map.getSource(id);
  if (src === undefined) throw new Error(`missing source ${id}`);
  return src as GeoJSONSource;
}

// Heavy overlays load their data the first time they're shown, not at startup.
const LAZY_LAYER_FILES: Record<string, string> = {
  heatmap: "heatmap.geojson",
  lanemap: "lanemap.geojson",
  elevmap: "elevation.geojson",
  gateways: "gateways.geojson",
  access: "access.geojson",
  build: "priorities.geojson",
  crossings: "severance.geojson",
};

const lazyLoaded = new Set<string>();

/** Fetch an overlay's data once, the first time its toggle is turned on. */
export function ensureLayer(id: string): void {
  const file = LAZY_LAYER_FILES[id];
  if (file === undefined || lazyLoaded.has(id)) return;
  lazyLoaded.add(id);
  void dataReady
    .then(() => loadJson<GeoJSON.GeoJSON>(file))
    .then((d) => {
      (map.getSource(id) as GeoJSONSource).setData(d);
    })
    .catch(() => {
      lazyLoaded.delete(id); // let a later toggle retry
    });
}
