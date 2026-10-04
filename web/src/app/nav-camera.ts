// The ride's camera: the dot and the view eased toward each GPS fix, the compass,
// framing a route, and keeping its hands off the map while the rider is touching it
// and taking it back after.

import { links } from "./links.js";
import { type RouteOption } from "../types.js";
import { store } from "./store.js";
import { map } from "./map.js";
import { SHEET_HALF, sheetLayout } from "./sheet.js";
import { rideView } from "./nav-banner.js";
import { routing } from "./services.js";
import { nav, rideEngine } from "./nav-state.js";
import { distM } from "../nav.js";
import { el } from "./dom.js";

const NAV_PITCH = 50;

/** After the rider stops touching the map, the camera takes itself back —
 * otherwise one bump on the handlebars leaves the ride permanently off-centre
 * and you have to keep hunting for the recenter button. */
export const REFOLLOW_MS = 10_000;

// GPS fixes land ~1/s. Rather than teleporting the dot and firing a competing
// easeTo per fix, every fix sets a TARGET and one rAF loop eases the dot and
// camera toward it continuously.
let navRaf: number | null = null;

/** True mid-gesture: the follow camera keeps its hands off so it can't cut
 * the rider's own pinch/scroll inertia short. */
let navInteracting = false;

/** Fit the map to a freshly planned route. A link is how routes are shared, and
 * the recipient of a 42 km route was left looking at the default view with 2% of
 * it on screen. Skipped while navigating, where the camera belongs to the rider. */
export function frameRoute(option: RouteOption): void {
  if (store.navActive) return;
  const coords = option.payload.geojson.features.flatMap((f) =>
    f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
  );
  if (coords.length < 2) return;
  let w = Infinity;
  let sth = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < sth) sth = lat;
    if (lat > n) n = lat;
  }
  map.fitBounds(
    [
      [w, sth],
      [e, n],
    ],
    {
      // Leave room for the panel: a bottom sheet wherever the CSS makes it one
      // — sheetLayout is that same query, which includes a phone held sideways
      // (max-height: 500px); asking about width alone framed a landscape phone's
      // route with desktop padding, under the sheet — and down the left-hand
      // side on a desktop. The sheet stands at "half" once a route is shown
      // (revealSheet): 52% plus its own padding.
      padding: sheetLayout.matches
        ? { top: 40, bottom: Math.round(window.innerHeight * SHEET_HALF) + 40, left: 30, right: 30 }
        : { top: 60, bottom: 60, left: 380, right: 60 },
      duration: 700,
      maxZoom: 16,
    },
  );
}

/** Where the rider is, in words. The hazard dialog used to print raw decimal
 * degrees at them while the app already knew the street name. */
export async function hereLabel(lon: number, lat: number): Promise<string> {
  const street = rideView.headline.street.trim();
  if (store.navActive && street && !/^[-–]$/.test(street) && !/^⚠/.test(street)) {
    return `on ${street}`;
  }
  const cls = await routing.edgeClassAt(lon, lat);
  return cls ? `on a ${cls.replace(/_/g, " ")}` : "at this spot";
}

/** A bearing as something sayable ("north-east"), for telling an off-route
 * rider which way the new route runs. */
export function compassPoint(deg: number): string {
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8] ?? "on";
}

/** Shortest signed angle a -> b, in degrees. */
function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** One continuous loop drives the dot and the follow camera toward the latest
 * fix. Fixes arrive ~1/s; easing every frame keeps motion smooth instead of
 * teleporting the dot while a queue of 900 ms camera eases fight each other. */
export function navAnimate(): void {
  navRaf = null;
  if (!store.navActive) return;
  if (nav.posTarget) {
    const cur = nav.posShown ?? nav.posTarget;
    const k = 0.18; // keeps up with a fix/sec without looking twitchy
    const next: [number, number] = [
      cur[0] + (nav.posTarget[0] - cur[0]) * k,
      cur[1] + (nav.posTarget[1] - cur[1]) * k,
    ];
    nav.posShown = distM(next, nav.posTarget) < 0.3 ? nav.posTarget : next;
    nav.dot?.setLngLat(nav.posShown);
  }
  if (nav.following && nav.posShown && !navInteracting) {
    nav.bearingShown =
      (nav.bearingShown + angleDelta(nav.bearingShown, rideEngine.bearingTarget) * 0.12 + 360) % 360;
    const curZoom = map.getZoom();
    const zoom = nav.userZoom ? curZoom : curZoom + (rideEngine.zoomTarget - curZoom) * 0.06;
    // Only touch the camera when something actually moved. jumpTo fires a full
    // movestart/zoomstart/moveend cycle, so writing every frame spams events
    // (and burns battery) even when the rider is sitting still at a light.
    const c = map.getCenter();
    const moved =
      Math.abs(c.lng - nav.posShown[0]) > 1e-7 ||
      Math.abs(c.lat - nav.posShown[1]) > 1e-7 ||
      Math.abs(angleDelta(map.getBearing(), nav.bearingShown)) > 0.05 ||
      Math.abs(zoom - curZoom) > 0.002;
    if (moved) {
      // Padding pushes the rider down the screen so the view is mostly the road
      // AHEAD: centred, ~60% of the display was ground already covered.
      map.jumpTo({
        center: nav.posShown,
        bearing: nav.bearingShown,
        zoom,
        pitch: NAV_PITCH,
        padding: { top: Math.round(map.getCanvas().clientHeight * 0.34), bottom: 0, left: 0, right: 0 },
      });
    }
  }
  navRaf = requestAnimationFrame(navAnimate);
}

export function navStartAnimation(): void {
  if (navRaf === null) navRaf = requestAnimationFrame(navAnimate);
}

export function navStopAnimation(): void {
  if (navRaf !== null) cancelAnimationFrame(navRaf);
  navRaf = null;
  nav.posShown = null;
  nav.posTarget = null;
}

/** Whether recentring would do anything, shown by weight rather than presence.
 *
 * It used to be hidden while the camera was already following. In a row of five
 * that re-spaces the other four, so the target a rider was reaching for moves
 * under their thumb — the one thing a control in a moving vehicle must not do.
 */
export function setRecentreNeeded(needed: boolean): void {
  const btn = el<HTMLButtonElement>("nav-recenter");
  btn.classList.toggle("idle", !needed);
  const label = needed ? "Recentre on me" : "Already following you";
  btn.setAttribute("aria-label", label);
  btn.title = label; // it said "Recentre on me" while the label said otherwise
}

// The follow camera writes the map every animation frame, which would fight
// (and cancel) the rider's own pinch/scroll before MapLibre could even start
// the gesture. Back off the moment they touch the map, resume shortly after.
let navInteractTimer: number | undefined;

function pauseFollowForInput(): void {
  if (!store.navActive) return;
  navInteracting = true;
  scheduleRefollow();
  window.clearTimeout(navInteractTimer);
  navInteractTimer = window.setTimeout(() => {
    navInteracting = false;
  }, 500);
}

/** The rider took the zoom: keep it until they tap recenter (or until the
 * camera takes itself back — see scheduleRefollow). */
function takeZoomControl(): void {
  if (!store.navActive) return;
  nav.userZoom = true;
  setRecentreNeeded(true);
  scheduleRefollow();
}

/** Hand the camera back to the route once the rider has stopped fiddling. */
function scheduleRefollow(): void {
  window.clearTimeout(nav.refollowTimer);
  nav.refollowTimer = window.setTimeout(() => {
    if (!store.navActive) return;
    nav.following = true;
    nav.userZoom = false;
    setRecentreNeeded(false);
  }, REFOLLOW_MS);
}

export function initNavCamera(): void {
  links.frameRoute.set(frameRoute);
  el<HTMLButtonElement>("nav-recenter").addEventListener("click", () => {
    nav.following = true;
    nav.userZoom = false; // hand the zoom back to the follow camera
    setRecentreNeeded(false);
  });

  map.on("dragstart", () => {
    if (store.navActive) {
      nav.following = false;
      setRecentreNeeded(true);
      scheduleRefollow();
    }
  });

  // A pinch/scroll zoom while navigating is the rider deliberately looking
  // further ahead — keep their zoom (the old code re-applied its own every fix,
  // so zooming out snapped back within a second) until they tap recenter.
  map.on("zoomstart", (e: { originalEvent?: unknown }) => {
    if (store.navActive && e.originalEvent) {
      nav.userZoom = true;
      setRecentreNeeded(true);
    }
  });

  // Bound to the map's own input events, not a canvas listener (wheel/touch land
  // on MapLibre's overlay containers, which don't bubble through the leaf canvas)
  // and not to zoomstart (handler-driven zooms don't reliably carry originalEvent).
  map.on("wheel", () => {
    pauseFollowForInput();
    takeZoomControl();
  });

  map.on("touchstart", (e: { originalEvent?: TouchEvent }) => {
    pauseFollowForInput();
    if ((e.originalEvent?.touches.length ?? 0) >= 2) takeZoomControl(); // pinch
  });

  map.on("mousedown", pauseFollowForInput);
}
