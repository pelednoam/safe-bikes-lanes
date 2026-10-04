// Where the rider is: the GPS fix as the ride wants it, asking for permission, what
// to say when the signal is lost or refused, and starting the watch.

import { type NativeFix, askForRideNotifications, isNativeApp, locationAdvice, rideLocationState, startBackgroundWatcher, stopBackgroundWatcher } from "../native.js";
import { hideRideAlert, showRideAlert } from "./nav-banner.js";
import { speak } from "./nav-voice.js";
import { nav } from "./nav-state.js";
import { store } from "./store.js";
import { el } from "./dom.js";
import { navOnFix } from "./nav-ride.js";

function toFix(pos: GeolocationPosition): NativeFix {
  return {
    lon: pos.coords.longitude,
    lat: pos.coords.latitude,
    accuracy: pos.coords.accuracy,
    heading: pos.coords.heading,
    speed: pos.coords.speed,
  };
}

/** Losing GPS used to be silent, put "location unavailable — check permissions"
 * over the street name (clipped mid-sentence at 220 px), and leave the big
 * distance frozen looking live. Code 2 is a signal drop, not a permission
 * problem, and the rider needs to hear about it. */
let gpsLostSpokenAt = 0;

function onLocationError(err: { code?: number }): void {
  const denied = err.code === 1;
  showRideAlert(denied ? "⚠ location permission denied" : "⚠ GPS signal lost", "gps");
  if (!denied) {
    const now = Date.now();
    if (now - gpsLostSpokenAt > 20_000) {
      gpsLostSpokenAt = now;
      speak("lost g p s signal. keep following the road.", "safety");
    }
  }
}

function navOnPosition(pos: GeolocationPosition): void {
  navOnFix(toFix(pos));
}

/** A location problem on the ride alert, and what tapping the alert opens. */
let gpsAlertFix: { text: string; fix: () => void } | null = null;

function showLocationAdvice(message: string, fix?: () => void): void {
  const text = `⚠ ${message}`;
  showRideAlert(text, "gps");
  gpsAlertFix = fix === undefined ? null : { text, fix };
}

/** Set while navStartLocation is waiting on a permission dialog. */
let navLocationStarting = false;

/** Start the ride's position source.
 *
 * In the app, permission comes first and the watcher second. The watcher's
 * plugin asks for location itself, but goes straight on to start its foreground
 * service without waiting for the answer; on Android 14+ that start is refused
 * without the permission and never retried, so a first ride only tracked while
 * the screen stayed on. With precise location refused or only approximate, no
 * watcher starts at all — the WebView would just ask again — and this runs again
 * when the rider comes back from Settings (`ask` false: nothing pops up then). */
export async function navStartLocation(ask: boolean): Promise<void> {
  if (navLocationStarting || nav.bgWatcherId !== null || nav.watchId !== null) return;
  navLocationStarting = true;
  try {
    if (isNativeApp()) {
      const state = await rideLocationState(ask);
      if (!store.navActive) return;
      const advice = locationAdvice(state);
      if (state === "approximate" || state === "denied") {
        if (advice !== null) showLocationAdvice(advice.text, advice.fix);
        return;
      }
      if (ask && state !== "unknown") {
        const line = await askForRideNotifications((l) => showRideAlert(`🔔 ${l}`, "gps"));
        if (line !== null && el<HTMLDivElement>("nav-alert").textContent === `🔔 ${line}`) {
          hideRideAlert();
        }
        if (!store.navActive) return;
      }
      // "off" still starts the watcher: its fixes arrive once location is on
      if (advice !== null) showLocationAdvice(advice.text, advice.fix);
      // background watcher keeps GPS + voice alive with the screen off (shows a
      // persistent notification while navigating)
      const id = await startBackgroundWatcher(
        "Family Bike Router",
        "Turn-by-turn navigation is running",
        navOnFix,
        showLocationAdvice,
        { requestPermissions: state === "unknown" },
      );
      if (!store.navActive) {
        if (id !== null) void stopBackgroundWatcher(id);
        return;
      }
      nav.bgWatcherId = id;
      if (id !== null) return;
    }
    nav.watchId = navigator.geolocation.watchPosition(
      navOnPosition,
      (err: GeolocationPositionError) => onLocationError(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  } finally {
    navLocationStarting = false;
  }
}

export function initNavLocation(): void {
  // Back from Settings with location now allowed (or switched on): pick the ride up.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && store.navActive && isNativeApp()) {
      void navStartLocation(false);
    }
  });

  el<HTMLDivElement>("nav-alert").addEventListener("click", () => {
    const box = el<HTMLDivElement>("nav-alert");
    // only while the alert still says what the fix is for
    if (gpsAlertFix !== null && box.style.display !== "none" && box.textContent === gpsAlertFix.text) {
      gpsAlertFix.fix();
    }
  });
}
