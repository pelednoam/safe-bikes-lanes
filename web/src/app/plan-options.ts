// The route options: the cards and the chips under them, choosing one, and painting
// the panel only once its line is on the map.

import { links } from "./links.js";
import { type RouteOption } from "../types.js";
import { type Marker } from "maplibre-gl";
import { chipViews, paintChip } from "../chips.js";
import { trip } from "./services.js";
import { GRADE_COLORS, GRADE_TEXT } from "../segment.js";
import { maplibregl } from "../maplibre.js";
import { map } from "./map.js";
import { store } from "./store.js";
import { getSource } from "./sources.js";
import { showSummary } from "./summary.js";
import { showOptionsInSheet } from "./sheet.js";
import { announce } from "./data-load.js";
import { fmtDist } from "../units.js";
import { el } from "./dom.js";
import { h, render } from "preact";
import { OptionCards } from "../ui/OptionCards.js";

/** The badges on the map, one per option (src/chips.ts), kept across
 * repaints and updated in place: a badge the keyboard is on stays the element
 * it is on. */
const optionChips = new Map<RouteOption["id"], Marker>();

export function clearOptionChips(): void {
  for (const chip of optionChips.values()) chip.remove();
  optionChips.clear();
}

export function renderOptionChips(): void {
  const views = chipViews(trip.options, trip.selectedId, GRADE_COLORS, GRADE_TEXT);
  const listed = new Set(views.map((v) => v.id));
  for (const [id, chip] of optionChips) {
    if (listed.has(id)) continue;
    chip.remove();
    optionChips.delete(id);
  }
  for (const v of views) {
    let chip = optionChips.get(v.id);
    if (chip === undefined) {
      const badge = document.createElement("div");
      // reachable and pressable from a keyboard, like the cards they mirror
      badge.tabIndex = 0;
      badge.setAttribute("role", "button");
      badge.addEventListener("click", (ev: Event) => {
        ev.stopPropagation();
        selectOption(v.id);
      });
      badge.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        ev.stopPropagation();
        selectOption(v.id);
      });
      chip = new maplibregl.Marker({ element: badge }).setLngLat(v.at).addTo(map);
      optionChips.set(v.id, chip);
    } else {
      chip.setLngLat(v.at);
    }
    paintChip(chip.getElement(), v);
  }
}

/** Takes the pending panel paint's listeners off. A superseded paint used to
 * return from its own check before removing them, so every option switched
 * past before its line was drawn left a render handler behind — running
 * queryRenderedFeatures on every frame for the rest of the session. */
export let cancelPanelPaint: (() => void) | null = null;

/** Run the panel's DOM writes once the route line is actually on the map.
 *
 * The line goes through MapLibre's worker (parse, re-tile, render) while the
 * summary is a synchronous DOM write, so putting both in one task painted the
 * numbers a frame or two before the route appeared — planners read the gap as
 * the app having routed somewhere else and then corrected itself. */
export function paintPanelWithRoute(paint: () => void): void {
  cancelPanelPaint?.(); // the newest selection is the only one to paint
  let done = false;
  let renders = 0;
  let parsed = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    map.off("render", onRender);
    map.off("sourcedata", onData);
    window.clearTimeout(soft);
    window.clearTimeout(hard);
    if (cancelPanelPaint === stop) cancelPanelPaint = null;
    window.__panelPaintsWaiting = (window.__panelPaintsWaiting ?? 1) - 1;
  };
  const fire = (): void => {
    if (done) return;
    stop();
    paint();
  };
  const onData = (): void => {
    if (map.isSourceLoaded("route")) parsed = true;
  };
  // "the source is loaded" is not "the line is drawn" — the frame after parsing
  // is the one that draws it. Waiting for rendered geometry is the real signal;
  // a route that lands off-screen has none, so a couple of frames after the
  // data parsed counts as the map having had its chance.
  const onRender = (): void => {
    renders++;
    if (map.getLayer("route") === undefined) return;
    if (map.queryRenderedFeatures(undefined, { layers: ["route"] }).length > 0) fire();
    else if (parsed && renders > 2) fire();
  };
  map.on("sourcedata", onData);
  map.on("render", onRender);
  window.__panelPaintsWaiting = (window.__panelPaintsWaiting ?? 0) + 1;
  // a map that isn't rendering at all (hidden tab, no WebGL) must not hold the
  // numbers hostage; a busy one gets until the hard stop to draw
  const soft = window.setTimeout(() => {
    if (renders === 0) fire();
  }, 600);
  const hard = window.setTimeout(fire, 3000);
  cancelPanelPaint = stop;
}

export function selectOption(id: RouteOption["id"]): void {
  // While navigating, guidance follows its own copy of the track. Swapping the
  // drawn route underneath (a mid-ride hazard mark re-plans) would show one
  // line while the voice read another, so keep them in step.
  const wasNavigating = store.navActive;
  if (!trip.select(id)) return;
  const chosen = trip.selected as RouteOption;
  getSource("route").setData(chosen.payload.geojson as GeoJSON.GeoJSON);
  const altFeatures = trip.options
    .filter((o) => o.id !== id)
    .flatMap((o) => o.payload.geojson.features);
  getSource("alts").setData({
    type: "FeatureCollection",
    features: altFeatures,
  } as GeoJSON.GeoJSON);
  // the permalink is written now, not with the panel: a reload a beat after
  // routing used to lose the trip
  links.updateHash.call();
  paintPanelWithRoute(() => {
    renderOptions();
    renderOptionChips();
    showSummary(chosen);
    showOptionsInSheet();
    const s = chosen.payload.summary;
    announce(
      `${chosen.label} route, grade ${chosen.grade}: ${fmtDist(s.meters)}, ${s.minutes} min, ` +
        `${s.pct_protected}% protected.` +
        (trip.options.length > 1 ? ` ${trip.options.length} route options.` : ""),
    );
  });
  if (wasNavigating && store.navActive) {
    // keep the spoken guidance on the line that is actually drawn
    links.rebuildNavFromSelected.call();
  }
}

/** The card to give focus back to once the cards are rebuilt. */
let optionToFocus: RouteOption["id"] | null = null;

export function renderOptions(): void {
  const box = el<HTMLDivElement>("options");
  box.style.display = trip.options.length === 0 ? "none" : "block";
  // One choice among several: a radio group to assistive tech, and walked with
  // the arrow keys. They were click-only divs, so a keyboard could not pick
  // Balanced or Direct at all.
  box.setAttribute("role", "radiogroup");
  box.setAttribute("aria-label", "Route options");
  const focusId = optionToFocus;
  optionToFocus = null;
  render(
    h(OptionCards, {
      options: trip.options,
      selectedId: trip.selectedId,
      focusId,
      gradeColors: GRADE_COLORS,
      gradeText: GRADE_TEXT,
      onSelect: (id, keepFocus) => {
        // the cards are redrawn when the panel repaints; keep the focus with
        // the choice rather than dropping it on the page
        if (keepFocus) optionToFocus = id;
        selectOption(id);
      },
      // hovering a card previews that route on the map; leaving puts the
      // chosen one back
      onPreview: (o) => {
        const shown = o ?? trip.selected;
        if (shown) getSource("route").setData(shown.payload.geojson as GeoJSON.GeoJSON);
      },
    }),
    box,
  );
}

export function initPlanOptions(): void {
  links.selectOption.set(selectOption);
}
