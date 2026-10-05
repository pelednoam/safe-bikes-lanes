// The way ahead is blocked: one tap marks it closed where the rider is, tells the router
// (a blocked report is a closure to it, not a price), and finds another way from here.
// "avoid" is a preference for future routes and re-plans nothing; this is for now.

import { speak, vibrate } from "./nav-voice.js";
import { hideRideAlert, showRideAlert } from "./nav-banner.js";
import { links } from "./links.js";
import { trip } from "./services.js";
import { store } from "./store.js";
import { nav } from "./nav-state.js";
import { buildTrack, distM, pointAlong, snapToTrack } from "../nav.js";
import { addHazard, setHazardCategory } from "../hazards.js";
import { el } from "./dom.js";

/** The way ahead is blocked and the router knows it: say so, and make another route from
 * where the rider is. Aloud and on screen what came of it (a route found, or none), and
 * nothing at all if a newer question took over this one's answer. */
export async function findAnotherWay(): Promise<void> {
  speak("blocked. finding another way.", "safety");
  showRideAlert("🚧 marked blocked — finding another way");
  const outcome = await links.replanRide.call();
  if (outcome === "replanned") {
    speak("found another way.", "turn");
    showRideAlert("🚧 found another way");
  } else if (outcome === "failed") {
    speak("couldn't find a way round. take care.", "safety");
    showRideAlert("🚧 no way round found — take care, or end the ride", "gps");
  } else {
    return;
  }
  window.setTimeout(hideRideAlert, 5000);
}

/** How far ahead of the rider along the route the closure is put. The router closes every
 * street within 30 m of it, both ways, and the rider is inside that zone whatever is done
 * to place it: put it on the rider and the zone is the same size behind as in front, so
 * the cheapest way out of it can be forward, through the blockage. Twenty metres ahead
 * leaves the zone reaching about ten metres behind the rider and fifty in front, so the
 * way out is back, and still covers a barrier anywhere in the next fifty metres. */
const BARRIER_AHEAD_M = 20;

/** Where to put the closure: that far ahead of the rider on the route being ridden, or
 * where the rider is if they are off it (or no route is known). */
function whereItIsBlocked(at: [number, number]): [number, number] {
  const chosen = trip.selected;
  if (chosen === undefined) return at;
  const track = buildTrack(chosen.payload);
  const snap = snapToTrack(track, at[0], at[1]);
  return snap.offM <= 40 ? pointAlong(track, snap.alongM + BARRIER_AHEAD_M) : at;
}

/** One tap, mid-ride: the way ahead is blocked. File it as blocked where the rider is
 * (the report from the bike asks what it was afterwards; this one knows), tell the
 * router, and find another way. */
async function reportBlocked(): Promise<void> {
  if (!store.navActive) return;
  const at = nav.lastPos;
  if (!at) {
    showRideAlert("⚠️ no position yet — can't mark it from here", "gps");
    window.setTimeout(hideRideAlert, 4000);
    return;
  }
  const barrier = whereItIsBlocked(at);
  // tapping again because nothing visible happened must not file a second report
  const near = store.hazards.find((hz) => distM([hz.lon, hz.lat], barrier) < 20);
  try {
    if (near === undefined) {
      await addHazard(
        { id: `${Date.now()}`, t: Date.now(), lon: barrier[0], lat: barrier[1], category: "blocked", note: "", hasPhoto: false },
        null,
      );
    } else if (near.category !== "blocked") {
      await setHazardCategory(near.id, "blocked");
    }
    await links.refreshHazards.call();
  } catch {
    showRideAlert("⚠️ could not save it", "gps");
    window.setTimeout(hideRideAlert, 4000);
    return;
  }
  vibrate([80]);
  await findAnotherWay();
}

export function initHazardBlocked(): void {
  el<HTMLButtonElement>("nav-blocked").addEventListener("click", () => {
    void reportBlocked();
  });
}
