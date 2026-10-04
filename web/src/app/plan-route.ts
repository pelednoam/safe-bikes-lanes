// Asking for a route: where it starts, planning it with the rider's preferences,
// what to say when it can't be done, and planning between two points picked from a
// list.

import { links } from "./links.js";
import { type Ticket } from "../planner.js";
import { routeLane, routing, trip } from "./services.js";
import { build } from "./build-state.js";
import { endWhatIf, showRealTrip } from "./build-whatif.js";
import { el } from "./dom.js";
import { type Marker } from "maplibre-gl";
import { store } from "./store.js";
import { ensureRouter, showStage } from "./data-load.js";
import { currentPosition, makeMarker, syncOD } from "./markers.js";
import { routePrefs, routingInputsReady } from "./avoid.js";
import { type RouteOption } from "../types.js";
import { clearOptionChips, renderOptions, selectOption } from "./plan-options.js";
import { recordRecentRoute } from "./places.js";
import { revealSheet } from "./sheet.js";
import { nameEnd } from "./names.js";

/** What went wrong, in words for a parent rather than for whoever wrote the
 * router. Its messages ("start and end snap to the same intersection", "no
 * path found", "failed to load routing tiles: TypeError: Failed to fetch")
 * reached the screen as they were. The router keeps its own wording, which its
 * tests and logs rely on; this only decides what is shown. */
export function plainError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // the round trip's own messages are already written for people
  if (/try another distance/i.test(raw)) return `${raw.charAt(0).toUpperCase()}${raw.slice(1)}.`;
  if (/same intersection/i.test(raw)) {
    return (
      "The start and the destination are the same spot. " +
      "Pick a destination a little further away."
    );
  }
  if (/no path found|no route/i.test(raw)) {
    return (
      "There's no way to ride between these two points on the streets we have mapped. " +
      "Try a spot on a nearby street for either end."
    );
  }
  if (/too far from the mapped/i.test(raw)) {
    return (
      "That spot is too far from any street we have mapped. " +
      "Pick a point on or next to a street."
    );
  }
  if (/isn't mapped|unmapped/i.test(raw)) {
    return (
      "This area isn't mapped for routing yet — the map covers Cambridge, Somerville " +
      "and the towns around them."
    );
  }
  if (/fetch|network|load|TypeError/i.test(raw)) {
    return "Couldn't download the map needed for this route. Check your connection and try again.";
  }
  console.warn("route failed", err);
  return "Something went wrong planning this route. Try again, or pick a slightly different spot.";
}

/** Take the route options for a new plan. Whatever was planning before is now
 * stale and will not write its answer; the loading line is this plan's to show
 * or not, so an abandoned plan's spinner is taken down here rather than left for
 * a request that has returned without drawing anything. */
export function beginPlan(): Ticket {
  const ticket = routeLane.begin();
  // A hypothetical trip belongs to the ends and settings it was asked about.
  // The real trip goes back on screen, not just out of memory: forgotten, the
  // proposed lane's routes stayed up whenever this plan stopped short or
  // failed, and ▶ Navigate rode a lane that doesn't exist.
  const real = build.whatIfReal;
  endWhatIf();
  if (real !== null) showRealTrip(real);
  el<HTMLDivElement>("loading").style.display = "none";
  return ticket;
}

/** Where the rider is, as the start, once a location wait is over. Null when
 * the wait was superseded or withdrawn (Reset, a newer plan) — the start is then
 * not this plan's to set. Someone else may have put a start down while we
 * waited, the load-time locate or a tap on the map; that one stands, rather
 * than a second pin going down on top of it. */
export async function locateStart(ticket: Ticket, onFail: string): Promise<Marker | null> {
  if (store.start !== null) return store.start;
  showStage("Finding your location…");
  let here: [number, number];
  try {
    here = await currentPosition();
  } catch {
    if (ticket.stale()) return null;
    el<HTMLDivElement>("loading").style.display = "none";
    const errBox = el<HTMLDivElement>("error");
    errBox.textContent = onFail;
    errBox.style.display = "block";
    return null;
  }
  if (ticket.stale()) return null;
  if (store.start === null) {
    store.start = makeMarker(here, "#2b83ba", "start");
    syncOD();
  }
  return store.start;
}

export async function requestRoute(): Promise<void> {
  // Mid-ride, a re-plan is a way on from here. Marking a sketchy street,
  // filing a hazard or dragging a pin all end up here, and used to re-plan the
  // whole trip from the start pin — which navigation then switched to, telling
  // a rider a mile down the road to go back to the beginning.
  if (store.navActive) {
    void links.replanRide.call();
    return;
  }
  const ticket = beginPlan();
  if (!store.end) return;
  await routingInputsReady();
  if (ticket.stale()) return;
  const errBox = el<HTMLDivElement>("error");
  errBox.style.display = "none";
  const loading = el<HTMLDivElement>("loading");
  if (!store.start) {
    if (!store.fromCurrent) return;
    const located = await locateStart(
      ticket,
      "Couldn't find where you are. Type a start in \u201cYour location\u201d, tap 🗺 to " +
        "pick it on the map, or allow location access.",
    );
    if (located === null) return;
  }
  showStage("Loading the map around your route…");
  const progress = (done: number, total: number): void => {
    // only once there are enough for the count to mean something
    if (total > 4 && !ticket.stale()) {
      showStage("Loading the map around your route…", `${done} of ${total}`);
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Reset, or a newer plan, while we yielded: both ends may be gone
  if (ticket.stale() || !store.start || !store.end) return;
  try {
    const s = store.start.getLngLat();
    const d = store.end.getLngLat();
    const a: [number, number] = [s.lng, s.lat];
    const b: [number, number] = [d.lng, d.lat];
    // load the tiles along the corridor, then route; a safe route can detour
    // well outside the straight A–B box, so widen the loaded area once if the
    // first attempt finds nothing.
    const route = (): Promise<RouteOption[]> => {
      showStage("Finding the safest way…");
      return routing.plan(a, b, routePrefs());
    };
    // Computed into a local and only published once this plan is known to be
    // the current one: `options` is what the cards, the chips and navigation
    // all read, and an abandoned plan must not have written it.
    let found: RouteOption[] = [];
    // a narrow corridor first — it covers ordinary detours and keeps a long
    // trip from pulling a big slice of the map; the retry below widens it
    let mapped = await ensureRouter([a, b], 1200, 1, progress);
    if (ticket.stale()) return;
    try {
      if (!mapped) throw new Error("unmapped");
      found = await route();
      if (!found.length) throw new Error("no route");
    } catch {
      if (ticket.stale()) return;
      mapped = await ensureRouter([a, b], 5000, 2, progress);
      if (ticket.stale()) return;
      if (!mapped) throw new Error("this area isn't mapped for routing yet");
      found = await route();
    }
    const fallback = found[0];
    if (!fallback) throw new Error("no route found");
    if (!trip.publish(ticket, found)) return;
    // an A-to-B trip replaces a round trip, and its stop
    store.poiMarker?.remove();
    store.poiMarker = null;
    store.loopParams = null;
    const wanted = store.pendingSelect;
    store.pendingSelect = null;
    selectOption(wanted !== null && trip.options.some((o) => o.id === wanted) ? wanted : fallback.id);
    recordRecentRoute([s.lng, s.lat], [d.lng, d.lat]);
    revealSheet();
    links.frameRoute.call(fallback);
  } catch (err) {
    if (ticket.stale()) return;
    store.poiMarker?.remove();
    store.poiMarker = null;
    store.loopParams = null;
    trip.clear();
    renderOptions();
    clearOptionChips();
    errBox.textContent = plainError(err);
    errBox.style.display = "block";
  } finally {
    // a newer plan owns the loading line now; hiding it would hide theirs
    if (!ticket.stale()) loading.style.display = "none";
  }
}

export function planBetween(s: [number, number], e: [number, number]): void {
  store.fromCurrent = false;
  syncOD();
  if (store.start) store.start.setLngLat(s);
  else store.start = makeMarker(s, "#2b83ba", "start");
  if (store.end) store.end.setLngLat(e);
  else store.end = makeMarker(e, "#d7191c", "end");
  nameEnd("start");
  nameEnd("end");
  void requestRoute();
}

export function initPlanRoute(): void {
  links.requestRoute.set(requestRoute);
  links.planBetween.set(planBetween);
  links.beginPlan.set(beginPlan);
}
