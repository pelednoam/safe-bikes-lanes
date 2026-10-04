// Clearing and turning the trip around: the reset, swap and round-trip buttons.

import { links } from "./links.js";
import { routeLane, trip } from "./services.js";
import { cancelPanelPaint, clearOptionChips, renderOptions } from "./plan-options.js";
import { el, emptyFC } from "./dom.js";
import { store } from "./store.js";
import { endWhatIf } from "./build-whatif.js";
import { clearSearchResults } from "./search-results.js";
import { syncOD } from "./markers.js";
import { getSource } from "./sources.js";
import { autoNamed } from "./names.js";
import { requestRoute } from "./plan-route.js";
import { requestLoop } from "./plan-loop.js";
import { forgetLink } from "./permalink.js";

/** Clear the trip: pins, options, drawn route — and the link, unless the
 * link is what is being followed. */
export function resetPlan(clearLink = true): void {
  // withdraw anything still planning: it would otherwise finish and draw the
  // trip just cleared back onto an empty map
  routeLane.cancel();
  // and a plan that has finished but not yet painted its panel: the paint waits
  // for the line to draw (up to 3 s), and a Reset in that gap got its summary
  // put back over the empty map
  cancelPanelPaint();
  el<HTMLDivElement>("loading").style.display = "none";
  store.start?.remove();
  store.end?.remove();
  store.poiMarker?.remove();
  store.start = store.end = store.poiMarker = null;
  store.loopParams = null;
  // a choice a link asked for belongs to that link's plan, not to the next trip
  store.pendingSelect = null;
  endWhatIf();
  clearOptionChips();
  store.fromCurrent = true;
  store.activeField = "end";
  el<HTMLInputElement>("from-field").classList.remove("picking");
  el<HTMLInputElement>("from-field").value = "";
  clearSearchResults();
  syncOD();
  trip.clear();
  renderOptions();
  getSource("route").setData(emptyFC());
  getSource("alts").setData(emptyFC());
  el<HTMLDivElement>("summary").style.display = "none";
  el<HTMLDivElement>("error").style.display = "none";
  if (clearLink) forgetLink();
}

export function initPlanControls(): void {
  links.resetPlan.set(resetPlan);
  el<HTMLButtonElement>("reset").addEventListener("click", () => resetPlan());

  el<HTMLButtonElement>("swap").addEventListener("click", () => {
    if (!store.start || !store.end) return;
    const s = store.start.getLngLat();
    store.start.setLngLat(store.end.getLngLat());
    store.end.setLngLat(s);
    // the names swap with the pins, or the fields describe the trip backwards
    const from = el<HTMLInputElement>("from-field");
    const to = el<HTMLInputElement>("search");
    [from.value, to.value] = [to.value, from.value];
    [autoNamed.start, autoNamed.end] = [autoNamed.end, autoNamed.start];
    store.fromCurrent = false;
    syncOD();
    void requestRoute();
  });

  el<HTMLButtonElement>("loop-btn").addEventListener("click", () => {
    void requestLoop();
  });
}
