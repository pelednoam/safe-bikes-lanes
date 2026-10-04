// Units. Everything is metres underneath; this only changes what is shown and
// spoken, so switching re-renders rather than recomputing anything.

import { el } from "./dom.js";
import { fmtDistTight, fromMeters, getUnits, setUnits, toMeters, unitShort } from "../units.js";
import { LOOP_LIMITS } from "./plan-loop.js";
import { routing, trip } from "./services.js";
import { dataSource } from "../data.js";
import { scaleBar } from "./map.js";
import { renderOptionChips, renderOptions } from "./plan-options.js";
import { showSummary } from "./summary.js";
import { renderPlacesAndRecent } from "./places.js";
import { renderRides } from "./rides-dialog.js";

export function initUnitsPref(): void {
  const pref = el<HTMLSelectElement>("units-pref");
  pref.value = getUnits();
  const syncUnitLabels = (): void => {
    el<HTMLSpanElement>("loop-unit").textContent = unitShort();
    // the field's own limits, in the unit it's typed in (a phone keyboard and
    // the spinner arrows respect these; the check in the loop planner is the
    // one that holds)
    const loopDist = el<HTMLInputElement>("loop-dist");
    [loopDist.min, loopDist.max] = LOOP_LIMITS[getUnits()].map(String) as [string, string];
    // The walking budget is stored in metres (the router's unit) and its
    // options keep those values; only what they read as follows the rider.
    // Feet round to tens: "330 ft" is a figure, "328 ft" is a conversion.
    for (const opt of el<HTMLSelectElement>("walk-max").options) {
      const m = Number(opt.value);
      const ft = m * 3.28084;
      opt.textContent =
        getUnits() === "imperial" && ft < 1000 ? `${Math.round(ft / 10) * 10} ft` : fmtDistTight(m);
    }
    el<HTMLSpanElement>("shed-budget-label").textContent = fmtDistTight(
      Number(el<HTMLInputElement>("shed-budget").value) * 1000,
    );
  };
  syncUnitLabels();
  pref.addEventListener("change", () => {
    const wasM = toMeters(Number(el<HTMLInputElement>("loop-dist").value) || 0);
    setUnits(pref.value === "metric" ? "metric" : "imperial");
    void routing.configure(dataSource(), getUnits());
    syncUnitLabels();
    scaleBar.setUnit(getUnits());
    // the number in the box meant a distance, not a digit: keep the distance
    if (wasM > 0) {
      el<HTMLInputElement>("loop-dist").value = String(Math.round(fromMeters(wasM) * 10) / 10);
    }
    renderOptions();
    renderOptionChips();
    const sel = trip.selected;
    if (sel) showSummary(sel);
    renderPlacesAndRecent();
    renderRides();
  });
}
