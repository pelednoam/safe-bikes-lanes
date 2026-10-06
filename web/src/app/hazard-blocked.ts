// The way ahead is blocked: one tap marks it closed a little way ahead of the rider, tells
// the router (a blocked report is a closure to it, not a price), and finds another way
// from here. "avoid" is a preference for future routes and re-plans nothing; this is for now.

import { addHazard, isClosure } from "../hazards.js";
import { buildTrack, distM, trackPassesNear } from "../nav.js";
import { reportCaught } from "../report.js";
import { applyAvoidPoints } from "./avoid.js";
import { el } from "./dom.js";
import { links } from "./links.js";
import { flashRideAlert, freshFix } from "./nav-banner.js";
import { rideEngine } from "./nav-state.js";
import { speak, vibrate } from "./nav-voice.js";
import { routing, trip } from "./services.js";
import { store } from "./store.js";

/** How far ahead of the rider along the route the closure is put (never past the next turn,
 * see RideEngine.pointAhead): a rider who stops at a barrier, or sees one just ahead, is in
 * front of it, and the closure belongs on it. The router closes the one street it is on (both
 * ways), so this only has to land on the street being ridden. */
const BARRIER_AHEAD_M = 20;
/** A closure this close to where the new one would go is the same barrier. */
const SAME_BARRIER_M = 25;
/** A tap this soon after the last one, from where the rider has hardly moved, asks again about
 * the same blockage. The route drawn since leads away from the barrier, so a closure placed
 * ahead on it would be on a street that is not blocked. A rider who has moved on, to a
 * second barrier round the corner, is a new report. */
const REPEAT_WINDOW_MS = 10 * 60_000;
const REPEAT_MOVED_M = 30;
/** A new route whose line passes this near a closure is on the street that is closed, not
 * beside it: GPS-scale, because a route that merely passes a parallel street or path (a closure
 * is matched to a street within 15 m, and streets stand closer than that) is another way, as
 * far as the router can tell. */
const THROUGH_M = 8;
/** How long to wait for the device store to take the report before planning without it: the
 * closure is already in memory and with the router, and a store that hangs must not leave the
 * rider with a tap that does nothing. */
const SAVE_WAIT_MS = 1500;

/** One report at a time: a second tap before the first has finished would file another. */
let inFlight = false;
/** The last blocked tap: where the rider was, where the barrier was put, and when. */
let lastTap: { at: [number, number]; barrier: [number, number]; t: number } | null = null;

/** Whether a route runs along any closure that is live, which "another way" must not. */
function runsThroughClosure(barrier: [number, number]): boolean {
  const chosen = trip.selected;
  if (chosen === undefined) return false;
  const track = buildTrack(chosen.payload);
  const now = Date.now();
  const closures = store.hazards.filter((h) => isClosure(h, now)).map((h): [number, number] => [h.lon, h.lat]);
  return [barrier, ...closures].some((c) => trackPassesNear(track, c, THROUGH_M));
}

/** Say what is happening, make another route from where the rider is, and say what came of
 * it. A route that still runs through a closure (it is a very large price, not a wall, so when
 * every way round costs more, or there is none, the router still answers) is not "another way",
 * and is said not to be. `unsaved`: the closure is only in memory, and is lost on a restart. */
async function findAnotherWay(barrier: [number, number], unsaved: boolean, shut: boolean): Promise<void> {
  const note = unsaved ? " (could not be saved: it is lost when the app closes)" : "";
  speak("blocked. finding another way.", "safety");
  flashRideAlert("🚧 marked blocked — finding another way", "hazard", 30_000);
  const outcome = await links.replanRide.call();
  if (outcome === "superseded") {
    // a newer re-plan took over; it does not speak, and this alert must not stay
    flashRideAlert(`🚧 marked blocked — re-planning${note}`, "hazard", 6000);
    return;
  }
  // "hazard", not "gps": the next accepted fix takes a gps alert down, and this must be read
  if (outcome === "failed") {
    speak("couldn't find a way round. take care.", "safety");
    flashRideAlert(`🚧 no way round found — take care, or end the ride${note}`, "hazard", 12_000);
    return;
  }
  if (shut) {
    // closed on both sides: whichever way the route goes out, it crosses a barrier
    speak("blocked on both sides. the way out goes through a barrier. take care.", "safety");
    flashRideAlert(`🚧 blocked on both sides: the way out crosses a barrier — take care${note}`, "hazard", 12_000);
    return;
  }
  if (runsThroughClosure(barrier)) {
    speak("the only way on is through it. take care.", "safety");
    flashRideAlert(`🚧 no way round: the route goes through it — take care${note}`, "hazard", 12_000);
    return;
  }
  speak("found another way.", "turn");
  flashRideAlert(`🚧 found another way${note}`, "hazard", unsaved ? 8000 : 5000);
}

/** File the closure: in memory and with the router at once, and in the device store after.
 * Resolves to whether the store took it, or null if it had not answered in time. */
async function fileClosure(barrier: [number, number], now: number): Promise<boolean | null> {
  const report = {
    id: `${now}`,
    t: now,
    lon: barrier[0],
    lat: barrier[1],
    category: "blocked" as const,
    note: "",
    hasPhoto: false,
  };
  // Kept beside what is read from the store until a read has it, so a read that started
  // earlier and finishes late cannot take it out of the router's hands.
  store.pendingHazards = [report, ...store.pendingHazards];
  store.hazards = [report, ...store.hazards];
  applyAvoidPoints();
  const saved = addHazard(report, null)
    .then(() => links.refreshHazards.call())
    .then(() => true)
    .catch((err: unknown) => {
      reportCaught("error", err);
      return false;
    });
  let timer = 0;
  const late = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => {
      resolve(null);
    }, SAVE_WAIT_MS);
  });
  try {
    return await Promise.race([saved, late]);
  } finally {
    window.clearTimeout(timer);
  }
}

/** One tap, mid-ride: the way ahead is blocked. File it as blocked ahead of the rider (the
 * report from the bike asks what it was afterwards; this one knows), tell the router, and
 * find another way. Also what choosing "blocked" in the what-was-it row does. Resolves to
 * whether it did anything: false for no recent position, no ride, or a tap already being
 * answered. */
export async function reportBlocked(): Promise<boolean> {
  if (!store.navActive || inFlight) return false;
  const at = freshFix("mark it");
  if (at === null) return false;
  inFlight = true;
  try {
    const now = Date.now();
    let barrier: [number, number];
    let saved: boolean | null = true;
    if (lastTap !== null && now - lastTap.t < REPEAT_WINDOW_MS && distM(lastTap.at, at) < REPEAT_MOVED_M) {
      // asking again from the same place: the same blockage, so plan again and file nothing
      barrier = lastTap.barrier;
    } else {
      barrier = rideEngine.pointAhead(BARRIER_AHEAD_M) ?? at;
      const same = store.hazards.find((h) => isClosure(h, now) && distM([h.lon, h.lat], barrier) < SAME_BARRIER_M);
      if (same !== undefined) barrier = [same.lon, same.lat];
      else saved = await fileClosure(barrier, now);
      lastTap = { at, barrier, t: now };
    }
    vibrate([80]);
    // asked after the closure is with the router: the worker answers in the order it is asked
    const shut = await routing.shutIn(at).catch(() => false);
    await findAnotherWay(barrier, saved === false, shut);
    return true;
  } finally {
    inFlight = false;
  }
}

export function initHazardBlocked(): void {
  el<HTMLButtonElement>("nav-blocked").addEventListener("click", () => {
    void reportBlocked();
  });
}
