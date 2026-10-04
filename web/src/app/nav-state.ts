// Turn-by-turn state that more than one part of navigation reads or writes: where the
// ride is going and was going, the dot and the camera, the voice, the recorder, the
// watchers. What only one part uses stays with that part.
import type { Marker } from "maplibre-gl";

import type { RideRecorder } from "../rides.js";
import { readItem } from "../storage.js";
import type { RouteOption } from "../types.js";
import { type LoopLeg, RideEngine } from "../ride.js";
import { PROFILES } from "../router.js";
import { store } from "./store.js";

interface Nav {
  watchId: number | null;
  muted: boolean;
  following: boolean;
  dest: [number, number] | null;
  dot: Marker | null;
  lastPos: [number, number] | null;
  /** Set while detouring to a kid stop: where the ride was originally headed. */
  originalDest: [number, number] | null;
  /** "go with my street choice": reroutes respect the rider's direction. */
  myWay: boolean;
  /** Where the dot is drawn right now, and where it's heading. */
  posShown: [number, number] | null;
  posTarget: [number, number] | null;
  bearingShown: number;
  /** Rider's own zoom wins until they hit recenter — no yanking back mid-glance. */
  userZoom: boolean;
  refollowTimer: number | undefined;
  // A loop ends where it starts, so its nav.dest is the start, and a reroute
  // aimed there sends the rider home from wherever they strayed. While riding a
  // loop the app keeps the loop as planned and how far round it the rider has
  // got, and every way back aims for the rest of it instead (see rejoin.ts).
  /** The round trip being ridden, as planned; null on an A-to-B ride. */
  loop: RouteOption | null;
  /** Background (native) watcher id — used instead of a web watch in the app. */
  bgWatcherId: string | null;
  askYes: (() => void) | null;
  /** Set while exitNav steps back over the ride's history entry. */
  historyUnwinding: boolean;
  /** Told the rider once this ride that there is no voice. */
  voiceWarned: boolean;
  recorder: RideRecorder | null;
}

export const nav: Nav = {
  watchId: null,
  muted: false,
  following: true,
  dest: null,
  dot: null,
  lastPos: null,
  originalDest: null,
  myWay: readItem("navMyWay") === "1",
  posShown: null,
  posTarget: null,
  bearingShown: 0,
  userZoom: false,
  refollowTimer: undefined,
  loop: null,
  bgWatcherId: null,
  askYes: null,
  historyUnwinding: false,
  voiceWarned: false,
  recorder: null,
};

/** The loop legs of the ways back planned so far, by option. */
export const loopLegs = new WeakMap<RouteOption, LoopLeg>();

/** The ride itself: where the rider is on the route, and what to tell them
 * (ride.ts). What follows here applies what it decides to the page. */
export const rideEngine = new RideEngine({
  dest: () => nav.dest,
  atStop: () => nav.originalDest !== null,
  myWay: () => nav.myWay,
  paceKmh: () => PROFILES[store.profileId].paceKmh,
  solo: () => store.profileId === "solo",
});
