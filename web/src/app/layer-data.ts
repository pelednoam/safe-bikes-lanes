// What the layers are filled with once the map has loaded, and the link the page was opened with.

import { refreshHazards } from "./hazard-dialog.js";
import { constructionReady, dataProgress, networkReady, poisData, refreshNetworkTiles } from "./data-load.js";
import { map } from "./map.js";
import { type GeoJSONSource } from "maplibre-gl";
import { store } from "./store.js";
import { parseHash } from "./permalink.js";

export function initLayerData(): void {
  void refreshHazards();

  // data layers come through the resolver: bundled on the web, freshest of
  // bundle-vs-website in the app (cached per build). The display network loads
  // by viewport (see refreshNetworkTiles); only POIs (needed by the loop
  // planner) load eagerly here; the heavy heatmap/elevation/lane overlays load
  // the first time their toggle is turned on (see ensureLayer).
  void poisData
    .then((d) => {
      // the same collection the loop planner reads (see poisData)
      if (d) (map.getSource("pois") as GeoJSONSource).setData(d as unknown as GeoJSON.GeoJSON);
    })
    .catch(() => undefined)
    .finally(() => dataProgress());
  void networkReady.then(() => refreshNetworkTiles()).finally(() => dataProgress());
  void constructionReady
    .then(() => {
      if (store.constructionFC) {
        (map.getSource("construction") as GeoJSONSource).setData(
          store.constructionFC as unknown as GeoJSON.GeoJSON,
        );
      }
    })
    .finally(() => dataProgress());

  parseHash();
}
