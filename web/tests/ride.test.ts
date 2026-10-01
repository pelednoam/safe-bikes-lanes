// The ride engine, ridden: a simulated rider feeds it fixes the way a phone
// does (speed, heading, accuracy, GPS wander from a fixed seed so a failure
// replays exactly), on a clock that runs as fast as the test can go.
//
// Most of these were whole-ride browser tests (tests-e2e-ride) at up to a
// minute each, several of them in real time because the reroute cooldown is a
// wall clock. Here a ride is a loop and the clock is a number.
import { afterEach, describe, expect, it } from "vitest";

import { distM } from "../src/nav.js";
import {
  MAX_GPS_ACCURACY_M,
  navDistText,
  OFF_ROUTE_M,
  REROUTE_ANNOUNCE_MIN_MS,
  type RideContext,
  type RideEffect,
  RideEngine,
  type RideFix,
  type RideStep,
} from "../src/ride.js";
import type { LineFeature, ProtectionClass, RibbonSeg, RoutePayload } from "../src/types.js";
import { setUnits } from "../src/units.js";

const LAT = 42.38;
const LON = -71.1;
const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);
const T0 = 1_700_000_000_000;

type LngLat = [number, number];
type Dir = "E" | "W" | "N" | "S";
const STEP: Record<Dir, [number, number]> = { E: [1, 0], W: [-1, 0], N: [0, 1], S: [0, -1] };

/** A route of straight legs, each its own named street: every change of
 * direction is a turn, and a street name the guidance can use. */
function route(legs: [Dir, number, string][], ribbon?: RibbonSeg[], from: LngLat = [LON, LAT]): RoutePayload {
  const features: LineFeature[] = [];
  let at = from;
  let meters = 0;
  for (const [dir, m, name] of legs) {
    const [dx, dy] = STEP[dir];
    const to: LngLat = [at[0] + (dx * m) / mPerDegLon(at[1]), at[1] + (dy * m) / M_PER_DEG_LAT];
    const cls: ProtectionClass = "quiet_street";
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [at, to] },
      properties: { cls, color: "#d9ef8b", name },
    });
    at = to;
    meters += m;
  }
  return {
    geojson: { type: "FeatureCollection", features },
    summary: summaryOf(meters),
    ...(ribbon ? { ribbon } : {}),
  };
}

/** About 4.1 km through a grid: six streets, five turns, two miles. */
const TOWN: [Dir, number, string][] = [
  ["E", 400, "Alpha Street"],
  ["N", 300, "Beta Street"],
  ["E", 500, "Gamma Street"],
  ["S", 200, "Delta Street"],
  ["E", 1500, "Epsilon Avenue"],
  ["N", 1200, "Zeta Road"],
];

function summaryOf(meters: number): RoutePayload["summary"] {
  return { meters, minutes: meters / 150, pct_protected: 0, pct_quiet: 100, by_class_m: {}, cautions: [] };
}

function pathOf(payload: RoutePayload): LngLat[] {
  const out: LngLat[] = [];
  for (const f of payload.geojson.features) {
    for (const c of f.geometry.coordinates as LngLat[]) {
      const last = out[out.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) out.push(c);
    }
  }
  return out;
}

function pointAlong(path: LngLat[], m: number): { at: LngLat; bearing: number } {
  let left = Math.max(0, m);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as LngLat;
    const b = path[i] as LngLat;
    const seg = distM(a, b);
    const east = (b[0] - a[0]) * mPerDegLon(a[1]);
    const north = (b[1] - a[1]) * M_PER_DEG_LAT;
    const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
    if (left <= seg || i === path.length - 1) {
      const t = seg > 0 ? Math.min(1, left / seg) : 0;
      return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing };
    }
    left -= seg;
  }
  return { at: path[0] as LngLat, bearing: 0 };
}

const lastOf = (path: LngLat[]): LngLat => path[path.length - 1] as LngLat;

function offset([lon, lat]: LngLat, bearingDeg: number, m: number): LngLat {
  const rad = (bearingDeg * Math.PI) / 180;
  return [lon + (Math.sin(rad) * m) / mPerDegLon(lat), lat + (Math.cos(rad) * m) / M_PER_DEG_LAT];
}

/** Deterministic noise in [-0.5, 0.5), so a failing ride replays exactly. */
function makeNoise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
}

interface RideOpts {
  speedKmh?: number;
  fixHz?: number;
  /** Metres of GPS wander per fix. */
  jitterM?: number;
  accuracyM?: number;
  fromM?: number;
  untilM?: number;
  /** Ride off the route here, square to it, for `divertM`, then back. */
  divertAtM?: number;
  divertM?: number;
  /** Sit still at this distance for this many seconds (a red light). */
  pauseAtM?: number;
  pauseSeconds?: number;
  /** Report useless accuracy between these distances. */
  degradeFromM?: number;
  degradeToM?: number;
}

/** A rider on a route, with the engine and a record of everything it did. */
class Ride {
  readonly engine: RideEngine;
  readonly steps: RideStep[] = [];
  now = T0;
  dest: LngLat | null;
  atStop = false;
  myWay = false;
  solo = false;
  /** Routes handed back on a reroute: by default, straight on to the
   * destination from wherever the rider is. */
  onReroute: (from: LngLat) => RoutePayload | null = (from) =>
    this.dest === null ? null : straightRoute(from, this.dest);
  private readonly noise = makeNoise(1337);

  constructor(readonly payload: RoutePayload) {
    const path = pathOf(payload);
    this.dest = path[path.length - 1] ?? null;
    const ctx: RideContext = {
      dest: () => this.dest,
      atStop: () => this.atStop,
      myWay: () => this.myWay,
      paceKmh: () => 10,
      solo: () => this.solo,
    };
    this.engine = new RideEngine(ctx);
    this.engine.start();
    this.engine.setRoute(payload);
  }

  get effects(): RideEffect[] {
    return this.steps.flatMap((s) => s.effects);
  }

  get spoken(): string[] {
    return this.effects.flatMap((e) => (e.type === "speak" ? [e.text] : []));
  }

  /** The last `type` effect, e.g. the banner as it stands. */
  last<T extends RideEffect["type"]>(type: T): Extract<RideEffect, { type: T }> | undefined {
    const all = this.effects.filter((e): e is Extract<RideEffect, { type: T }> => e.type === type);
    return all[all.length - 1];
  }

  fix(f: RideFix, afterMs = 1000): RideStep | null {
    this.now += afterMs;
    const step = this.engine.onFix(f, this.now);
    if (step === null) return null;
    this.steps.push(step);
    for (const e of step.effects) {
      if (e.type === "reroute") {
        const next = this.onReroute(e.from);
        if (next) this.engine.setRoute(next);
      }
    }
    return step;
  }

  /** Ride the route as a phone reports it. */
  ride(opts: RideOpts = {}): void {
    const { speedKmh = 12, fixHz = 1, jitterM = 0, accuracyM = 8, divertM = 120, pauseSeconds = 0 } = opts;
    const path = pathOf(this.payload);
    const total = this.payload.summary.meters;
    const until = Math.min(opts.untilM ?? total, total);
    const speed = (speedKmh * 1000) / 3600;
    const dtMs = 1000 / fixHz;
    let along = opts.fromM ?? 0;
    let paused = false;
    let diverted = 0;
    while (along <= until) {
      let { at, bearing } = pointAlong(path, along);
      if (opts.pauseAtM !== undefined && !paused && along >= opts.pauseAtM) {
        paused = true;
        for (let s = 0; s < pauseSeconds * fixHz; s++) {
          this.fix({ lon: at[0], lat: at[1], accuracy: accuracyM, speed: 0, heading: bearing }, dtMs);
        }
      }
      if (opts.divertAtM !== undefined && along >= opts.divertAtM && diverted < divertM) {
        diverted += speed / fixHz;
        const base = pointAlong(path, opts.divertAtM);
        bearing = (base.bearing + 90) % 360;
        at = offset(base.at, bearing, diverted);
      } else {
        along += speed / fixHz;
      }
      const degraded =
        opts.degradeFromM !== undefined &&
        opts.degradeToM !== undefined &&
        along >= opts.degradeFromM &&
        along <= opts.degradeToM;
      const wander = degraded ? 45 : jitterM;
      at = [
        at[0] + (this.noise() * wander) / mPerDegLon(at[1]),
        at[1] + (this.noise() * wander) / M_PER_DEG_LAT,
      ];
      const accuracy = degraded ? 90 : accuracyM;
      this.fix({ lon: at[0], lat: at[1], accuracy, speed, heading: bearing }, dtMs);
    }
  }
}

function straightRoute(from: LngLat, to: LngLat): RoutePayload {
  const meters = distM(from, to);
  return {
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [from, to] },
          properties: { cls: "quiet_street", color: "#d9ef8b", name: "Omega Way" },
        },
      ],
    },
    summary: summaryOf(meters),
  };
}

afterEach(() => {
  setUnits("imperial");
});

describe("a whole ride", () => {
  it("guides every turn, keeps count, and arrives once", () => {
    const r = new Ride(route(TOWN));
    r.ride({ speedKmh: 9, jitterM: 7 });
    const spoken = r.spoken;
    for (const street of ["Beta Street", "Gamma Street", "Delta Street", "Epsilon Avenue", "Zeta Road"]) {
      expect(spoken.some((s) => s.includes(street)), street).toBe(true);
    }
    // no instruction repeated back to back (the old fixed-distance staging did)
    for (let i = 1; i < spoken.length; i++) expect(spoken[i]).not.toBe(spoken[i - 1]);
    expect(spoken.filter((s) => /mile done/.test(s))).toHaveLength(1);
    expect(spoken.filter((s) => /2 miles done/.test(s))).toHaveLength(1);
    expect(spoken.filter((s) => s === "halfway there!")).toHaveLength(1);
    // said once: the destination's own "now" call used to say it again
    expect(spoken.filter((s) => /you have arrived/.test(s))).toHaveLength(1);
    expect(r.effects.filter((e) => e.type === "arrived")).toHaveLength(1);
  });

  it("speaks in the rider's units, never the ones underneath", () => {
    // everything on screen said miles while the voice said "you have arrived.
    // 4.1 kilometers", "1 kilometer done"
    const r = new Ride(route(TOWN));
    r.ride({ speedKmh: 9 });
    expect(r.spoken.find((s) => /nicely done/.test(s))).toMatch(/\b(miles?|feet)\b/);
    for (const line of r.spoken) expect(line).not.toMatch(/kilomet|\bmeters?\b/i);
  });

  it("calls a turn three times as it comes: far, near, now", () => {
    const r = new Ride(route(TOWN));
    r.ride({ untilM: 420 });
    const calls = r.spoken.filter((s) => s.includes("Beta Street"));
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/^in \d+ feet, /);
    expect(calls[2]).toMatch(/^turn left onto Beta Street/);
  });

  it("calls a turn earlier for a faster rider, in time rather than distance", () => {
    const firstCallAt = (speedKmh: number): number => {
      const r = new Ride(route(TOWN));
      for (const s of pathSteps(r, speedKmh, 420)) {
        if (s.spoken.some((t) => t.includes("Beta Street"))) return s.alongM;
      }
      return Infinity;
    };
    expect(firstCallAt(25)).toBeLessThan(firstCallAt(8));
  });

  it("says the same distance it shows", () => {
    // riders heard "in three hundred metres" against a banner reading 280 m
    for (const units of ["imperial", "metric"] as const) {
      setUnits(units);
      const r = new Ride(route(TOWN));
      const shown = new Set<string>();
      r.ride({ speedKmh: 13, untilM: 1400, jitterM: 3 });
      for (const e of r.effects) if (e.type === "banner") shown.add(navDistText(e.distToNextM));
      const said = r.spoken.flatMap((p) =>
        [...p.matchAll(/in ([\d.]+) (feet|meters|miles?|kilometers?)/g)].map((m) => `${m[1]} ${m[2]}`),
      );
      expect(said.length, units).toBeGreaterThan(0);
      const abbrev: Record<string, string> = { feet: "ft", meters: "m", mile: "mi", miles: "mi" };
      for (const s of said) {
        const [n, unit] = s.split(" ") as [string, string];
        expect([...shown], `${units}: "${s}"`).toContain(`${n} ${abbrev[unit] ?? unit}`);
      }
    }
  });
});

/** Ride, reporting what each fix made the engine say and where the rider was. */
function* pathSteps(
  r: Ride,
  speedKmh: number,
  untilM: number,
): Generator<{ alongM: number; spoken: string[] }> {
  const path = pathOf(r.payload);
  for (let m = 0; m <= untilM; m += (speedKmh * 1000) / 3600) {
    const { at, bearing } = pointAlong(path, m);
    const speed = (speedKmh * 1000) / 3600;
    const step = r.fix({ lon: at[0], lat: at[1], accuracy: 8, speed, heading: bearing });
    yield { alongM: m, spoken: (step?.effects ?? []).flatMap((e) => (e.type === "speak" ? [e.text] : [])) };
  }
}

describe("the dot", () => {
  it("sits on the route through GPS wander, and shows a real departure as one", () => {
    const r = new Ride(route(TOWN));
    const on = r.fix({ ...offsetFix([LON, LAT], 0, 12), speed: 3 });
    expect(on?.dot[1]).toBeCloseTo(LAT, 6);
    const off = r.fix({ ...offsetFix([LON + 100 / mPerDegLon(LAT), LAT], 0, 35), speed: 3 });
    expect(off?.dot[1]).not.toBeCloseTo(LAT, 5);
  });
});

function offsetFix(at: LngLat, bearing: number, m: number): RideFix {
  const [lon, lat] = offset(at, bearing, m);
  return { lon, lat, accuracy: 8, speed: 3, heading: 90 };
}

describe("a wrong turn", () => {
  it("is rerouted after a few sure fixes, and the rider is told", () => {
    const r = new Ride(route(TOWN));
    r.ride({ untilM: 260, divertAtM: 200, divertM: 90, fixHz: 2 });
    expect(r.effects.some((e) => e.type === "reroute")).toBe(true);
    expect(r.spoken).toContain("rerouting.");
    expect(r.effects.some((e) => e.type === "alert" && e.text === "⚠ off route")).toBe(true);
  });

  it("says 'rerouting' once, not on every attempt", () => {
    // the old fixed cooldown re-announced every 10 s for as long as the rider
    // stayed off the line
    const r = new Ride(route(TOWN));
    r.onReroute = () => null; // standing in a car park: no way on from here
    r.ride({ untilM: 420, divertAtM: 200, divertM: 220, fixHz: 2, speedKmh: 12 });
    const attempts = r.effects.filter((e) => e.type === "reroute").length;
    expect(attempts).toBeGreaterThan(1);
    expect(r.spoken.filter((s) => /rerouting/.test(s))).toHaveLength(1);
  });

  it("backs off between attempts, and speaks again only after a while", () => {
    const r = new Ride(route(TOWN));
    r.onReroute = () => null;
    const off = offsetFix([LON + 200 / mPerDegLon(LAT), LAT], 0, 120);
    const at: number[] = [];
    for (let s = 0; s < 200; s++) {
      const step = r.fix(off);
      if (step?.effects.some((e) => e.type === "reroute")) at.push(r.now);
    }
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number));
    expect(gaps[0]).toBeGreaterThan(10_000);
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(60_000); // capped at 6x
    const said = r.spoken.filter((s) => /rerouting/.test(s)).length;
    expect(said).toBeLessThanOrEqual(Math.ceil((200 * 1000) / REROUTE_ANNOUNCE_MIN_MS));
  });

  it("says so when the rider is back on the line before the new way arrives", () => {
    // the way back is still being planned (the worker is slow on a phone):
    // arriving now, it would send a rider who already put things right off again
    const r = new Ride(route(TOWN));
    r.onReroute = () => null; // never answered, as far as this ride knows
    r.ride({ untilM: 320, divertAtM: 200, divertM: 90, fixHz: 2 });
    const effects = r.effects.map((e) => e.type);
    const asked = effects.indexOf("reroute");
    expect(asked).toBeGreaterThan(-1);
    expect(effects.indexOf("rejoined")).toBeGreaterThan(asked);
    expect(effects.filter((t) => t === "rejoined")).toHaveLength(1);
  });

  it("isn't fooled into dropping the way back by one fix that lands on the line", () => {
    // GPS wander during a real wrong turn, one fix onto the route and off
    // again: that used to cancel the reroute being planned
    const r = new Ride(route(TOWN));
    r.onReroute = () => null;
    const off = (m: number): RideFix => offsetFix([LON + m / mPerDegLon(LAT), LAT], 0, OFF_ROUTE_M + 40);
    for (const m of [200, 205, 210, 215]) r.fix(off(m));
    expect(r.effects.some((e) => e.type === "reroute")).toBe(true);
    r.fix(offsetFix([LON + 220 / mPerDegLon(LAT), LAT], 0, 5)); // one stray fix on the line
    for (const m of [225, 230]) r.fix(off(m));
    expect(r.effects.some((e) => e.type === "rejoined")).toBe(false);
  });

  it("isn't talked out of a wrong turn by a poor fix that lands on the line", () => {
    // a useless fix is no evidence the rider is back: it used to wipe the
    // strikes, and a wrong turn with poor GPS in it never became a reroute
    const r = new Ride(route(TOWN));
    const off = (m: number): RideFix => offsetFix([LON + m / mPerDegLon(LAT), LAT], 0, OFF_ROUTE_M + 40);
    r.fix(off(200));
    r.fix(off(205));
    r.fix({ ...offsetFix([LON + 208 / mPerDegLon(LAT), LAT], 0, 5), accuracy: 120 });
    r.fix(off(211));
    expect(r.effects.some((e) => e.type === "reroute")).toBe(true);
  });

  it("doesn't say the rider rejoined when no reroute was asked for", () => {
    const r = new Ride(route(TOWN));
    // off the line for two fixes, one short of a wrong turn, and back
    r.ride({ untilM: 320, divertAtM: 200, divertM: 6, fixHz: 1 });
    r.fix(offsetFix([LON + 250 / mPerDegLon(LAT), LAT], 0, OFF_ROUTE_M + 20));
    r.fix(offsetFix([LON + 252 / mPerDegLon(LAT), LAT], 0, OFF_ROUTE_M + 20));
    r.ride({ fromM: 260, untilM: 300 });
    expect(r.effects.some((e) => e.type === "reroute")).toBe(false);
    expect(r.effects.some((e) => e.type === "rejoined")).toBe(false);
  });

  it("isn't told it rejoined once the new way has been handed over", () => {
    const r = new Ride(route(TOWN)); // default: every reroute is answered at once
    r.ride({ untilM: 260, divertAtM: 200, divertM: 90, fixHz: 2 });
    expect(r.effects.some((e) => e.type === "reroute")).toBe(true);
    expect(r.effects.some((e) => e.type === "rejoined")).toBe(false);
  });

  it("follows the rider's direction when asked to go their way", () => {
    const r = new Ride(route(TOWN));
    r.myWay = true;
    r.ride({ untilM: 260, divertAtM: 200, divertM: 90, fixHz: 2 });
    const reroute = r.effects.find((e) => e.type === "reroute");
    expect(reroute?.type === "reroute" && reroute.heading).not.toBeNull();
    expect(r.spoken).toContain("okay, going your way.");
  });

  it("isn't declared on a bad GPS stretch", () => {
    // 90 m accuracy for 180 m: worse than MAX_GPS_ACCURACY_M, so those fixes
    // must not be trusted to put the rider off the route
    const r = new Ride(route(TOWN));
    r.ride({ untilM: 300, degradeFromM: 80, degradeToM: 260, fixHz: 2 });
    expect(90).toBeGreaterThan(MAX_GPS_ACCURACY_M);
    expect(r.effects.filter((e) => e.type === "reroute")).toHaveLength(0);
    expect(r.spoken.filter((s) => /rerouting/.test(s))).toHaveLength(0);
  });

  it("shows the trip as the crow flies while off the line", () => {
    const r = new Ride(route(TOWN));
    r.fix(offsetFix([LON + 100 / mPerDegLon(LAT), LAT], 0, OFF_ROUTE_M + 30));
    expect(r.last("trip")?.straight).toBe(true);
    expect(r.last("offRoute")).toBeDefined();
  });
});

describe("GPS trouble", () => {
  it("a single teleporting fix can't end the ride", () => {
    // A phone re-acquiring off a cell tower emits one fix far from the rider. It
    // used to latch "arrived!" — banner frozen and voice dead for the rest of
    // the ride, plus a fabricated distance written to history.
    const r = new Ride(route(TOWN));
    r.ride({ untilM: 300 });
    const end = lastOf(pathOf(r.payload));
    expect(r.fix({ lon: end[0], lat: end[1], accuracy: 8, speed: 3, heading: 0 })).toBeNull();
    r.ride({ fromM: 300, untilM: 600 });
    expect(r.spoken.join(" | ")).not.toMatch(/arrived/);
    expect(r.effects.filter((e) => e.type === "arrived")).toHaveLength(0);
  });

  it("believes a jump that repeats: the rider really did move", () => {
    const r = new Ride(route(TOWN));
    r.ride({ untilM: 100 });
    const far = pointAlong(pathOf(r.payload), 3000).at;
    const jump: RideFix = { lon: far[0], lat: far[1], accuracy: 8, speed: 3, heading: 0 };
    expect(r.fix(jump)).toBeNull();
    expect(r.fix(jump)).toBeNull();
    expect(r.fix(jump)?.alongM).toBeGreaterThan(2900);
  });

  it("a useless fix holds the distance and says the signal is poor", () => {
    // 120 m accuracy: the readout used to bounce 40 -> now -> 100 m
    const r = new Ride(route(TOWN));
    r.ride({ untilM: 250 });
    const held = r.last("banner");
    const before = r.steps.length;
    for (let i = 0; i < 8; i++) {
      r.fix({ ...offsetFix(pointAlong(pathOf(r.payload), 250).at, 90, i * 30), accuracy: 120 });
    }
    const later = r.steps.slice(before).flatMap((s) => s.effects);
    expect(later.filter((e) => e.type === "banner")).toHaveLength(0);
    expect(later.some((e) => e.type === "alert" && /poor/.test(e.text))).toBe(true);
    expect(r.last("banner")).toBe(held);
  });
});

describe("the trip line", () => {
  it("holds the arrival time through a red light", () => {
    // it swung ~6 minutes at every stop, flipping between measured and
    // profile pace
    const r = new Ride(route(TOWN));
    r.ride({ speedKmh: 11, untilM: 399 });
    const rolling = r.last("trip")?.minutes;
    r.ride({ speedKmh: 11, fromM: 399, untilM: 460, pauseAtM: 400, pauseSeconds: 30 });
    const stopped = r.steps
      .flatMap((s) => s.effects)
      .filter((e): e is Extract<RideEffect, { type: "trip" }> => e.type === "trip")
      .map((e) => e.minutes);
    expect(stopped.length).toBeGreaterThan(40);
    for (const m of stopped.slice(-40)) expect(Math.abs(m - (rolling ?? 0))).toBeLessThanOrEqual(3);
  });

  it("uses the profile's pace until one is measured", () => {
    const r = new Ride(route(TOWN));
    r.fix({ lon: LON, lat: LAT, accuracy: 8, speed: 0, heading: 90 });
    // 4.1 km at the context's 10 km/h
    expect(r.last("trip")?.minutes).toBe(Math.round((4.1 / 10) * 60));
  });

  it("holds the view still while stopped, and turns it once moving", () => {
    // At a corner the way ahead turns: Alpha runs east, Beta north from 400 m.
    // A stationary fix that lands just round it (GPS drift at a light) must not
    // swing the map a quarter turn; moving there, it should follow the street.
    const r = new Ride(route(TOWN));
    r.ride({ untilM: 330 });
    const riding = r.engine.bearingTarget;
    expect(riding).toBeGreaterThan(60); // looking along Alpha, east
    const round = pointAlong(pathOf(r.payload), 430).at;
    for (let i = 0; i < 5; i++) r.fix({ lon: round[0], lat: round[1], accuracy: 8, speed: 0, heading: 0 });
    expect(r.engine.bearingTarget).toBe(riding);
    for (let i = 0; i < 5; i++) r.fix({ lon: round[0], lat: round[1], accuracy: 8, speed: 3, heading: 0 });
    expect(Math.abs(r.engine.bearingTarget - riding)).toBeGreaterThan(30);
  });
});

describe("a turn missed", () => {
  it("is called again when the rider comes back to it", () => {
    // `next` only ever advanced, so a missed turn was never announced again
    const r = new Ride(route(TOWN));
    r.ride({ untilM: 480 }); // round the corner and up Beta: its turn is behind
    const called = r.spoken.filter((s) => s.includes("Beta Street")).length;
    // back down Beta and along Alpha, then at the corner again
    const path = pathOf(r.payload);
    for (let m = 480; m >= 200; m -= 4) {
      const { at } = pointAlong(path, m);
      r.fix({ lon: at[0], lat: at[1], accuracy: 8, speed: 3.3, heading: 270 });
    }
    r.ride({ fromM: 200, untilM: 420 });
    expect(r.spoken.filter((s) => s.includes("Beta Street")).length).toBeGreaterThan(called);
  });
});

describe("milestones", () => {
  it("aren't machine-gunned when the ride is joined part-way", () => {
    // first fix ~2.3 km along, as after a train leg: it used to fire "1
    // mile done… 20 miles done" one per second before any guidance
    const r = new Ride(route(TOWN));
    r.ride({ fromM: 2300, untilM: 2400 });
    expect(r.spoken.filter((s) => /miles? done/.test(s)).length).toBeLessThanOrEqual(1);
  });
});

describe("hazards", () => {
  const busy: RibbonSeg[] = [
    { m: 900, cls: "quiet_street", e0: 10, e1: 10, crossing: false },
    { m: 30, cls: "quiet_street", e0: 10, e1: 10, crossing: true },
    { m: 3170, cls: "quiet_street", e0: 10, e1: 10, crossing: false },
  ];

  it("are said, shown, and taken down once passed", () => {
    const r = new Ride(route(TOWN, busy));
    r.ride({ untilM: 1000 });
    const said = r.effects.find((e) => e.type === "speak" && /crossing/.test(e.text));
    expect(said?.type === "speak" && said.priority).toBe("safety");
    const shown = r.effects.findIndex((e) => e.type === "alert" && e.kind === "hazard");
    expect(shown).toBeGreaterThan(-1);
    expect(r.effects.slice(shown).some((e) => e.type === "hideAlert")).toBe(true);
  });

  it("aren't taken down by the engine once something else took them down", () => {
    const r = new Ride(route(TOWN, busy));
    r.ride({ untilM: 850 });
    r.engine.alertHidden();
    const before = r.effects.length;
    r.ride({ fromM: 850, untilM: 1000 });
    expect(r.effects.slice(before).filter((e) => e.type === "hideAlert")).toHaveLength(0);
  });

  it("tell a solo rider to take care rather than to gather up", () => {
    const r = new Ride(route(TOWN, busy));
    r.solo = true;
    r.ride({ untilM: 1000 });
    expect(r.spoken.filter((s) => /gather up/.test(s))).toHaveLength(0);
    expect(r.spoken.some((s) => /take care/.test(s))).toBe(true);
  });
});

describe("arriving", () => {
  it("at a stop is a pause, not the end of the ride", () => {
    const r = new Ride(route(TOWN.slice(0, 2)));
    r.atStop = true;
    r.ride();
    expect(r.last("arrived")?.atStop).toBe(true);
    expect(r.spoken.join(" | ")).toMatch(/arrived at your stop/);
    expect(r.spoken.join(" | ")).not.toMatch(/nicely done/);
  });

  it("leaves the arrival up rather than the last turn", () => {
    const r = new Ride(route(TOWN.slice(0, 2)));
    r.ride();
    const after = r.steps.slice(r.steps.findIndex((s) => s.effects.some((e) => e.type === "arrived")) + 1);
    const end = lastOf(pathOf(r.payload));
    for (let i = 0; i < 3; i++) {
      after.push(r.fix({ lon: end[0], lat: end[1], accuracy: 8, speed: 0 }) as RideStep);
    }
    expect(after.flatMap((s) => s.effects).filter((e) => e.type === "banner")).toHaveLength(0);
  });

  it("doesn't latch when a second ride starts at the old destination", () => {
    // it used to say "arrived!" on the first fix and never update again
    const there = route(TOWN.slice(0, 2));
    const r = new Ride(there);
    r.ride();
    expect(r.last("arrived")).toBeDefined();
    // the way back, from where the rider stands
    const back = route(
      [
        ["S", 300, "Beta Street"],
        ["W", 400, "Alpha Street"],
      ],
      undefined,
      lastOf(pathOf(there)),
    );
    r.engine.start();
    r.engine.setRoute(back);
    r.dest = [LON, LAT];
    const before = r.steps.length;
    const path = pathOf(back);
    for (let m = 0; m <= 400; m += 4) {
      const { at, bearing } = pointAlong(path, m);
      r.fix({ lon: at[0], lat: at[1], accuracy: 8, speed: 4, heading: bearing });
    }
    const later = r.steps.slice(before).flatMap((s) => s.effects);
    expect(later.filter((e) => e.type === "arrived")).toHaveLength(0);
    expect(later.filter((e) => e.type === "banner").length).toBeGreaterThan(50);
  });
});

describe("a round trip", () => {
  const LOOP: [Dir, number, string][] = [
    ["E", 600, "Alpha Street"],
    ["N", 400, "Beta Street"],
    ["W", 600, "Gamma Street"],
    ["S", 400, "Delta Street"],
  ];

  it("doesn't arrive at the start, where it also ends", () => {
    // with no hint the first fix snapped to the finish: "you have arrived" at
    // the start of every loop
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 50 });
    expect(r.effects.filter((e) => e.type === "arrived")).toHaveLength(0);
    r.ride({ fromM: 50 });
    expect(r.effects.filter((e) => e.type === "arrived")).toHaveLength(1);
  });

  it("keeps counting after a GPS gap, as far as a bicycle could have gone in it", () => {
    // a tunnel, a phone in a pocket: progress used to stop for good, because
    // the rider was more than a step past the furthest point from then on
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 300 });
    expect(r.engine.loopDoneM).toBeLessThan(320);
    r.now += 90_000; // a minute and a half without a fix: 600 m at 6.7 m/s
    r.ride({ fromM: 900, untilM: 1100 });
    expect(r.engine.loopDoneM).toBeGreaterThan(1050);
  });

  it("doesn't let time spent off the loop buy a far-side snap on the way back", () => {
    // a minute on a wrong turn beside the loop is not a minute of riding round
    // it: measured by time, it was, and a snap onto the far side counted
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.onReroute = () => null;
    r.ride({ untilM: 300 });
    const done = r.engine.loopDoneM;
    const start = pointAlong(pathOf(r.payload), 300).at;
    for (let i = 0; i < 60; i++) {
      // pottering about 60-100 m off the loop, at walking pace
      r.fix({ ...offsetFix(start, 180, 60 + (i % 10) * 4), speed: 1.2 });
    }
    const far = pointAlong(pathOf(r.payload), 1300).at;
    const step = r.fix({ lon: far[0], lat: far[1], accuracy: 8, speed: 4, heading: 270 });
    expect(step?.alongM ?? 0).toBeGreaterThan(1200);
    expect(r.engine.loopDoneM).toBeLessThan(done + 100);
  });

  it("gives riding off the loop, seen fix by fix, no allowance at all", () => {
    // a real wrong turn at cycling speed for a minute: every metre of it was
    // seen, and none of it was round the loop
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.onReroute = () => null;
    r.ride({ untilM: 300 });
    const done = r.engine.loopDoneM;
    const start = pointAlong(pathOf(r.payload), 300).at;
    // 360 m of riding seen, 60 m south of the loop and alongside it; measured
    // as ground covered, it bought 976 m
    for (let i = 1; i <= 60; i++) {
      r.fix({ ...offsetFix(offset(start, 90, i * 6), 180, 60), speed: 6 });
    }
    const far = pointAlong(pathOf(r.payload), 1100).at; // 800 m round
    const step = r.fix({ lon: far[0], lat: far[1], accuracy: 8, speed: 6, heading: 270 });
    expect(step?.alongM ?? 0).toBeGreaterThan(1050);
    expect(r.engine.loopDoneM).toBeLessThan(done + 100);
  });

  it("doesn't count a poor fix, landing on the far side after a gap, as ridden", () => {
    // After a gap the next fix is the one that would have earned the ground
    // covered unseen, and a poor one (a tower's guess of the position) says
    // nothing: it was read as a rider turning up on the far side of the loop.
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 300 });
    const done = r.engine.loopDoneM;
    r.now += 90_000;
    const far = pointAlong(pathOf(r.payload), 1100).at;
    r.fix({ lon: far[0], lat: far[1], accuracy: 60, speed: 4, heading: 270 });
    expect(r.engine.loopDoneM).toBeLessThan(done + 100);
    // and the good fixes that follow, back where the rider is, don't have it
    // counted either
    r.ride({ fromM: 305, untilM: 330 });
    expect(r.engine.loopDoneM).toBeLessThan(done + 150);
  });

  it("gives a gap that began off the loop no allowance for the ground it covered", () => {
    // a wrong turn, then the phone loses its signal: the rider was not on the
    // loop when the gap began, so the straight line across it isn't ground
    // ridden round the loop, and a snap onto the far side afterwards earns none
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.onReroute = () => null;
    r.ride({ untilM: 300 });
    const done = r.engine.loopDoneM;
    const start = pointAlong(pathOf(r.payload), 300).at;
    for (let i = 0; i < 8; i++) r.fix({ ...offsetFix(start, 180, 70 + i), speed: 4 });
    r.now += 90_000;
    // 600 m round the loop from the rider's furthest point, and inside the
    // jump the engine would dismiss as the phone re-finding itself
    const far = pointAlong(pathOf(r.payload), 900).at;
    const step = r.fix({ lon: far[0], lat: far[1], accuracy: 8, speed: 5, heading: 0 });
    expect(step?.alongM ?? 0).toBeGreaterThan(850);
    expect(r.engine.loopDoneM).toBeLessThan(done + 100);
  });

  it("doesn't let a poor fix far away spend the allowance for a good fix back where the rider is", () => {
    // After a gap, a poor fix (a tower's guess) far round the loop must not earn
    // the distance to it: the good fixes that follow, where the rider really
    // is, would then find the allowance already added and a snap to the far side
    // would count.
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 300 });
    const done = r.engine.loopDoneM;
    r.now += 90_000;
    const far = pointAlong(pathOf(r.payload), 900).at;
    r.fix({ lon: far[0], lat: far[1], accuracy: 60, speed: 4, heading: 0 });
    r.ride({ fromM: 305, untilM: 330 });
    // now a good fix on the far side, a second later: seen, so unearned
    r.fix({ lon: far[0], lat: far[1], accuracy: 8, speed: 4, heading: 0 });
    expect(r.engine.loopDoneM).toBeLessThan(done + 200);
  });

  it("keeps the allowance through one good fix that lands off the line on picking the signal up", () => {
    // the first fix after a tunnel is often tens of metres out while claiming to
    // be good: one such fix is multipath, not a wrong turn, and the ground
    // covered unseen in the gap is still ground ridden round the loop
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.onReroute = () => null;
    r.ride({ untilM: 300 });
    r.now += 90_000;
    const at700 = pointAlong(pathOf(r.payload), 700).at;
    // 45 m from the line (past OFF_ROUTE_M) ...
    r.fix({ ...offsetFix(at700, 90, 45), speed: 5 });
    // ... and then on it, a little further round
    r.ride({ fromM: 710, untilM: 730 });
    expect(r.engine.loopDoneM).toBeGreaterThan(650);
  });

  it("gives a gap that began at a good fix already off the line no allowance, though it isn't yet a sure wrong turn", () => {
    // one or two good fixes off the line aren't enough to reroute, but they are
    // enough to say the rider was not on the loop as the signal went
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.onReroute = () => null;
    r.ride({ untilM: 300 });
    const done = r.engine.loopDoneM;
    const start = pointAlong(pathOf(r.payload), 300).at;
    r.fix({ ...offsetFix(start, 180, 70), speed: 4 }); // one fix, 70 m south: off the line
    r.now += 90_000;
    const far = pointAlong(pathOf(r.payload), 900).at;
    r.fix({ lon: far[0], lat: far[1], accuracy: 8, speed: 5, heading: 0 });
    expect(r.engine.loopDoneM).toBeLessThan(done + 100);
  });

  it("still counts a gap that began on the loop, which is what the allowance is for", () => {
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 300 });
    r.now += 90_000;
    const far = pointAlong(pathOf(r.payload), 700).at;
    r.fix({ lon: far[0], lat: far[1], accuracy: 8, speed: 5, heading: 0 });
    expect(r.engine.loopDoneM).toBeGreaterThan(650);
  });

  it("rides on after a gap round a corner of the loop", () => {
    // the straight line across a gap is shorter than the way round: here
    // 450 m of it for 1200 m round, which the winding allowance covers
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 300 });
    r.now += 60_000;
    r.ride({ fromM: 1500, untilM: 1600, speedKmh: 12 });
    expect(r.engine.loopDoneM).toBeGreaterThan(1550);
  });

  it("counts from where a way back rejoins the loop further round", () => {
    // the way back from a wrong turn can join the loop ahead of where the
    // rider left it: the track followed now starts 1000 m round the loop
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 300 });
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 1000 });
    r.ride({ untilM: 100 });
    expect(r.engine.loopDoneM).toBeGreaterThan(1050);
  });

  it("doesn't count snaps onto the far side as ridden, however many in a row", () => {
    // a wrong turn's first metres can run past another stretch of the loop,
    // and every fix there snaps to it: three in a row were once believed, and
    // the way back rejoined the loop a kilometre ahead of the rider
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 300 });
    const done = r.engine.loopDoneM;
    const far = pointAlong(pathOf(r.payload), 1300).at;
    for (let i = 0; i < 6; i++) {
      const step = r.fix({ lon: far[0], lat: far[1], accuracy: 8, speed: 4, heading: 270 });
      // on the loop, over there: the case under test, not an off-route fix
      expect(step?.alongM ?? 0).toBeGreaterThan(1200);
    }
    r.ride({ fromM: 305, untilM: 320 });
    expect(r.engine.loopDoneM).toBeLessThan(done + 100);
  });

  it("counts progress round it forwards only, a bicycle's worth at a time", () => {
    const r = new Ride(route(LOOP));
    r.engine.setRoute(r.payload, { legM: 0, resumeM: 0 });
    r.ride({ untilM: 700 });
    const done = r.engine.loopDoneM;
    expect(done).toBeGreaterThan(650);
    // a fix on the far side of the loop is not a kilometre ridden
    const far = pointAlong(pathOf(r.payload), 1700).at;
    for (let i = 0; i < 3; i++) r.fix({ lon: far[0], lat: far[1], accuracy: 8, speed: 4, heading: 0 });
    expect(r.engine.loopDoneM).toBeLessThan(done + 400);
  });
});
