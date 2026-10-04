// The ride's buttons and the back button: start and exit, the stops menu and its
// three kid stops, resume, my street choice, mute, reporting a hazard from the
// bike, answering the ride's question, and stepping back over the ride's history
// entry.

import { el } from "./dom.js";
import { detourToNearest, exitNav, resumeRide, startNav } from "./nav-session.js";
import { nav } from "./nav-state.js";
import { writeItem } from "../storage.js";
import { clearSpeech, speak, speech, vibrate } from "./nav-voice.js";
import { askDuringRide, closeAsk, hideRideAlert, showRideAlert, stopsOpen } from "./nav-banner.js";
import { store } from "./store.js";
import { distM } from "../nav.js";
import { renderSketchy, saveSketchy } from "./sketchy.js";
import { applyAvoidPoints } from "./avoid.js";
import { fmtDistTight, fromMeters, getUnits, setUnits, toMeters, unitShort } from "../units.js";
import { LOOP_LIMITS } from "./plan-loop.js";
import { routing, trip } from "./services.js";
import { dataSource } from "../data.js";
import { scaleBar } from "./map.js";
import { renderOptionChips, renderOptions } from "./plan-options.js";
import { showSummary } from "./summary.js";
import { renderPlacesAndRecent } from "./places.js";
import { renderRides } from "./rides-dialog.js";
import { updateHash } from "./permalink.js";
import { minimizeApp, onAndroidBack } from "../native.js";
import { leaveSearchMode } from "./phone-search.js";
import { exitShedMode } from "./shed.js";



export function initNavControls(): void {
  el<HTMLButtonElement>("nav-water").addEventListener("click", () => {
    void detourToNearest("water");
  });

  el<HTMLButtonElement>("nav-restroom").addEventListener("click", () => {
    void detourToNearest("restroom");
  });

  el<HTMLButtonElement>("nav-playground").addEventListener("click", () => {
    void detourToNearest("playground");
  });

  el<HTMLButtonElement>("nav-resume").addEventListener("click", () => {
    void resumeRide();
  });

  el<HTMLButtonElement>("nav-myway").classList.toggle("active", nav.myWay);

  el<HTMLButtonElement>("nav-myway").addEventListener("click", () => {
    nav.myWay = !nav.myWay;
    writeItem("navMyWay", nav.myWay ? "1" : "0");
    el<HTMLButtonElement>("nav-myway").classList.toggle("active", nav.myWay);
    speak(
      nav.myWay
        ? "going your way: reroutes will follow your direction."
        : "back to safest: reroutes return to the safest path.",
    );
  });

  el<HTMLButtonElement>("nav-hazard").addEventListener("click", () => {
    if (!nav.lastPos) {
      // it did nothing at all with no fix yet — a dead button with no feedback
      showRideAlert("⚠ no position yet — can't mark this spot", "gps");
      return;
    }
    // Tapping again because nothing visible happened wrote a duplicate mark, and
    // marks can only be removed from the planning panel, which is hidden while
    // riding. Collapse repeats within a few metres.
    const already = store.sketchyMarks.some((m) => distM(m, nav.lastPos as [number, number]) < 15);
    if (!already) {
      store.sketchyMarks.push(nav.lastPos);
      saveSketchy(store.sketchyMarks);
      applyAvoidPoints();
      renderSketchy();
    }
    vibrate([80]);
    speak("marked. future routes will avoid this spot.", "chat");
    // confirm on screen too: muted, there was no sign it had worked
    showRideAlert(already ? "⚠️ already marked here" : "⚠️ marked — routes will avoid it");
    window.setTimeout(hideRideAlert, 4000);
  });

  // Units. Everything is metres underneath; this only changes what is shown and
  // spoken, so switching re-renders rather than recomputing anything.
  {
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

  el<HTMLButtonElement>("nav-btn").addEventListener("click", () => {
    // first, inside the tap: without it an iPhone never speaks this page load
    speech.unlock();
    void startNav();
  });

  el<HTMLButtonElement>("nav-exit").addEventListener("click", () => {
    // it used to end the ride outright, and sat 9 px from the mute button
    askDuringRide("End the ride now?", exitNav);
  });

  el<HTMLButtonElement>("nav-ask-no").addEventListener("click", closeAsk);

  el<HTMLButtonElement>("nav-ask-yes").addEventListener("click", () => {
    const yes = nav.askYes;
    closeAsk();
    yes?.();
  });

  el<HTMLButtonElement>("nav-stops").addEventListener("click", (e: Event) => {
    e.stopPropagation();
    stopsOpen(el<HTMLButtonElement>("nav-stops").getAttribute("aria-expanded") !== "true");
  });

  // Tapping the map puts it away (onMapTap, step 1).
  for (const id of ["nav-water", "nav-restroom", "nav-playground"]) {
    el<HTMLButtonElement>(id).addEventListener("click", () => stopsOpen(false));
  }

  el<HTMLButtonElement>("nav-mute").addEventListener("click", () => {
    nav.muted = !nav.muted;
    const btn = el<HTMLButtonElement>("nav-mute");
    // the icon alone read as decoration at a glance; the word says which it is
    btn.querySelector(".dock-icon")!.textContent = nav.muted ? "🔇" : "🔊";
    btn.querySelector(".dock-label")!.textContent = nav.muted ? "muted" : "voice on";
    btn.classList.toggle("muted", nav.muted);
    btn.setAttribute("aria-label", nav.muted ? "Voice off — tap to turn on" : "Voice on — tap to mute");
    if (nav.muted) clearSpeech();
  });

  window.addEventListener("popstate", () => {
    if (!store.navActive) {
      if (nav.historyUnwinding) {
        nav.historyUnwinding = false;
        // back on the entry from before the ride, whose link may be older than
        // the plan now on screen (a reroute rewrote the ride's own entry)
        updateHash();
      }
      return;
    }
    // stay on the ride and ask, rather than silently leaving it
    history.pushState({ navigating: true }, "");
    askDuringRide("End the ride?", exitNav);
  });

  // Android's Back in the app. The popstate guard above is the website's; in the
  // APK Back never reached it, so mid-ride it went home, it never closed a dialog,
  // and on Android 7–11 it closed the app, stopping GPS and the voice with it.
  // Now it puts away whatever is on top, asks before leaving a ride, and otherwise
  // sends the app to the background the way Home does.
  onAndroidBack(() => {
    const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
    const topDialog = dialogs[dialogs.length - 1];
    if (topDialog !== undefined) {
      topDialog.close();
      return;
    }
    const popupClose = document.querySelector<HTMLButtonElement>(".maplibregl-popup-close-button");
    if (popupClose !== null) {
      popupClose.click();
      return;
    }
    if (el<HTMLButtonElement>("nav-stops").getAttribute("aria-expanded") === "true") {
      stopsOpen(false);
      return;
    }
    if (el<HTMLDivElement>("nav-ask").style.display === "block") {
      closeAsk(); // Back answers "no"
      return;
    }
    if (store.navActive) {
      askDuringRide("End the ride?", exitNav);
      return;
    }
    if (document.body.classList.contains("searching")) {
      (document.activeElement as HTMLElement | null)?.blur();
      leaveSearchMode(false);
      return;
    }
    if (store.shedMode) {
      exitShedMode();
      return;
    }
    minimizeApp();
  });
}
