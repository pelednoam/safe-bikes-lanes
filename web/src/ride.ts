// ---------------------------------------------------------------------------
// The ride engine: GPS fixes in, guidance out.
//
// Everything a ride decides lives here: where the rider is on the route, when
// a turn is called and how, when a wrong turn becomes a reroute, which hazard
// is announced, the milestones, arrival. None of it touches the page. Each fix
// returns the effects it causes, in order (say this, buzz that, put this on
// the banner, reroute from here), and app.ts applies them to the screen, the
// voice, the map and the ride recorder.
//
// It used to be one 275-line function in app.ts over forty module variables,
// testable only by driving a browser through a simulated ride at a minute or
// more a scenario. Now a ride is a loop over fixes in a unit test.
// ---------------------------------------------------------------------------

import {
  bearingDeg,
  buildAlerts,
  buildManeuvers,
  buildTrack,
  distM,
  type Maneuver,
  type RideAlert,
  snapToTrack,
  type Track,
  trackBearingAhead,
  trackSlice,
} from "./nav.js";
import type { SpeakPriority } from "./speech.js";
import type { ProtectionClass, RoutePayload } from "./types.js";
import { distVoice, fmtDistTight, lengthVoice, milestoneM, milestoneVoice, navRound } from "./units.js";

/** Further than this from the route is off it. */
export const OFF_ROUTE_M = 40;
/** Good fixes off the route in a row before it counts as a wrong turn. */
export const OFF_ROUTE_STRIKES = 3;
/** Ignore fixes with worse GPS accuracy than this for off-route decisions. */
export const MAX_GPS_ACCURACY_M = 50;
/** Minimum time between automatic reroutes. */
export const REROUTE_COOLDOWN_MS = 10_000;
/** A persistent wrong turn is mentioned occasionally, not nagged: the riders'
 * logs had "rerouting." nine times in one deviation, with the ETA strobing
 * between the routed and straight-line estimates. */
export const REROUTE_ANNOUNCE_MIN_MS = 45_000;
// Turn calls are timed, not fixed-distance: 90 m is 40 s of warning at a kid's
// pace but only 13 s on a fast descent. Announce N seconds out, clamped so the
// call is never absurdly early or too late to act on.
const ANNOUNCE_FAR_S = 25;
const ANNOUNCE_NEAR_S = 10;
const ANNOUNCE_NOW_S = 4;
const ANNOUNCE_FAR_CLAMP: [number, number] = [60, 200];
const ANNOUNCE_NEAR_CLAMP: [number, number] = [30, 80];
const ANNOUNCE_NOW_CLAMP: [number, number] = [12, 30];
/** Chain the following turn into the call when it lands right after. */
const THEN_CHAIN_M = 45;
/** Snap the dot to the route while within this of it (beyond = show real GPS,
 * so being genuinely off-route is visible rather than hidden). */
export const SNAP_DISPLAY_M = 25;
/** Follow-camera zooms: cruising, and tightened near a maneuver. */
// Both land in the same tile zoom bucket on purpose: cruising at 16.4 fetched
// z16 tiles and every one of ~150 turns then fetched a fresh z17 set and back
// again, roughly 120 MB of basemap over a 42 km ride. Staying inside one
// bucket removes that churn.
export const NAV_ZOOM_CRUISE = 16.6;
export const NAV_ZOOM_TURN = 17.3;
const NAV_ZOOM_TURN_M = 90;
/** A single fix this far from the last one is a re-acquisition artefact, not a
 * bicycle. Accepting one near the destination used to latch "arrived!" — voice
 * and banner dead for the rest of the ride. Several in a row are believed (the
 * rider really did move, e.g. after a signal gap). */
const MAX_FIX_JUMP_M = 500;
const IMPLAUSIBLE_FIXES_BEFORE_TRUSTED = 3;
/** Past this far from the end, we are plainly not at the destination any more,
 * so a stale arrival state must clear (also covers starting a new ride while
 * still standing at the old destination). */
const ARRIVAL_CLEAR_M = 80;
/** Within this of the end is arrived. */
const ARRIVED_M = 15;
/** The most loop progress one fix can add: a minute of fast riding, which
 * also covers a short GPS gap. */
const LOOP_PROGRESS_MAX_STEP_M = 400;
/** The fastest a rider covers ground, for how far round the loop a fix after a
 * gap may believably be: a fast descent, not a car. */
const LOOP_FASTEST_MPS = 10;
/** A loop winds: how much further round it a rider can get than the straight
 * line they covered. */
const LOOP_WINDING = 1.6;
/** Hazards are called this far out, and held on screen until this far past. */
const HAZARD_CALL_M = 100;
const HAZARD_HOLD_M = 30;

export interface RideFix {
  lon: number;
  lat: number;
  accuracy: number;
  heading?: number | null;
  speed?: number | null;
}

/** How the track being followed maps onto a round trip: its first `legM`
 * metres get back to the loop, which it then follows from `resumeM` metres
 * round. */
export interface LoopLeg {
  legM: number;
  resumeM: number;
}

/** What the engine reads from the rest of the app, live, on every fix. */
export interface RideContext {
  /** Where the ride is going; null with no destination yet. */
  dest(): [number, number] | null;
  /** True while detouring to a stop: arriving there is a pause, not the end. */
  atStop(): boolean;
  /** "Go my way": a reroute follows the rider's direction. */
  myWay(): boolean;
  /** The profile's expected pace, until a measured one takes over. */
  paceKmh(): number;
  /** A solo rider isn't told to gather up the kids. */
  solo(): boolean;
}

export type RideEffect =
  | { type: "speak"; text: string; priority: SpeakPriority }
  | { type: "vibrate"; pattern: number[] }
  | { type: "alert"; text: string; kind: "hazard" | "gps" }
  /** Hide the alert, but only if what it shows is about the GPS. */
  | { type: "clearGpsAlert" }
  | { type: "hideAlert" }
  /** A wrong turn is suspected: the banner says so while it is made sure of. */
  | { type: "offRoute" }
  /** The next instruction. */
  | { type: "banner"; maneuver: Maneuver | undefined; distToNextM: number }
  /** Distance and time left; `straight` is as the crow flies, off the route. */
  | { type: "trip"; remainingM: number; minutes: number; speedMps: number; straight: boolean }
  /** Plan a way on from `from` and hand it to setRoute. `heading` is set when
   * the new way should follow the rider's direction. */
  | { type: "reroute"; from: [number, number]; heading: number | null }
  /** Back on the route after asking for a reroute: a way on that is still
   * being planned is no longer wanted. */
  | { type: "rejoined" }
  | { type: "arrived"; atStop: boolean; totalM: number };

export interface RideStep {
  /** Where to draw the rider: on the route while plausibly on it. */
  dot: [number, number];
  /** Metres along the route, when on it; what the ride recorder counts. */
  alongM: number | undefined;
  /** What kind of way that stretch of the route is, when on it: the ride's
   * record of how much of it was protected. */
  cls: ProtectionClass | null;
  /** The route behind the rider, for dimming it. Null while off it. */
  done: [number, number][] | null;
  effects: RideEffect[];
}

/** Distance to the next turn, as the banner shows it. The banner rounded to
 * 10 m while the voice rounded to 50, so riders heard "in three hundred
 * metres" against a banner reading 280 m and reported it as a bug. Both round
 * with navRound now, so the buckets have to be coarse enough to say out loud.
 * Distances are metres everywhere inside the app; units.ts is the last step
 * before one is shown or spoken, so a rider in Massachusetts reads miles. */
export function navDistText(m: number): string {
  const r = navRound(m);
  return r === 0 ? "now" : fmtDistTight(r);
}

/** "in 50 meters, you have arrived" is not English. The destination maneuver's
 * wording is written for the moment of arrival, so the staged calls need their
 * own phrasing. Null for ordinary turns. */
function arrivalPhrase(voice: string, metres: number): string | null {
  return /have arrived/i.test(voice) ? `in ${distVoice(metres)}, your destination` : null;
}

export class RideEngine {
  /** Follow-camera targets, eased toward by the map's animation loop. */
  bearingTarget = 0;
  zoomTarget = NAV_ZOOM_CRUISE;
  /** Furthest the rider has got round a round trip, in metres along it. */
  loopDoneM = 0;

  private track: Track | null = null;
  private maneuvers: Maneuver[] = [];
  private alerts: RideAlert[] = [];
  /** The route's stretches, each's class and where it ends, in order. */
  private stretches: { untilM: number; cls: ProtectionClass }[] = [];
  private loopLeg: LoopLeg | null = null;
  private next = 0;
  /** 0 = nothing announced for `next`, 1 = far call, 2 = near call, 3 = "now" */
  private announceStage = 0;
  private hint = -1;
  private arrived = false;
  private alertNext = 0;
  private alertUntilM = 0;
  private nextMilestone = 1;
  private halfway = false;
  private offCount = 0;
  private lastPos: [number, number] | null = null;
  private prevPos: [number, number] | null = null;
  private heading: number | null = null;
  private implausibleFixes = 0;
  /** Smoothed speed (m/s) used to time the turn calls. */
  private speed = 0;
  /** This fix's own speed, unsmoothed; null when there was nothing to go on. */
  private fixSpeed: number | null = null;
  private lastFixAt = 0;
  /** Smoothed pace actually being ridden, held through stops. */
  private paceKmh: number | null = null;
  private lastRerouteAt = 0;
  /** Consecutive reroute attempts, for backing off between them. */
  private rerouteTries = 0;
  /** When a reroute was last said, so one wrong turn says it once. */
  private rerouteSpokenAt = 0;
  /** A reroute has been asked for and the rider hasn't been on a route since. */
  private awaitingReroute = false;
  /** Ground actually covered since the last fix on the loop, each step capped
   * at what a bicycle can do in the time it took: how far round a fix after a
   * gap or a detour may believably be. */
  private movedSinceLoopM = 0;
  /** Good fixes on the route in a row, for believing the rider is back on it. */
  private onRouteFixes = 0;
  /** Where a way back rejoins the loop, further round than the rider had got:
   * the one jump in progress that is announced rather than inferred. */
  private rejoinAt: number | null = null;

  constructor(private readonly ctx: RideContext) {}

  /** A new ride: nothing carried over from the last one. */
  start(): void {
    this.lastPos = null;
    this.prevPos = null;
    this.heading = null;
    this.implausibleFixes = 0;
    this.speed = 0;
    this.fixSpeed = null;
    this.lastFixAt = 0;
    this.paceKmh = null;
    this.offCount = 0;
    this.lastRerouteAt = 0;
    this.rerouteTries = 0;
    this.rerouteSpokenAt = 0;
    this.alertUntilM = 0;
    this.loopDoneM = 0;
    this.movedSinceLoopM = 0;
    this.rejoinAt = null;
    this.awaitingReroute = false;
    this.onRouteFixes = 0;
    this.bearingTarget = 0;
    this.zoomTarget = NAV_ZOOM_CRUISE;
  }

  /** Follow this route from its beginning: a new ride, a reroute, a detour. */
  setRoute(payload: RoutePayload, loopLeg: LoopLeg | null = null): void {
    this.loopLeg = loopLeg;
    this.track = buildTrack(payload);
    this.maneuvers = buildManeuvers(payload);
    this.alerts = buildAlerts(payload);
    let m = 0;
    this.stretches = payload.geojson.features.map((f) => {
      const coords = f.geometry.coordinates as [number, number][];
      for (let i = 1; i < coords.length; i++) {
        m += distM(coords[i - 1] as [number, number], coords[i] as [number, number]);
      }
      return { untilM: m, cls: f.properties.cls };
    });
    this.next = 0;
    this.alertNext = 0;
    this.announceStage = 0;
    // A new track is ridden from its beginning, so look for the rider there
    // first (snapToTrack falls back to the whole track if they are not). With no
    // hint at all, a round trip — which ends where it starts — snapped its very
    // first fix to the finish: "you have arrived" at the start of every loop, the
    // ride recorder closed, and the loop counted as already ridden.
    this.hint = 0;
    this.arrived = false;
    this.nextMilestone = 1;
    this.halfway = false;
    this.awaitingReroute = false;
    this.onRouteFixes = 0;
    this.rejoinAt = loopLeg !== null && loopLeg.resumeM > this.loopDoneM ? loopLeg.resumeM : null;
  }

  /** The alert was taken down by something else: a hazard held on screen is
   * no longer this engine's to take down. */
  alertHidden(): void {
    this.alertUntilM = 0;
  }

  /** Which way the route being followed first runs, for telling a rider who
   * strayed which way to go. */
  rejoinBearing(): number | null {
    return this.track ? trackBearingAhead(this.track, 0, 0) : null;
  }

  private classAt(alongM: number): ProtectionClass | null {
    for (const s of this.stretches) if (alongM <= s.untilM) return s.cls;
    return this.stretches[this.stretches.length - 1]?.cls ?? null;
  }

  get routeM(): number {
    return this.track?.totalM ?? 0;
  }

  /** Metres of warning for a turn call: `secs` of riding at the current pace,
   * clamped so it's neither absurdly early nor too late to react. */
  private announceDist(secs: number, [lo, hi]: [number, number]): number {
    const speed = this.speed > 0.8 ? this.speed : (this.ctx.paceKmh() * 1000) / 3600;
    return Math.max(lo, Math.min(hi, speed * secs));
  }

  private phrasing(voice: string): string {
    return this.ctx.solo() ? voice.replace(/\bgather up\b/gi, "take care") : voice;
  }

  private trip(remainingM: number, straight: boolean): RideEffect {
    // ETA off measured pace when we have it, profile pace before then. Held
    // through a stop: flipping to the profile's pace below 1 m/s swung the
    // arrival time by ~6 minutes at every red light, which is useless if
    // you're asking "do we make the 3 o'clock thing?". Learnt from each fix's
    // own speed, not the smoothed one: that decays through the first seconds
    // of a stop, and fed in, it dragged a 20-minute ETA to 28 at a red light.
    if (this.fixSpeed !== null && this.fixSpeed > 1.0) {
      const measured = (this.fixSpeed * 3600) / 1000;
      this.paceKmh = this.paceKmh === null ? measured : this.paceKmh * 0.7 + measured * 0.3;
    }
    const kmh = this.paceKmh ?? this.ctx.paceKmh();
    const minutes = Math.round((remainingM / 1000 / kmh) * 60);
    return { type: "trip", remainingM, minutes, speedMps: this.speed, straight };
  }

  /** One GPS fix, `now` in milliseconds. Null when there is nothing to do: no
   * route yet, or a lone implausible jump that is being ignored. */
  onFix(fix: RideFix, now: number): RideStep | null {
    const track = this.track;
    if (track === null) return null;
    const here: [number, number] = [fix.lon, fix.lat];
    // A lone huge jump is the phone re-acquiring off a tower, not the rider.
    // Trust it only if it repeats, so we resync after a real signal gap.
    if (this.lastPos && distM(this.lastPos, here) > MAX_FIX_JUMP_M) {
      this.implausibleFixes++;
      if (this.implausibleFixes < IMPLAUSIBLE_FIXES_BEFORE_TRUSTED) return null;
    } else {
      this.implausibleFixes = 0;
    }
    const prev = this.lastPos;
    const prevAt = this.lastFixAt;
    this.lastPos = here;
    const effects: RideEffect[] = [{ type: "clearGpsAlert" }];
    const say = (text: string, priority: SpeakPriority = "turn"): void => {
      effects.push({ type: "speak", text, priority });
    };
    const buzz = (...pattern: number[]): void => {
      effects.push({ type: "vibrate", pattern });
    };

    // smoothed ground speed, for timing the turn calls
    this.fixSpeed = null;
    if (fix.speed !== null && fix.speed !== undefined && fix.speed >= 0) {
      this.fixSpeed = fix.speed;
      this.speed = this.speed === 0 ? fix.speed : this.speed * 0.6 + fix.speed * 0.4;
    } else if (this.prevPos && this.lastFixAt) {
      const dt = (now - this.lastFixAt) / 1000;
      if (dt > 0.2) {
        const v = distM(this.prevPos, here) / dt;
        if (v < 25) {
          this.fixSpeed = v;
          this.speed = this.speed === 0 ? v : this.speed * 0.7 + v * 0.3;
        }
      }
    }
    this.lastFixAt = now;
    if (prev !== null && prevAt > 0) {
      const dt = Math.max(0, (now - prevAt) / 1000);
      this.movedSinceLoopM += Math.min(distM(prev, here), LOOP_FASTEST_MPS * dt);
    }
    // travel direction: GPS heading when moving, else derived from movement
    const gpsHeading = fix.heading;
    const moving = (fix.speed ?? 0) > 0.7;
    if (gpsHeading !== null && gpsHeading !== undefined && !Number.isNaN(gpsHeading) && moving) {
      this.heading = gpsHeading;
    } else if (this.prevPos && distM(this.prevPos, here) > 5) {
      this.heading = (bearingDeg(this.prevPos, here) + 360) % 360;
    }
    if (!this.prevPos || distM(this.prevPos, here) > 3) this.prevPos = here;

    const snap = snapToTrack(track, fix.lon, fix.lat, this.hint);
    const step: RideStep = {
      // Draw the dot ON the route while we're plausibly on it — raw bike GPS
      // wanders 5-15 m, which visibly drifts the dot into buildings and across
      // the street. Beyond SNAP_DISPLAY_M show the true position, so actually
      // being off-route reads as off-route instead of being hidden by snapping.
      dot: snap.offM <= SNAP_DISPLAY_M ? snap.pos : here,
      // along-route progress rather than raw fix-to-fix distance, which counted
      // GPS wander as forward motion
      alongM: snap.offM <= OFF_ROUTE_M ? snap.alongM : undefined,
      cls: snap.offM <= OFF_ROUTE_M ? this.classAt(snap.alongM) : null,
      done: null,
      effects,
    };

    // off-route: a few good fixes in a row trigger a reroute to the destination
    // (like Google Maps — ride wherever you like, the route follows you)
    if (snap.offM > OFF_ROUTE_M) {
      // a poor GPS fix shouldn't count as a deviation
      if (fix.accuracy > MAX_GPS_ACCURACY_M) return step;
      this.onRouteFixes = 0;
      this.offCount++;
      // instant feedback while we make sure it's a real deviation
      effects.push({ type: "offRoute" });
      // keep the trip line live instead of freezing on the last on-route value:
      // straight-line to the destination is the honest estimate while off-route
      const dest = this.ctx.dest();
      if (dest) effects.push(this.trip(distM(here, dest), true));
      // follow the rider's own direction while they're off the line
      if (this.heading !== null) this.bearingTarget = this.heading;
      // and say so on screen for as long as it's true — the riders' logs showed
      // "adjusting…" sitting there with no other indication
      effects.push({ type: "alert", text: "⚠ off route", kind: "gps" });
      // Back off between attempts. A rider standing in a car park can sit >40 m
      // from every routable way, so a fixed 10 s cooldown re-routed forever
      // and said "rerouting." on every attempt while the banner stayed stuck on
      // "adjusting…" — a loop at exactly the moment you most need a sentence.
      const wait = REROUTE_COOLDOWN_MS * Math.min(2 ** this.rerouteTries, 6);
      if (this.offCount >= OFF_ROUTE_STRIKES && dest && now - this.lastRerouteAt > wait) {
        this.offCount = 0;
        this.lastRerouteAt = now;
        const heading = this.ctx.myWay() ? this.heading : null;
        // Rate-limit the announcement by wall time, not by attempt count: a
        // successful reroute puts the rider "on" the new line for a fix, which
        // reset the counter, so continuing the same wrong turn kept re-announcing.
        if (now - this.rerouteSpokenAt > REROUTE_ANNOUNCE_MIN_MS) {
          this.rerouteSpokenAt = now;
          say(heading !== null ? "okay, going your way." : "rerouting.");
          buzz(80, 60, 80);
        }
        this.rerouteTries++;
        this.awaitingReroute = true;
        effects.push({ type: "reroute", from: here, heading });
      }
      return step;
    }
    this.offCount = 0;
    this.rerouteTries = 0;
    if (fix.accuracy <= MAX_GPS_ACCURACY_M) this.onRouteFixes++;
    // The rider found the way back before the new one arrived: switching to it
    // now would send them off the line they are on, to follow a way back from
    // a wrong turn they already put right. As sure as a wrong turn has to be,
    // though: one fix that wanders onto the line mid-deviation isn't a return.
    if (this.awaitingReroute && this.onRouteFixes >= OFF_ROUTE_STRIKES) {
      this.awaitingReroute = false;
      effects.push({ type: "rejoined" });
    }
    effects.push({ type: "clearGpsAlert" });
    this.hint = snap.idx;
    step.done = trackSlice(track, snap.alongM);
    // How far round the loop, once this track is on it. Forwards only, and only
    // by what the rider can have covered: a loop crosses and runs back along
    // its own streets, and a snap onto the far side of one of those (a wrong
    // turn's first metres pass close to them) must not count the stretch in
    // between as ridden. What they can have covered is the ground they moved
    // over since the last fix on the loop, each step capped at a bicycle's
    // speed: a GPS gap is ridden on from, while a wrong turn beside another
    // stretch of the loop earns nothing. (Capped at one step whatever
    // happened, progress stopped for good after any gap.) And a way back that
    // rejoins further round says where, so reaching it counts.
    if (this.loopLeg !== null && snap.alongM >= this.loopLeg.legM) {
      const round = this.loopLeg.resumeM + snap.alongM - this.loopLeg.legM;
      const reach = LOOP_PROGRESS_MAX_STEP_M + LOOP_WINDING * this.movedSinceLoopM;
      const rejoining =
        this.rejoinAt !== null && round >= this.rejoinAt && round - this.rejoinAt <= LOOP_PROGRESS_MAX_STEP_M;
      if (round > this.loopDoneM && (round - this.loopDoneM <= reach || rejoining)) {
        this.loopDoneM = round;
        if (rejoining) this.rejoinAt = null;
      }
      this.movedSinceLoopM = 0;
    }

    // advance past maneuvers we've already ridden through
    const atM = (i: number): number => this.maneuvers[i]?.atM ?? 0;
    while (this.next < this.maneuvers.length - 1 && atM(this.next) < snap.alongM - 20) {
      this.next++;
      this.announceStage = 0;
    }
    // ...and go back if the rider overshot and doubled back. `next` only ever
    // advanced, so a turn you missed and returned to was never called again.
    while (this.next > 0 && atM(this.next - 1) > snap.alongM + 20) {
      this.next--;
      this.announceStage = 0;
    }
    const next = this.maneuvers[this.next];
    const distToNext = Math.max(0, (next?.atM ?? 0) - snap.alongM);
    const remaining = Math.max(0, track.totalM - snap.alongM);
    // un-latch a stale arrival (bad fix, or a new ride begun at the old
    // destination) so the banner and voice come back
    if (this.arrived && remaining > ARRIVAL_CLEAR_M) this.arrived = false;
    // A useless fix still drove the headline distance, which read "now" three
    // times inside 20 m and then jumped back to 100 m. Hold the last good
    // reading and say the signal is poor instead of inventing precision.
    const poorFix = fix.accuracy > MAX_GPS_ACCURACY_M;
    if (poorFix) {
      effects.push({ type: "alert", text: "⚠ GPS signal poor", kind: "gps" });
    } else if (!this.arrived) {
      // Once arrived, the arrival message stays up: the next fix a second
      // later used to overwrite it with the last turn instruction, so the
      // rider never actually saw that they'd got there.
      effects.push({ type: "banner", maneuver: next, distToNextM: distToNext });
      effects.push(this.trip(remaining, false));
    }

    // Not once arrived: the arrival line has said it, and the destination's own
    // "now" call, a few metres on, said "you have arrived" a second time.
    if (next && !poorFix && !this.arrived) {
      // chain a turn that lands right after this one ("left, then right") so a
      // quick pair isn't two calls on top of each other
      const after = this.maneuvers[this.next + 1];
      const chain = after && after.atM - next.atM <= THEN_CHAIN_M ? `, then ${after.voice}` : "";
      const within = (secs: number, clamp: [number, number]): boolean =>
        distToNext <= this.announceDist(secs, clamp);
      const arriving = arrivalPhrase(next.voice, navRound(distToNext));
      if (this.announceStage < 3 && within(ANNOUNCE_NOW_S, ANNOUNCE_NOW_CLAMP)) {
        say(`${next.voice}${chain}`);
        buzz(200);
        this.announceStage = 3;
      } else if (this.announceStage < 2 && within(ANNOUNCE_NEAR_S, ANNOUNCE_NEAR_CLAMP)) {
        say(arriving ?? `in ${distVoice(distToNext)}, ${next.voice}${chain}`);
        buzz(100);
        this.announceStage = 2;
      } else if (this.announceStage < 1 && within(ANNOUNCE_FAR_S, ANNOUNCE_FAR_CLAMP)) {
        say(arriving ?? `in ${distVoice(distToNext)}, ${next.voice}`);
        this.announceStage = 1;
      }
    }

    // hazard alerts (voice + distinct buzz), announced ~100 m out
    const alertAt = (i: number): number => this.alerts[i]?.atM ?? 0;
    while (this.alertNext < this.alerts.length && alertAt(this.alertNext) < snap.alongM - 10) {
      this.alertNext++;
    }
    const alert = this.alerts[this.alertNext];
    if (alert && alert.atM - snap.alongM <= HAZARD_CALL_M) {
      const voice = this.phrasing(alert.voice);
      say(voice, "safety");
      buzz(100, 80, 100);
      // and put it on screen, held until we're past the hazard
      effects.push({ type: "alert", text: `⚠ ${voice}`, kind: "hazard" });
      this.alertUntilM = alert.atM + HAZARD_HOLD_M;
      this.alertNext++;
    } else if (this.alertUntilM > 0 && snap.alongM > this.alertUntilM) {
      effects.push({ type: "hideAlert" });
      this.alertUntilM = 0;
    }

    // kid morale: a milestone every mile (or kilometre) and the halfway mark.
    // Catch up silently on the first fix: joining a route part-way (a train leg,
    // a cold GPS, a replan) fired "1 kilometer done… 20 kilometers done" one per
    // second before any guidance.
    if (this.nextMilestone === 1 && snap.alongM > 1.5 * milestoneM()) {
      this.nextMilestone = Math.floor(snap.alongM / milestoneM()) + 1;
      this.halfway = snap.alongM >= track.totalM / 2;
    }
    if (snap.alongM >= this.nextMilestone * milestoneM()) {
      say(`${milestoneVoice(this.nextMilestone)}. nice riding!`, "chat");
      this.nextMilestone++;
    }
    if (!this.halfway && track.totalM > 1500 && snap.alongM >= track.totalM / 2) {
      this.halfway = true;
      say("halfway there!", "chat");
    }

    if (remaining < ARRIVED_M && !this.arrived) {
      this.arrived = true;
      buzz(200, 100, 200);
      const atStop = this.ctx.atStop();
      say(
        atStop
          ? "arrived at your stop. tap resume when you're ready to ride on."
          : `you have arrived. ${lengthVoice(track.totalM)} — nicely done!`,
      );
      effects.push({ type: "arrived", atStop, totalM: track.totalM });
    }

    // Camera targets — the map's animation loop eases toward these. Bearing is
    // averaged over the track ahead (a per-segment bearing swings wildly on
    // twisty paths), and held steady when stopped so the map doesn't spin in
    // place. Stopped by this fix's own speed where it has one: the smoothed
    // speed is still above walking pace for the first seconds of a stop, and a
    // fix drifting round the corner at a light turned the map a quarter turn.
    const rolling = (this.fixSpeed ?? this.speed) > 0.8;
    if (rolling || this.bearingTarget === 0) {
      this.bearingTarget = trackBearingAhead(track, snap.idx, snap.alongM);
    }
    this.zoomTarget = distToNext <= NAV_ZOOM_TURN_M ? NAV_ZOOM_TURN : NAV_ZOOM_CRUISE;
    return step;
  }
}
