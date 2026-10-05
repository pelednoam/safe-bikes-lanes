// The map's layer switches: the safety network, points of interest, the area
// overlays and 3D, construction, and the reset to the defaults.

import { el } from "./dom.js";
import { NETWORK_MARK_LAYERS } from "./classes.js";
import { map } from "./map.js";
import { applyBasemap } from "./dark-mode.js";
import { refreshNetworkTiles } from "./data-load.js";
import { ensureLayer } from "./sources.js";

/** Show/hide the coloured safety network. Driven by the panel checkbox and —
 * because the panel is hidden while navigating — by the nav-mode button too,
 * so both stay in sync from either place. */
function setNetworkVisible(on: boolean): void {
  el<HTMLInputElement>("show-net").checked = on;
  for (const layer of ["network", "network-unconfirmed", ...NETWORK_MARK_LAYERS]) {
    map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
  }
  applyBasemap(); // casing + line widths key off the same flag
  const btn = el<HTMLButtonElement>("nav-net");
  btn.classList.toggle("active", on);
  btn.title = on ? "Hide the safety-network overlay" : "Show the safety-network overlay";
  // refresh on re-show: tile loading is skipped while the layer is hidden
  if (on) void refreshNetworkTiles();
}

// the two area overlays are mutually exclusive to stay readable; in 3D view
// the extruded variants replace the flat fills and terrain turns on
const AREA_OVERLAYS: [string, string][] = [
  ["show-heat", "heatmap"],
  ["show-elev", "elevmap"],
  ["show-lanes", "lanemap"],
];

function syncOverlays(): void {
  const threeD = el<HTMLInputElement>("show-3d").checked;
  const vis = (on: boolean): "visible" | "none" => (on ? "visible" : "none");
  for (const [checkbox, layer] of AREA_OVERLAYS) {
    const on = el<HTMLInputElement>(checkbox).checked;
    map.setLayoutProperty(layer, "visibility", vis(on && !threeD));
    map.setLayoutProperty(`${layer}-3d`, "visibility", vis(on && threeD));
  }
}

// Layers: eleven of them, so a way back to the state someone can reason about.
// Everything routes through a change event rather than being set directly, so a
// reset takes exactly the path a tap does and can't drift from it.
const LAYER_DEFAULTS: Record<string, boolean> = {
  "show-net": true,
  "show-constr": true,
  "show-heat": false,
  "show-gates": false,
  "show-pois": false,
  "show-elev": false,
  "show-3d": false,
  "show-aerial": false,
  "show-lanes": false,
  "show-access": false,
  "show-build": false,
  // dark-mode is deliberately absent. It is the rider's setting, not a map
  // layer: resetting the layers on a night ride should not white out the
  // screen.
};

export function initLayerToggles(): void {
  el<HTMLInputElement>("show-net").addEventListener("change", (e: Event) => {
    setNetworkVisible((e.target as HTMLInputElement).checked);
  });

  el<HTMLButtonElement>("nav-net").addEventListener("click", () => {
    setNetworkVisible(!el<HTMLInputElement>("show-net").checked);
  });

  for (const [checkboxId, layers] of [
    ["show-pois", ["pois"]],
    ["show-gates", ["gateways"]],
  ] as [string, string[]][]) {
    el<HTMLInputElement>(checkboxId).addEventListener("change", (e: Event) => {
      const checked = (e.target as HTMLInputElement).checked;
      for (const layer of layers) {
        if (checked) ensureLayer(layer);
        map.setLayoutProperty(layer, "visibility", checked ? "visible" : "none");
      }
    });
  }

  for (const [checkbox, layer] of AREA_OVERLAYS) {
    el<HTMLInputElement>(checkbox).addEventListener("change", (e: Event) => {
      if ((e.target as HTMLInputElement).checked) {
        ensureLayer(layer);
        for (const [other] of AREA_OVERLAYS) {
          if (other !== checkbox) el<HTMLInputElement>(other).checked = false;
        }
      }
      syncOverlays();
    });
  }

  // honor any overlay left enabled by default markup / a restored session
  for (const [box, overlay] of AREA_OVERLAYS) {
    if (el<HTMLInputElement>(box).checked) ensureLayer(overlay);
  }

  if (el<HTMLInputElement>("show-gates").checked) ensureLayer("gateways");

  el<HTMLInputElement>("show-3d").addEventListener("change", (e: Event) => {
    const on = (e.target as HTMLInputElement).checked;
    if (on) {
      map.setTerrain({ source: "dem", exaggeration: 1.3 });
      map.easeTo({ pitch: 60, duration: 800 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
    syncOverlays();
  });

  el<HTMLButtonElement>("layers-reset").addEventListener("click", () => {
    for (const [id, want] of Object.entries(LAYER_DEFAULTS)) {
      const box = document.getElementById(id) as HTMLInputElement | null;
      if (!box || box.checked === want) continue;
      box.checked = want;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  el<HTMLInputElement>("show-constr").addEventListener("change", (e: Event) => {
    const on = (e.target as HTMLInputElement).checked;
    for (const layer of ["construction-lines-base", "construction-lines", "construction-pts"]) {
      map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    }
  });
}
