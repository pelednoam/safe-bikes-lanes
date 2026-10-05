// What the router is told to avoid: the lane types the rider turned off, the marked
// spots, and the construction zones, kept in step with the map and the summary
// line.

import { CLOSURE_LIFETIME_MS, isClosure } from "../hazards.js";
import { type WirePrefs } from "../routing.js";
import { type ConstructionFC, store } from "./store.js";
import { reportCaught } from "../report.js";
import { el } from "./dom.js";
import { links } from "./links.js";
import { routing, trip } from "./services.js";
import { constructionReady, manifestReady } from "./data-load.js";

/** Every routing choice the rider has made, as the router takes them — the one
 * place a trip, a reroute, a detour or a search grade reads them from. The
 * reroute, the detour and the resume each spelled the call out for themselves
 * once, and all three left the walking limit off. */
export function routePrefs(): WirePrefs {
  return { profileId: store.profileId, preferFlat: store.preferFlat, avoid: [...store.avoidTypes], walkMaxM: store.walkMaxM };
}

export function syncAvoidSummary(): void {
  el<HTMLElement>("avoid-summary").textContent =
    store.avoidTypes.size === 0 ? "🛡 avoid lane types" : `🛡 avoiding ${store.avoidTypes.size} lane type${store.avoidTypes.size > 1 ? "s" : ""}`;
}

/** Sample construction geometries into avoid-points for the router. */
export function constructionAvoidPoints(fc: ConstructionFC): [number, number][] {
  const pts: [number, number][] = [];
  const pushCoord = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      pts.push([c[0], c[1]]);
    }
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === "Point") pushCoord(g.coordinates);
    else if (g.type === "LineString" && Array.isArray(g.coordinates)) {
      for (const c of g.coordinates) pushCoord(c);
    } else if (Array.isArray(g.coordinates)) {
      for (const part of g.coordinates) {
        if (Array.isArray(part)) for (const c of part) pushCoord(c);
      }
    }
  }
  return pts;
}

/** The last points sent, so the same set is not sent (and graded) twice. */
let lastAvoidPoints = "";
/** When the earliest live closure lapses: applyAvoidPoints runs again then. */
let lapseTimer = 0;

/** Routes avoid the rider's marks and hazard reports, and go round a closure.
 *
 * This is the one place either changes what the router is told, so it is also
 * where a grade computed before is made stale: a filed hazard, a restored backup
 * and a marked spot all land here. The search rows are graded again after the
 * router has the new points, not before, or they would be graded against the old. */
export function applyAvoidPoints(): void {
  // A report filed as blocked, and not yet lapsed, is a closure and goes to the router as
  // one; every other report (a blocked one from before closures, or one that has lapsed,
  // included) and the rider's own marks are a price.
  const priced: [number, number][] = [...store.sketchyMarks];
  const closed: [number, number][] = [];
  const now = Date.now();
  let lapsesAt = Infinity;
  for (const h of store.hazards) {
    if (isClosure(h, now)) {
      closed.push([h.lon, h.lat]);
      lapsesAt = Math.min(lapsesAt, h.t + CLOSURE_LIFETIME_MS);
    } else {
      priced.push([h.lon, h.lat]);
    }
  }
  // A closure lapses back to a price by itself, and an app left open (a phone on a bike
  // mount, an installed page) must notice, so it is applied again then.
  window.clearTimeout(lapseTimer);
  if (Number.isFinite(lapsesAt)) lapseTimer = window.setTimeout(applyAvoidPoints, lapsesAt - now + 1000);
  // Only a change in what is priced or closed makes a grade stale, and only a change is
  // sent. This also runs at start-up (twice), and for a hazard whose category changed
  // between two prices, and bumping the revision then would throw away every grade worked
  // out and start the work again; a change to or from being a closure is a change in what
  // is closed, and does count. (The worker answers in the order it was asked, so the points
  // are in before the grading's first plan; a second call while one is grading takes over
  // its lane.)
  const key = JSON.stringify([priced, closed]);
  if (key === lastAvoidPoints) return;
  lastAvoidPoints = key;
  void routing.setSketchyMarks(priced);
  void routing.setBlockedPoints(closed);
  store.avoidRevision++;
  links.regradeVisible.call();
}


/** Resolves once the saved hazards and marks have been sent to the router (set in
 * initAvoid). */
let avoidReady: Promise<void> = Promise.resolve();
/** The wait ran out, and plans went ahead without the hazards: later plans don't wait
 * again, so a device store that never answers costs one pause and not one per route. */
let gaveUp = false;
/** A plan was drawn before the points were in: plan again when they arrive. */
let plannedWithoutAvoid = false;

/** Wait for the saved hazards and marks to reach the router, for three seconds at most:
 * a device store that hangs must not stop every route. A plan waits for it so that the
 * first route of a session is not drawn through a hazard the rider reported. If the
 * wait runs out the plan goes ahead, and is made again when the points do arrive (see
 * initAvoid), by the planner that made it: a ride, a round trip or a trip between two
 * points. */
export async function avoidPointsSent(): Promise<void> {
  if (gaveUp) {
    plannedWithoutAvoid = true;
    return;
  }
  let timer = 0;
  const late = new Promise<"late">((resolve) => {
    timer = window.setTimeout(() => resolve("late"), 3000);
  });
  const result = await Promise.race([avoidReady.then(() => "ready" as const), late]);
  window.clearTimeout(timer);
  if (result === "late") {
    gaveUp = true;
    plannedWithoutAvoid = true;
  }
}

/** Everything a plan needs before it may ask the router: the routing data, and the
 * rider's hazards and marks in it. */
export async function routingInputsReady(): Promise<void> {
  await manifestReady;
  await avoidPointsSent();
}

export function initAvoid(): void {
  // Read once the routing data is in. Not part of the chain that says routing is
  // ready, so a failure here can't take routing down with it.
  avoidReady = manifestReady
    .then(() => links.refreshHazards.call())
    .catch((err: unknown) => reportCaught("error", err));
  void avoidReady.then(() => {
    gaveUp = false;
    if (!plannedWithoutAvoid) return;
    plannedWithoutAvoid = false;
    // what is on screen was planned without them: plan it again, by the planner that
    // made it. A ride re-plans from where the rider is, a round trip as a round trip
    // (requestRoute would make it an A-to-B and drop it), a trip between two points as
    // that. (A plan still under way when they arrive notices for itself: see
    // requestRoute and requestLoop.)
    if (store.navActive) void links.replanRide.call();
    else if (store.loopParams !== null) void links.requestLoop.call();
    else if (store.end !== null && trip.options.length > 0) void links.requestRoute.call();
  });

  // construction avoidance for the router as soon as the zones load (the worker
  // keeps it, and applies it to every graph it builds)
  void constructionReady.then(() => {
    if (store.constructionFC) void routing.setConstructionPoints(constructionAvoidPoints(store.constructionFC));
  });
}
