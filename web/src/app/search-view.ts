// The search list as it is on screen: its rows, which one is active, the grades
// each has, and drawing it.

import { type GradeView, SearchResults, type SearchRowView } from "../ui/SearchResults.js";
import { h, render } from "preact";
import { GRADE_COLORS, GRADE_TEXT } from "../segment.js";
import { links } from "./links.js";
import { el } from "./dom.js";

/** The search list, which is all the list is: drawn from here
 * (src/ui/SearchResults.tsx). Grading, the arrow keys and every way of
 * closing the list change this and redraw it, instead of reaching into rows
 * that a keystroke or the geocoder may already have replaced. */
export const searchView: {
  rows: SearchRowView[];
  target: "start" | "end";
  active: string | null;
  grades: Map<string, GradeView>;
  message: string | null;
} = { rows: [], target: "end", active: null, grades: new Map(), message: null };

export function paintSearch(): void {
  render(
    h(SearchResults, {
      rows: searchView.rows,
      target: searchView.target,
      active: searchView.active,
      grades: searchView.grades,
      message: searchView.message,
      gradeColors: GRADE_COLORS,
      gradeText: GRADE_TEXT,
      onChoose: (row) => links.chooseSearchRow.call(row),
      onSave: (row) => links.saveSearchRow.call(row),
    }),
    el<HTMLDivElement>("search-results"),
  );
}

/** Whether there is anything in the list at all, rows or a message. */
export function searchListShown(): boolean {
  return searchView.rows.length > 0 || searchView.message !== null;
}
