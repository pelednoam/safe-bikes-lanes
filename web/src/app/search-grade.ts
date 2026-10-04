// Grading the search rows: a letter for the route to each candidate, worked out a
// few at a time, kept for the session, and thrown away when anything that changes
// the answer changes.

import { links } from "./links.js";
import { paintSearch, searchView } from "./search-view.js";
import { store } from "./store.js";
import { type SafetyGrade } from "../types.js";
import { gradeLane, routing } from "./services.js";
import { SEARCH_ROWS } from "./search-candidates.js";
import { routeCacheKey } from "../router.js";
import { ensureRouter } from "./data-load.js";

/** The rows currently on screen, so their letters can be withdrawn and redone
 * when the answer they state stops being true. */
let gradedRows: { key: string; lngLat: [number, number] }[] = [];

/** The timer that starts grading shortly after a list is drawn. */
let gradeTimer: number | undefined;

/** The letters on screen describe routes from a particular start under
 * particular settings. When either changes they are answers to a question
 * nobody asked any more, so withdraw them and work them out again. */
export function regradeVisible(): void {
  if (gradedRows.length === 0) return;
  // Never the start-picker list, even when it names the same places as the
  // destination list that was graded: a letter there would describe the route
  // from the current start to a candidate start, which nobody takes.
  if (searchView.target !== "end") return;
  // Never mid-ride. Anything that changes what the router avoids lands here, through
  // applyAvoidPoints (the "avoid this street" chip, a hazard reported from the bike),
  // and grading is up to five routing runs on the main thread — a stall in guidance
  // while someone is riding, to refresh a search list that isn't even on screen.
  if (store.navActive) return;
  // the list is gone, or is another list: nothing to redo
  const listed = new Set(searchView.rows.map((r) => r.key));
  if (!gradedRows.every((r) => listed.has(r.key))) return;
  window.__regradesStarted = (window.__regradesStarted ?? 0) + 1;
  // the old letters go, from the tooltip and the label too, not just the pixel
  for (const row of gradedRows) searchView.grades.set(row.key, { state: "pending" });
  paintSearch();
  void gradeSearchResults(gradedRows);
}

/** Take the placeholders away from a row that will never get a grade.
 *
 * The badge went but the subtitle kept saying "checking the safest way…", so a
 * result the router couldn't reach sat there claiming a computation was still
 * running. Nothing is a better answer than a promise that never resolves. */
function clearGrading(row: { key: string }): void {
  searchView.grades.set(row.key, { state: "hidden" });
  paintSearch();
}

/** Put a row back in play. Without this, hiding was permanent: search with no
 * start, then set one, and the rows stayed blank for ever because nothing ever
 * undid the visibility. */
function showGrading(row: { key: string }): void {
  if (searchView.grades.get(row.key)?.state === "hidden") {
    searchView.grades.set(row.key, { state: "pending" });
    paintSearch();
  }
}

/** Grades already worked out, by routeCacheKey. The key includes avoidRevision, so a
 * change to what the router avoids (applyAvoidPoints bumps it) makes every entry
 * unreachable rather than wrong. */
const gradeCache = new Map<string, { grade: SafetyGrade; meters: number; minutes: number }>();

/** Put the grade of the safest route on each result.
 *
 * The point of the app is that where you go is a safety decision, and until now
 * it only said so after you had chosen. A destination on the far side of an
 * arterial is a D before you set out, and that is worth knowing while you are
 * still looking at a list.
 *
 * Sequential on purpose. Each route needs the map along its corridor, and five
 * destinations in one neighbourhood overlap almost entirely — so the first costs
 * a corridor's worth of tiles and the rest are close to free, where five in
 * parallel would fetch five times over.
 */
async function gradeSearchResults(rows: { key: string; lngLat: [number, number] }[]): Promise<void> {
  const ticket = gradeLane.begin();
  gradedRows = rows;
  // One snapshot of every routing input, taken before the first await. Reading
  // them per row let a preference change land mid-grade: the key was built from
  // the old settings and the route computed with the new ones, so the answer was
  // filed under a description of itself that was already wrong.
  const snap = {
    profileId: store.profileId,
    preferFlat: store.preferFlat,
    avoid: [...store.avoidTypes],
    walkMaxM: store.walkMaxM,
    avoidRevision: store.avoidRevision,
  };
  const from = store.start?.getLngLat();
  if (!from) {
    // no start yet: a grade needs somewhere to start from, and inventing one
    // would be a safety claim about a route nobody asked for
    for (const r of rows) clearGrading(r);
    return;
  }
  const a: [number, number] = [from.lng, from.lat];
  // Every row gets a letter, and the list is capped to make that affordable.
  //
  // This used to be a cap of five under a list of eight, which left three rows
  // showing no grade for no reason a reader could see. The letter is the whole
  // point of this app's search — a row without one is a destination with no
  // safety claim — so the list length and this cap are the same number, and
  // SEARCH_ROWS is where it is set.
  const MAX_GRADED = SEARCH_ROWS;
  for (const row of rows.slice(MAX_GRADED)) clearGrading(row);
  for (const row of rows.slice(0, MAX_GRADED)) {
    showGrading(row); // it may have been cleared by an earlier pass
    if (ticket.stale()) return; // a newer search owns the list now
    const key = routeCacheKey({
      from: a,
      to: row.lngLat,
      profileId: snap.profileId,
      preferFlat: snap.preferFlat,
      avoid: snap.avoid,
      walkMaxM: snap.walkMaxM,
      avoidRevision: snap.avoidRevision,
    });
    let hit = gradeCache.get(key);
    if (hit === undefined) {
      try {
        const mapped = await ensureRouter([a, row.lngLat], 1200, 1);
        if (ticket.stale()) return;
        // routed with the snapshot, so the answer matches the key it is filed
        // under even if the rider changes a preference while this is running
        // by id, not by index: the badge says "safest", and relying on the
        // order routeOptions happens to build its candidates in makes that a
        // safety claim held together by an array position
        const opts = !mapped
          ? undefined
          : await routing.plan(a, row.lngLat, {
              profileId: snap.profileId,
              preferFlat: snap.preferFlat,
              avoid: [...snap.avoid],
              walkMaxM: snap.walkMaxM,
            });
        if (ticket.stale()) return;
        const best = opts?.find((o) => o.id === "safest") ?? opts?.[0];
        if (!best) throw new Error("no route");
        hit = {
          grade: best.grade,
          meters: best.payload.summary.meters,
          minutes: best.payload.summary.minutes,
        };
        gradeCache.set(key, hit);
      } catch {
        // unroutable, or off the edge of the mapped area: say nothing rather
        // than showing a letter we can't stand behind
        if (!ticket.stale()) clearGrading(row);
        continue;
      }
    }
    if (ticket.stale()) return;
    searchView.grades.set(row.key, { state: "graded", grade: hit.grade, meters: hit.meters, minutes: hit.minutes });
    paintSearch();
  }
}

/** Everything about grading the list that was here: the run in flight, the
 * timer that would start one (clearing the run alone left the timer, which
 * went on to grade whatever list was there when it fired, a start-picker
 * list included), and which rows were being graded. */
export function dropGrading(): void {
  gradeLane.cancel();
  window.clearTimeout(gradeTimer);
  gradedRows = [];
}

/** Grade the list once it has stopped changing.
 *
 * The list is now rebuilt on every keystroke, and grading it is up to five routing
 * runs. Typing "playground" therefore queued fifty — each abandoned by the next
 * letter, all of them on the main thread, against a geocoder-rate-limited service
 * that also fetches routing tiles. The rows appear instantly; their letters arrive
 * a moment after the typing stops, which is when they can be read anyway.
 */
export function scheduleGrading(rows: { key: string; lngLat: [number, number] }[]): void {
  window.clearTimeout(gradeTimer);
  gradeTimer = window.setTimeout(() => {
    // not on the bike: grading is up to five routing runs on the main thread
    if (store.navActive) return;
    // still the list these rows were drawn in, and still a list of destinations
    const here = new Set(searchView.rows.map((r) => r.key));
    if (searchView.target !== "end" || !rows.every((r) => here.has(r.key))) return;
    void gradeSearchResults(rows);
  }, 400);
}

export function initSearchGrade(): void {
  links.regradeVisible.set(regradeVisible);
}
