// The ride itself: the engine that judges each fix against the route, what it asks
// for (re-plan, rejoin, speak), the tickets that keep an old answer from landing
// late, and saving the ride when it ends.

import { links, type ReplanOutcome } from "./links.js";
import { loopLegs, nav, rideEngine } from "./nav-state.js";
import { store } from "./store.js";
import { saveRide, stashInProgress } from "../rides.js";
import { speak, vibrate } from "./nav-voice.js";
import { lengthVoice } from "../units.js";
import { type RouteOption } from "../types.js";
import { type RideEffect } from "../ride.js";
import { loopRejoinPoint, payloadLength, rejoinOption } from "../rejoin.js";
import { routing, trip } from "./services.js";
import { avoidPointsSent, routePrefs } from "./avoid.js";
import { Lane, type Ticket } from "../planner.js";
import { selectOption } from "./plan-options.js";
import { hideRideAlert, showBanner, showHeadline, showRideAlert, showTrip } from "./nav-banner.js";
import { type NativeFix } from "../native.js";
import { maplibregl } from "../maplibre.js";
import { map } from "./map.js";
import { compassPoint, navStartAnimation } from "./nav-camera.js";
import { getSource } from "./sources.js";
import { el } from "./dom.js";

/** Persist the in-progress ride every N fixes (cheap; finish() only reads). */
const STASH_EVERY_FIXES = 20;

let navFixesSinceStash = 0;

export function finishAndSaveRide(): void {
  const ride = nav.recorder?.finish(store.profileId);
  nav.recorder = null;
  stashInProgress(null);
  if (!ride) return;
  saveRide(ride);
  speak(`ride saved. ${lengthVoice(ride.meters)}.`, "chat");
}

/** Route options from where the rider is to where the ride is going: back onto
 * what is left of a loop, or to the destination. Null when there is nowhere
 * to go (no destination yet). */
export async function rideOptionsFrom(
  from: [number, number],
  heading?: number,
  toward: { dest: [number, number] | null; onDetour: boolean } = {
    dest: nav.dest,
    onDetour: nav.originalDest !== null,
  },
): Promise<RouteOption[] | null> {
  const loop = nav.loop;
  if (loop !== null && !toward.onDetour) {
    const target = loopRejoinPoint(loop.payload, rideEngine.loopDoneM);
    if (target !== null) {
      const lead = (await routing.plan(from, target.at, routePrefs(), heading))[0];
      if (!lead) return [];
      const back = rejoinOption(lead, loop, target.index);
      loopLegs.set(back, { legM: payloadLength(lead.payload), resumeM: target.atM });
      return [back];
    }
    // what is left of the loop is shorter than the way onto it: finish
  }
  return toward.dest === null ? null : routing.plan(from, toward.dest, routePrefs(), heading);
}

/** Every way on the ride plans mid-ride — a re-plan, a reroute, a detour, the
 * way back from one — owns what the ride follows next, and the newest wins. An
 * answer that arrives after the ride ended, or after a newer one was asked
 * for, is dropped: guidance switching to a route for a wrong turn already put
 * right is worse than none. */
export const rideLane = new Lane();

export const rideStale = (ticket: Ticket): boolean => ticket.stale() || !store.navActive;

/** A ride's ticket as the trip takes it: stale too once the ride is over. */
export const rideTicket = (ticket: Ticket): Ticket => ({ stale: () => rideStale(ticket) });

/** A reroute is also dropped when the rider rejoins before it arrives. */
const rerouteLane = new Lane();

/** Re-plan the ride from where the rider is, keeping where it is going: after
 * something changed what the router must avoid. */
export async function replanRide(): Promise<ReplanOutcome> {
  if (!store.routerReady || !nav.lastPos) return "failed";
  // The ticket first, so a ride that ends, restarts or reroutes while this waits
  // supersedes it and it is not mistaken for the newest question when it resumes.
  const ticket = rideLane.begin();
  // a ride resumed after the page reloaded must not reroute before its hazards are in
  await avoidPointsSent();
  const from = nav.lastPos;
  if (rideStale(ticket) || !store.navActive || from === null) return "superseded";
  // The destination pin may be why: dragged mid-ride, it used to re-plan to
  // where the ride had been going, with the pin and the guidance apart. On a
  // detour the pin is still the ride's destination, the one Resume returns to;
  // a round trip's pin is its start, which it already ends at.
  const pin = store.end?.getLngLat();
  if (pin !== undefined && nav.loop === null) {
    if (nav.originalDest !== null) nav.originalDest = [pin.lng, pin.lat];
    else nav.dest = [pin.lng, pin.lat];
  }
  try {
    const found = await rideOptionsFrom(from);
    if (rideStale(ticket)) return "superseded";
    const first = found?.[0];
    if (!found || !first) return "failed";
    if (!trip.publish(rideTicket(ticket), found)) return "superseded";
    selectOption(first.id);
    rebuildNavFromSelected();
    return "replanned";
  } catch {
    if (rideStale(ticket)) return "superseded";
    showRideAlert("⚠ couldn't re-plan from here — keep to the route", "gps");
    window.setTimeout(hideRideAlert, 4000);
    return "failed";
  }
}

export function rebuildNavFromSelected(): boolean {
  const sel = trip.selected;
  if (!sel) return false;
  // a detour to a stop is off the loop; the loop itself is on it from the start
  const leg = loopLegs.get(sel) ?? (nav.loop !== null && sel === nav.loop ? { legM: 0, resumeM: 0 } : null);
  rideEngine.setRoute(sel.payload, leg);
  return true;
}

export function navOnFix(fix: NativeFix): void {
  if (!store.navActive) return;
  const step = rideEngine.onFix(fix, Date.now());
  if (step === null) return;
  nav.lastPos = [fix.lon, fix.lat];
  nav.lastFixAt = Date.now();
  // keep the ride recoverable: Back, a reload or a crash used to lose it all
  if (nav.recorder && ++navFixesSinceStash >= STASH_EVERY_FIXES) {
    navFixesSinceStash = 0;
    stashInProgress(nav.recorder.finish(store.profileId));
  }
  nav.recorder?.addPoint(Date.now(), fix.lon, fix.lat, step.cls, step.alongM);
  nav.posTarget = step.dot;
  if (!nav.dot) {
    const dot = document.createElement("div");
    dot.className = "nav-dot";
    nav.dot = new maplibregl.Marker({ element: dot }).setLngLat(nav.posTarget).addTo(map);
    nav.posShown = nav.posTarget;
  }
  navStartAnimation();
  for (const effect of step.effects) applyRideEffect(effect);
  // dim the ridden part of the route so progress reads at a glance
  if (step.done !== null) {
    getSource("route-done").setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: step.done },
    } as GeoJSON.GeoJSON);
  }
}

function applyRideEffect(e: RideEffect): void {
  switch (e.type) {
    case "speak":
      speak(e.text, e.priority);
      return;
    case "vibrate":
      vibrate(e.pattern);
      return;
    case "alert":
      showRideAlert(e.text, e.kind);
      return;
    case "clearGpsAlert":
      if (el<HTMLDivElement>("nav-alert").classList.contains("gps")) hideRideAlert();
      return;
    case "hideAlert":
      hideRideAlert();
      return;
    case "offRoute":
      showHeadline({ icon: "↩", dist: "off route", street: "adjusting…" });
      return;
    case "banner":
      showBanner(e.maneuver, e.distToNextM);
      return;
    case "trip":
      showTrip(e);
      return;
    case "reroute":
      void rerouteFrom(e.from, e.heading);
      return;
    case "rejoined":
      rerouteLane.cancel();
      return;
    case "arrived":
      links.showArrival.call(e.atStop, e.totalM);
      return;
  }
}

/** A wrong turn: plan the way on from here, and say which way it goes. */
async function rerouteFrom(from: [number, number], heading: number | null): Promise<void> {
  const ride = rideLane.begin();
  const mine = rerouteLane.begin();
  const ticket: Ticket = { stale: () => ride.stale() || mine.stale() };
  try {
    const found = await rideOptionsFrom(from, heading ?? undefined);
    if (rideStale(ticket)) return;
    if (found !== null && !trip.publish(rideTicket(ticket), found)) return;
    const first = found?.[0];
    if (first) {
      selectOption(first.id);
      rebuildNavFromSelected();
      // tell the rider a new way exists and which way it goes, instead of
      // leaving "adjusting…" up while a fresh route sits undrawn-to
      const back = rideEngine.rejoinBearing();
      showRideAlert(
        back === null
          ? "⚠ off route — new route ready"
          : `⚠ off route — head ${compassPoint(back)} to rejoin`,
        "gps",
      );
    }
  } catch {
    if (rideStale(ticket)) return;
    showRideAlert("⚠ off route — no way back from here", "gps");
  }
}

export function initNavRide(): void {
  links.rebuildNavFromSelected.set(rebuildNavFromSelected);
  links.replanRide.set(replanRide);
}
