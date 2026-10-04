// Starting a ride, ending it, arriving, resuming after a detour to a stop, and
// keeping the screen on while it lasts.

import { links } from "./links.js";
import { ScreenLock, type WakeLockApi } from "../lifecycle.js";
import { closeAsk, hideRideAlert, showHeadline, showTripLine, stopsOpen } from "./nav-banner.js";
import { el, emptyFC } from "./dom.js";
import { fmtDist } from "../units.js";
import { finishAndSaveRide, rebuildNavFromSelected, rideLane, rideOptionsFrom, rideStale, rideTicket } from "./nav-ride.js";
import { clearWhatIf } from "./build-whatif.js";
import { routing, trip } from "./services.js";
import { nav, rideEngine } from "./nav-state.js";
import { store } from "./store.js";
import { clearSearchResults } from "./search-results.js";
import { map } from "./map.js";
import { RideRecorder } from "../rides.js";
import { navStopAnimation, setRecentreNeeded } from "./nav-camera.js";
import { applyBasemap } from "./dark-mode.js";
import { clearSpeech, speak } from "./nav-voice.js";
import { keepScreenOn, stopBackgroundWatcher } from "../native.js";
import { navStartLocation } from "./nav-location.js";
import { getSource } from "./sources.js";
import { swReload } from "./app-update.js";
import { routePrefs } from "./avoid.js";
import { selectOption } from "./plan-options.js";
import { POI_META } from "./classes.js";

/** The screen stays on for the whole ride, taken back after every app switch
 * (see lifecycle.ts). */
const screenLock = new ScreenLock(
  // typed as always-present; Safari before 16.4 has none
  () => navigator.wakeLock as WakeLockApi | undefined,
  () => document.visibilityState === "visible",
);

/** How long after a ride ends a held-back reload waits: long enough for the
 * "ride saved" line to be heard. */
const RELOAD_AFTER_RIDE_MS = 5000;

export function showArrival(atStop: boolean, totalM: number): void {
  if (atStop) {
    showHeadline({ icon: "🛑", dist: "At the stop", street: "tap ▶ resume to ride on" });
    el<HTMLButtonElement>("nav-resume").style.display = "inline-block";
    return;
  }
  showHeadline({ icon: "🏁", dist: "Arrived", street: navDestLabel ?? "you're there" });
  showTripLine({ remaining: `${fmtDist(totalM)} ridden`, speed: "" });
  hideRideAlert();
  finishAndSaveRide();
}

/** Which ride this is: a ride's startup waits (the wake lock, a permission
 * dialog), and one ended and followed by another in the meantime must not
 * carry on inside the new one. */
let rideGen = 0;

export async function startNav(): Promise<void> {
  // a ride follows the streets as they are, never a what-if's proposed lane
  clearWhatIf();
  const chosen = trip.selected;
  nav.loop = chosen !== undefined && chosen.id.startsWith("loop") ? chosen : null;
  rideEngine.start();
  if (!rebuildNavFromSelected()) return;
  const destLngLat = store.end?.getLngLat() ?? store.start?.getLngLat();
  if (!destLngLat) return;
  // The ride has started, and the main thread is the guidance's: a search list left
  // open would go on grading, up to five routing runs, while the rider is on the bike.
  // Cleared only here, after the checks that can still send the rider back to the
  // plan, so a start that didn't happen leaves the list as it was. (A grade already
  // sent to the router still finishes there, one run; none is started after.)
  clearSearchResults();
  nav.dest = [destLngLat.lng, destLngLat.lat];
  // A round trip has no destination field of its own; the one on screen still
  // names wherever the rider last searched for.
  navDestLabel =
    nav.loop !== null
      ? "back where you started"
      : el<HTMLInputElement>("search").value.trim().split(",")[0] || null;
  nav.originalDest = null;
  el<HTMLButtonElement>("nav-resume").style.display = "none";
  store.navActive = true;
  const ride = ++rideGen;
  nav.following = true;
  nav.userZoom = false;
  nav.voiceWarned = false;
  nav.bearingShown = map.getBearing();
  nav.recorder = new RideRecorder();
  document.body.classList.add("navigating");
  el<HTMLDivElement>("nav-banner").style.display = "block";
  setRecentreNeeded(false);
  map.setLayoutProperty("route-done", "visibility", "visible");
  // label-free basemap, our own upright labels, and the network dimmed behind
  // the route — all of which applyBasemap decides from navActive
  applyBasemap();
  // Said before anything is awaited. iOS lets a page speak only once speech was
  // started inside a tap, and the tap is over at the first await — this used to
  // come after the wake lock and the GPS watcher, which on an iPhone meant a
  // silent ride and a false "no voice on this phone" warning.
  speak("navigation started", "chat");
  keepScreenOn(true); // the app's window flag: a WebView may not honour the Wake Lock
  // unsupported or denied, navigation still works; taken again whenever the
  // page comes back into view (see lifecycle.ts)
  await screenLock.acquire();
  // Each wait is a moment the ride can end in (exit, or Back, pressed while a
  // permission dialog is up), and another begin. Starting a GPS watch or
  // pushing a Back guard for a ride already over left the phone tracking, and
  // a Back that did nothing; doing it inside the next ride pushed two.
  if (!store.navActive || ride !== rideGen) return;
  // Location last, permission first: on Android 14+ the background watcher's
  // foreground service cannot start without it (see navStartLocation).
  await navStartLocation(true);
  if (!store.navActive || ride !== rideGen) return;
  // absorb one Back press: on Android the hardware button is a thumb-brush from
  // ending the ride, and there was no guard of any kind
  history.pushState({ navigating: true }, "");
}

export function exitNav(): void {
  store.navActive = false;
  rideLane.cancel();
  // the stops menu belongs to the ride; left open it floated over the planner
  stopsOpen(false);
  nav.originalDest = null;
  nav.lastPos = null;
  if (nav.watchId !== null) navigator.geolocation.clearWatch(nav.watchId);
  nav.watchId = null;
  if (nav.bgWatcherId !== null) void stopBackgroundWatcher(nav.bgWatcherId);
  nav.bgWatcherId = null;
  screenLock.release();
  keepScreenOn(false);
  closeAsk();
  links.hideClassify.call();
  hideRideAlert();
  window.clearTimeout(nav.refollowTimer);
  navStopAnimation();
  nav.dot?.remove();
  nav.dot = null;
  // the ride's own queue goes first, so the line that closes it is not
  // cancelled the moment it starts ("ride saved…" was queued, then cleared)
  clearSpeech();
  // Saving never stands in the way of the ride ending: an exception here used
  // to leave the ride screen up with the GPS and the wake lock still held.
  try {
    finishAndSaveRide();
  } catch (err) {
    console.warn("ride not saved", err);
  }
  document.body.classList.remove("navigating");
  el<HTMLDivElement>("nav-banner").style.display = "none";
  map.setLayoutProperty("route-done", "visibility", "none");
  applyBasemap(); // restores the network's normal opacity
  getSource("route-done").setData(emptyFC());
  const threeD = el<HTMLInputElement>("show-3d").checked;
  map.easeTo({ pitch: threeD ? 60 : 0, bearing: 0, duration: 800 });
  // a new build that arrived mid-ride is loaded now the ride is over
  if (swReload.waiting) window.setTimeout(() => swReload.idle(), RELOAD_AFTER_RIDE_MS);
  // The ride pushed a history entry to catch Back; left there, the next Back
  // after the ride only popped it, and did nothing a rider could see.
  if ((history.state as { navigating?: boolean } | null)?.navigating === true) {
    nav.historyUnwinding = true;
    history.back();
  }
}

/** Mid-ride detour: reroute to the nearest kid stop of a kind, remembering
 * the original destination for the resume button. */
export async function detourToNearest(kind: "water" | "restroom" | "playground"): Promise<void> {
  if (!store.navActive || !store.routerReady || !nav.lastPos) return;
  const from = nav.lastPos;
  const candidates = store.pois.filter((p) => p.properties.kind === kind);
  const ticket = rideLane.begin();
  try {
    const idx = await routing.nearestReachable(
      from,
      candidates.map((p) => p.geometry.coordinates),
      store.profileId,
      store.preferFlat,
    );
    if (rideStale(ticket)) return;
    const poi = idx !== null ? candidates[idx] : undefined;
    if (!poi) {
      speak(`no ${kind === "water" ? "water fountain" : kind} found nearby`);
      return;
    }
    const found = await routing.plan(from, poi.geometry.coordinates, routePrefs());
    if (rideStale(ticket)) return;
    if (!trip.publish(rideTicket(ticket), found)) return;
    const first = found[0];
    if (!first) return;
    selectOption(first.id);
    if (nav.originalDest === null) nav.originalDest = nav.dest;
    nav.dest = poi.geometry.coordinates;
    rebuildNavFromSelected();
    // offer the way back immediately: this used to appear only on ARRIVAL at
    // the stop, so a mis-tapped detour couldn't be abandoned, and the voice
    // said "tap resume" for a button that wasn't on screen
    el<HTMLButtonElement>("nav-resume").style.display = "block";
    const label = poi.properties.name || POI_META[kind]?.label || kind;
    speak(
      `detour: ${label} is ${fmtDist(first.payload.summary.meters)} away. follow the route.`,
    );
  } catch {
    if (rideStale(ticket)) return;
    speak("could not plan a detour from here");
  }
}

/** Back to the ride from a detour: the destination, or what is left of the
 * loop. The detour stays what is being followed until the way back exists. */
export async function resumeRide(): Promise<void> {
  if (!store.routerReady || !nav.lastPos || !nav.originalDest) return;
  const original = nav.originalDest;
  const ticket = rideLane.begin();
  try {
    const found = await rideOptionsFrom(nav.lastPos, undefined, { dest: original, onDetour: false });
    if (rideStale(ticket)) return;
    const first = found?.[0];
    if (!found || !first) throw new Error("no way back");
    if (!trip.publish(rideTicket(ticket), found)) return;
    nav.dest = original;
    nav.originalDest = null;
    selectOption(first.id);
    rebuildNavFromSelected();
    el<HTMLButtonElement>("nav-resume").style.display = "none";
    hideRideAlert();
    speak("back on the way. let's go!");
  } catch {
    if (rideStale(ticket)) return;
    // still on the detour
    speak("could not plan the way back from here");
  }
}

/** Where we're going, for the arrival line. */
let navDestLabel: string | null = null;

export function initNavSession(): void {
  links.showArrival.set(showArrival);
  document.addEventListener("visibilitychange", () => {
    void screenLock.onVisibilityChange();
  });
}
