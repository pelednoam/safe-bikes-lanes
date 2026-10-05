// What the page itself carries: the Escape key and the legend.

import { el } from "./dom.js";
import { store } from "./store.js";
import { exitShedMode } from "./shed.js";
import { CLASS_LABELS } from "../segment.js";
import { type ProtectionClass } from "../types.js";
import { CONSTRUCTION_SWATCH, classSwatch } from "./classes.js";

export function initPageChrome(): void {
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (
        el<HTMLDialogElement>("about").open ||
        el<HTMLDialogElement>("rides").open ||
        el<HTMLDialogElement>("hazard").open
      ) {
        return; // dialogs handle it
      }
      if (store.shedMode) exitShedMode();
      // never wipe the trip out from under an active ride: reset() cleared the
      // route, markers and permalink while navigation kept talking, leaving the
      // rider following a voice over a blank map with no way to recover it
      else if (!store.navActive) el<HTMLButtonElement>("reset").click();
    }
  });

  // legend: each class as it is drawn — colour, width and mark — so the marks
  // are explained where the colours are, and construction beside them
  const legend = el<HTMLDivElement>("legend");
  for (const [cls, label] of Object.entries(CLASS_LABELS) as [ProtectionClass, string][]) {
    if (cls === "service") continue; // drawn as quiet_street
    const sw = document.createElement("span");
    sw.innerHTML = classSwatch(cls);
    legend.appendChild(sw);
    const span = document.createElement("span");
    span.textContent = label;
    legend.appendChild(span);
  }
  {
    const sw = document.createElement("span");
    sw.innerHTML = CONSTRUCTION_SWATCH;
    legend.appendChild(sw);
    const span = document.createElement("span");
    span.textContent = "construction — routes avoid it";
    legend.appendChild(span);
  }
}
