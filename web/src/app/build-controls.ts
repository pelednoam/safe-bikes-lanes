// Wiring the where-to-build panel: its toggles, the weight sliders, the town
// filter, print and CSV, and what a tap or hover on a project or crossing does.

import { el } from "./dom.js";
import { ensureLayer } from "./sources.js";
import { map } from "./map.js";
import { ensureBuildData, focusProject, renderBuildList } from "./build-list.js";
import { WEIGHT_KEYS, type WeightKey, build } from "./build-state.js";
import { printProject } from "./build-print.js";
import { clearWhatIf, runWhatIf } from "./build-whatif.js";
import { publishedWeightPositions } from "./build-score.js";
import { dataUrl } from "../data.js";
import { onTap } from "./taps.js";
import { type MapLayerMouseEvent } from "maplibre-gl";



export function initBuildControls(): void {
  // wiring: the two toggles, the filter, the sliders, and the CSV
  for (const [checkbox, layer] of [
    ["show-access", "access"],
    ["show-build", "build"],
  ] as const) {
    el<HTMLInputElement>(checkbox).addEventListener("change", (e: Event) => {
      const on = (e.target as HTMLInputElement).checked;
      if (on) ensureLayer(layer);
      map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
      if (layer === "build") {
        // spot fixes ride with the projects: same list, drawn as points because a
        // 14 m line can't be seen or tapped at this zoom
        if (on) {
          ensureBuildData();
          ensureLayer("crossings");
        } else if (map.getLayer("build-selected")) {
          map.setLayoutProperty("build-selected", "visibility", "none");
        }
        map.setLayoutProperty("crossings", "visibility", on ? "visible" : "none");
      }
    });
  }

  el<HTMLButtonElement>("build-print").addEventListener("click", () => {
    if (build.selectedProject !== null) printProject(build.selectedProject);
  });

  el<HTMLButtonElement>("whatif-run").addEventListener("click", () => {
    if (build.selectedProject !== null) void runWhatIf(build.selectedProject);
  });

  el<HTMLButtonElement>("whatif-clear").addEventListener("click", clearWhatIf);

  el<HTMLSelectElement>("build-town").addEventListener("change", () => {
    build.selectedProject = null;
    if (map.getLayer("build-selected")) {
      map.setLayoutProperty("build-selected", "visibility", "none");
    }
    renderBuildList();
  });

  for (const key of WEIGHT_KEYS) {
    el<HTMLInputElement>(`wt-${key}`).addEventListener("input", renderBuildList);
  }

  el<HTMLButtonElement>("wt-reset").addEventListener("click", () => {
    // back to the pipeline's own weighting, which the exported score used
    const defaults: Record<WeightKey, string> = publishedWeightPositions() ?? {
      severance: "40",
      access: "30",
      crash: "15",
      coverage: "15",
    };
    for (const key of WEIGHT_KEYS) el<HTMLInputElement>(`wt-${key}`).value = defaults[key];
    renderBuildList();
  });

  el<HTMLButtonElement>("build-csv").addEventListener("click", () => {
    // the full ranking, not the top 20 on screen and not the town filter's slice
    const a = document.createElement("a");
    a.href = dataUrl("priorities.csv");
    a.download = "where-to-build.csv";
    a.click();
  });

  // clicking a project on the map selects it in the list, and the other way round
  onTap("build", (e: MapLayerMouseEvent) => {
    const pid = (e.features?.[0]?.properties as { pid?: string } | undefined)?.pid;
    if (pid !== undefined) {
      if (!el<HTMLDetailsElement>("build-box").open) {
        el<HTMLDetailsElement>("build-box").open = true;
      }
      focusProject(pid);
    }
  });

  onTap("crossings", (e: MapLayerMouseEvent) => {
    const pid = (e.features?.[0]?.properties as { pid?: string } | undefined)?.pid;
    if (pid !== undefined) {
      if (!el<HTMLDetailsElement>("build-box").open) {
        el<HTMLDetailsElement>("build-box").open = true;
      }
      focusProject(pid);
    }
  });

  map.on("mouseenter", "crossings", () => {
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", "crossings", () => {
    map.getCanvas().style.cursor = "";
  });

  map.on("mouseenter", "build", () => {
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", "build", () => {
    map.getCanvas().style.cursor = "";
  });

  el<HTMLDetailsElement>("build-box").addEventListener("toggle", () => {
    if (el<HTMLDetailsElement>("build-box").open) ensureBuildData();
  });
}
