// What a ride shows while it is under way: the headline and the trip line, the
// banner with the next maneuver, the alert strip, and the question the ride can
// ask.

import { type Headline, NavHeadline, NavTripLine, type TripLine } from "../ui/NavBanner.js";
import { h, render } from "preact";
import { el } from "./dom.js";
import { type RideEffect, navDistText } from "../ride.js";
import { fmtDist, fmtSpeedRound } from "../units.js";
import { type Maneuver } from "../nav.js";
import { nav, rideEngine } from "./nav-state.js";

/** What the ride banner says, which is all it says: drawn from here
 * (src/ui/NavBanner.tsx), never written into the page piece by piece. */
export const rideView: { headline: Headline; trip: TripLine } = {
  headline: { icon: "⬆", dist: "–", street: "–" },
  trip: { remaining: "", speed: "" },
};

export function showHeadline(headline: Headline): void {
  rideView.headline = headline;
  render(h(NavHeadline, headline), el<HTMLDivElement>("nav-main"));
}

export function showTripLine(line: TripLine): void {
  rideView.trip = line;
  render(h(NavTripLine, line), el<HTMLDivElement>("nav-trip"));
}

/** Distance / ETA line. `straight` marks an off-route estimate (as the crow
 * flies) so the number is honest rather than frozen at its last on-route value. */
export function showTrip(t: Extract<RideEffect, { type: "trip" }>): void {
  const eta = new Date(Date.now() + t.minutes * 60_000);
  const clock = eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // "arrive" spelled out pushed this past the banner width, so it wrapped with
  // "PM" alone on a second line and the banner's height twitched all ride
  showTripLine({
    remaining: `${t.straight ? "~" : ""}${fmtDist(t.remainingM)} · ${t.minutes} min · eta ${clock}`,
    speed: t.speedMps > 0.8 ? fmtSpeedRound(t.speedMps) : "",
  });
}

export function showBanner(m: Maneuver | undefined, distToNextM: number): void {
  showHeadline({ icon: m?.icon ?? "⬆", dist: navDistText(distToNextM), street: m?.text ?? "" });
}

/** A warning the rider can SEE. The spoken version is the primary channel, but
 * it is useless muted or over kids' chatter, and a safety app must not depend on
 * audio alone. Cleared automatically once it's behind us. */
/** The one hide timer for the alert strip. */
let flashTimer = 0;

export function showRideAlert(text: string, kind: "hazard" | "gps" = "hazard"): void {
  // one timer owns every alert: showing a new one takes down the old one's timer
  window.clearTimeout(flashTimer);
  if (kind === "hazard") window.__navAlertsSeen = (window.__navAlertsSeen ?? 0) + 1;
  const box = el<HTMLDivElement>("nav-alert");
  box.textContent = text;
  box.classList.toggle("gps", kind === "gps");
  box.style.display = "block";
}

/** Show an alert for a while, then take it down: the one timer is this function's, so a
 * newer message is never taken down early by the timer of an older one. */
export function flashRideAlert(text: string, kind: "hazard" | "gps" = "hazard", ms = 5000): void {
  window.clearTimeout(flashTimer);
  showRideAlert(text, kind);
  flashTimer = window.setTimeout(hideRideAlert, ms);
}

/** A position older than this is where the rider was, not where they are. */
const FIX_FRESH_MS = 15_000;

/** Where the rider is now, or null, with an alert saying so, if the last fix is old or there
 * is none. `what` finishes "no position yet — can't ___ from here". */
export function freshFix(what: string): [number, number] | null {
  if (nav.lastPos === null || Date.now() - nav.lastFixAt > FIX_FRESH_MS) {
    flashRideAlert(`⚠️ no position yet — can't ${what} from here`, "gps", 4000);
    return null;
  }
  return nav.lastPos;
}

export function hideRideAlert(): void {
  window.clearTimeout(flashTimer);
  el<HTMLDivElement>("nav-alert").style.display = "none";
  rideEngine.alertHidden();
}

/** Ask the rider something without stopping the ride. window.confirm blocks
 * the page, so guidance, the follow camera and the recorder all froze until it
 * was answered — easy to miss at speed, and indistinguishable from a crash. */
export function askDuringRide(question: string, onYes: () => void): void {
  const box = el<HTMLDivElement>("nav-ask");
  el<HTMLDivElement>("nav-ask-text").textContent = question;
  box.style.display = "block";
  el<HTMLDivElement>("nav-banner").classList.add("expanded");
  nav.askYes = onYes;
}

export function closeAsk(): void {
  el<HTMLDivElement>("nav-ask").style.display = "none";
  nav.askYes = null;
}

// The stops menu. The three detours were three of nine buttons in a drawer;
// they are one dock button and a menu that opens upward, out from under the
// thumb that just tapped it.
export function stopsOpen(open: boolean): void {
  el<HTMLDivElement>("nav-stops-menu").style.display = open ? "flex" : "none";
  el<HTMLButtonElement>("nav-stops").setAttribute("aria-expanded", String(open));
}

export function initNavBanner(): void {
  // drawn once at load, as the page's own markup used to be
  showHeadline(rideView.headline);

  showTripLine(rideView.trip);
}
