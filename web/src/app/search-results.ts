// The search list on screen: the rows, painting them, choosing one, and clearing
// the list.

import { links } from "./links.js";
import { type GradeView, type SearchRowView } from "../ui/SearchResults.js";
import { el } from "./dom.js";
import { type Ranked, describe as describeRow } from "../search.js";
import { announce } from "./data-load.js";
import { fmtDist } from "../units.js";
import { setPoint, syncOD } from "./markers.js";
import { store } from "./store.js";
import { map } from "./map.js";
import { dropGrading, scheduleGrading } from "./search-grade.js";
import { paintSearch, searchView } from "./search-view.js";
import { promptSavePlace } from "./places.js";

/** Nothing listed: the list is going away. */
export function clearSearchResults(): void {
  dropGrading(); // stop routing for a list that is gone, and the timer to start it
  searchView.rows = [];
  searchView.message = null;
  searchView.active = null;
  searchView.grades = new Map();
  paintSearch();
}

export function renderSearchResults(rows: Ranked[], target: "start" | "end" = "end"): void {
  dropGrading(); // abandon grading for whatever list was here before
  searchView.target = target;
  if (rows.length === 0) {
    searchView.rows = [];
    searchView.grades = new Map();
    searchView.message = "no results in this area";
    paintSearch();
    announce("no results in this area", 700);
    return;
  }
  announce(`${rows.length} place${rows.length === 1 ? "" : "s"} found`, 700);
  const grades = new Map<string, GradeView>();
  const grading: { key: string; lngLat: [number, number] }[] = [];
  searchView.rows = rows.map((r) => {
    // Identity, so an arrow-key selection survives the list being redrawn when
    // the geocoder answers: without it Enter took the first row, not the chosen.
    const key = `${r.name}|${r.lon.toFixed(5)},${r.lat.toFixed(5)}`;
    const lngLat: [number, number] = [r.lon, r.lat];
    // Still checked, for every source. Saved places and recent trips come from
    // localStorage, which is editable and survives across app versions, and a
    // NaN here reaches the router and the route cache key as a coordinate.
    const usable = Number.isFinite(lngLat[0]) && Number.isFinite(lngLat[1]);
    // Only for destinations. A grade on the start-picker list would describe the
    // route from the CURRENT start to a candidate start: a journey nobody is
    // taking, labelled as if they were.
    const graded = usable && target === "end";
    grades.set(key, { state: graded ? "pending" : "hidden" });
    if (graded) grading.push({ key, lngLat });
    return {
      key,
      name: r.name,
      title: [r.name, r.context].filter((p) => p !== undefined && p !== "").join(" — "),
      // What this place is and how far, until the grade replaces it. The old
      // row said "checking the safest way…" and nothing else, so a list of five
      // said the same thing five times while you waited.
      where: describeRow(r, (m) => fmtDist(m)),
      lngLat,
    };
  });
  searchView.grades = grades;
  searchView.message = null;
  paintSearch();
  if (grading.length > 0) scheduleGrading(grading);
}

/** A row picked: its place fills the field the list was searched from. */
export function chooseSearchRow(row: SearchRowView): void {
  const target = searchView.target;
  setPoint(target, row.lngLat);
  const field = el<HTMLInputElement>(target === "start" ? "from-field" : "search");
  field.value = row.name;
  field.classList.remove("picking");
  if (target === "start") store.activeField = "end";
  syncOD();
  map.flyTo({ center: row.lngLat, zoom: 15 });
  clearSearchResults();
  // Close the keyboard and give the map back: the place just chosen, and the
  // route about to be drawn to it, are what the rider wants to see now.
  field.blur();
  links.leaveSearchMode.call(true);
}

/** Save a row of the list as a place, and clear the list (the row's own save button). */
function saveSearchRow(row: SearchRowView): void {
  promptSavePlace(row.lngLat[0], row.lngLat[1]);
  clearSearchResults();
}

export function initSearchResults(): void {
  links.chooseSearchRow.set(chooseSearchRow);
  links.saveSearchRow.set(saveSearchRow);
}
