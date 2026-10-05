// The way ahead is blocked: one tap marks it closed a little way ahead of the rider, tells
// the router (a blocked report is a closure to it, not a price), and finds another way
// from here. "avoid" is a preference for future routes and re-plans nothing; this is for now.

import { addHazard, isClosure } from "../hazards.js";
import { buildTrack, distM, trackPassesNear } from "../nav.js";
import { reportCaught } from "../report.js";
import { applyAvoidPoints } from "./avoid.js";
import { el } from "./dom.js";
import { links } from "./links.js";
import { flashRideAlert } from "./nav-banner.js";
import { nav, rideEngine } from "./nav-state.js";
import { speak, vibrate } from "./nav-voice.js";
import { trip } from "./services.js";
import { store } from "./store.js";

/** How far ahead of the rider along the route the closure is put: a rider who stops at a
 * barrier, or sees one just ahead, is in front of it, and the closure belongs on it. The
 * router closes the one street it is on (both ways), so this only has to land on the
 * street being ridden, which the route's own line guarantees. */
const BARRIER_AHEAD_M = 20;
/** A closure this close to where the new one would go is the same barrier. */
const SAME_BARRIER_M = 25;
/** A tap this soon after a closure, and this near it, asks again about the same blockage.
 * The route drawn since leads away from the barrier, so a new mark placed along it would be
 * behind the rider. */
const REPEAT_M = 80;
const REPEAT_WINDOW_MS = 10 * 60_000;
/** A position older than this is where the rider was, not where they are. */
const FIX_FRESH_MS = 15_000;
/** A new route whose line passes this near the barrier is on the street that is closed,
 * not beside it: GPS-scale, because a route that merely passes a parallel street or path
 * (the closure is matched to a street within 15 m, and streets stand closer than that) is
 * another way, as far as the router can tell. */
const THROUGH_M = 8;
/** How long to wait for the device store to take the report before planning without it:
 * the closure is already in memory and with the router, and a store that hangs must not
 * leave the rider with a tap that does nothing. */
const SAVE_WAIT_MS = 1500;

/** One report at a time: a second tap before the first has finished would file another. */
let inFlight = false;

/** Where the rider is now, or null, with an alert saying so, if the last fix is old or
 * there is none. `what` finishes "no position yet — can't ___ from here". */
export function freshFix(what: string): [number, number] | null {
  if (nav.lastPos === null || Date.now() - nav.lastFixAt > FIX_FRESH_MS) {
    flashRideAlert(`⚠️ no position yet — can't ${what} from here`, "gps", 4000);
    return null;
  }
  return nav.lastPos;
}

/** Where the barrier is taken to be: ahead of the rider on the leg they are riding, by the
 * ride engine's own progress (it keeps the right pass on a loop or an out-and-back, and the
 * right track on a detour); where the rider is, if they are off the route. */
function whereItIsBlocked(at: [number, number]): [number, number] {
  return rideEngine.pointAhead(BARRIER_AHEAD_M) ?? at;
}

/** Say what is happening, make another route from where the rider is, and say what came
 * of it. A route that still runs through the barrier (the closure is a very large price,
 * not a wall, so when every way round costs more, or there is none, the router still
 * answers) is not "another way", and is said not to be. */
async function findAnotherWay(barrier: [number, number]): Promise<void> {
  speak("blocked. finding another way.", "safety");
  flashRideAlert("🚧 marked blocked — finding another way", "hazard", 30_000);
  const outcome = await links.replanRide.call();
  if (outcome === "superseded") {
    // a newer re-plan took over; it does not speak, and this alert must not stay
    flashRideAlert("🚧 marked blocked — re-planning", "hazard", 6000);
    return;
  }
  if (outcome === "failed") {
    speak("couldn't find a way round. take care.", "safety");
    flashRideAlert("🚧 no way round found — take care, or end the ride", "gps", 12_000);
    return;
  }
  const chosen = trip.selected;
  if (chosen !== undefined && trackPassesNear(buildTrack(chosen.payload), barrier, THROUGH_M)) {
    speak("the only way on is through it. take care.", "safety");
    flashRideAlert("🚧 no way round: the route goes through it — take care", "gps", 12_000);
    return;
  }
  speak("found another way.", "turn");
  flashRideAlert("🚧 found another way", "hazard", 5000);
}

/** One tap, mid-ride: the way ahead is blocked. File it as blocked ahead of the rider (the
 * report from the bike asks what it was afterwards; this one knows), tell the router, and
 * find another way. Also what choosing "blocked" in the what-was-it row does. */
export async function reportBlocked(): Promise<void> {
  if (!store.navActive || inFlight) return;
  const at = freshFix("mark it");
  if (at === null) return;
  inFlight = true;
  try {
    const now = Date.now();
    const recent = store.hazards.find(
      (h) => isClosure(h, now) && now - h.t < REPEAT_WINDOW_MS && distM([h.lon, h.lat], at) < REPEAT_M,
    );
    if (recent !== undefined) {
      // asking again: the same blockage, so plan again and file nothing
      vibrate([80]);
      await findAnotherWay([recent.lon, recent.lat]);
      return;
    }
    let barrier = whereItIsBlocked(at);
    const same = store.hazards.find((h) => isClosure(h, now) && distM([h.lon, h.lat], barrier) < SAME_BARRIER_M);
    if (same !== undefined) {
      barrier = [same.lon, same.lat];
    } else {
      const report = {
        id: `${now}`,
        t: now,
        lon: barrier[0],
        lat: barrier[1],
        category: "blocked" as const,
        note: "",
        hasPhoto: false,
      };
      // Known now, and with the router before the plan asks, whatever the device store
      // does; saved after, and the saved copy replaces this one when the list is read back.
      store.hazards = [report, ...store.hazards];
      applyAvoidPoints();
      const saved = addHazard(report, null)
        .then(() => links.refreshHazards.call())
        .catch((err: unknown) => {
          reportCaught("error", err);
        });
      await Promise.race([saved, new Promise<void>((resolve) => window.setTimeout(resolve, SAVE_WAIT_MS))]);
    }
    vibrate([80]);
    await findAnotherWay(barrier);
  } finally {
    inFlight = false;
  }
}

export function initHazardBlocked(): void {
  el<HTMLButtonElement>("nav-blocked").addEventListener("click", () => {
    void reportBlocked();
  });
}
