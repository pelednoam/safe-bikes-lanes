// Tests for ride recording and history stats.
import { beforeEach, describe, expect, it } from "vitest";

import { RideRecorder, rideTotals, stashInProgress, takeInProgress } from "../src/rides.js";
import type { RideSummary } from "../src/rides.js";

const LAT = 42.38;
const LON = -71.1;
const DLON = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));

/** Feed an eastward ride of `meters` at ~5 m/s, one fix per 25 m. */
function ride(meters: number, quietFraction = 1): RideRecorder {
  const r = new RideRecorder();
  const steps = Math.floor(meters / 25);
  for (let i = 0; i <= steps; i++) {
    const cls = i / steps < quietFraction ? "quiet_street" : "busy_street";
    r.addPoint(i * 5000, LON + i * 25 * DLON, LAT, cls);
  }
  return r;
}

describe("RideRecorder", () => {
  it("accumulates distance, moving time, and class mix", () => {
    const summary = ride(1000, 0.5).finish("young_kids");
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.meters).toBeGreaterThan(950);
    expect(summary.meters).toBeLessThan(1050);
    expect(summary.movingS).toBeGreaterThan(150); // 40 fixes * 5 s, minus the first
    expect(summary.pctQuiet).toBeGreaterThan(40);
    expect(summary.pctQuiet).toBeLessThan(60);
    expect(summary.polyline.length).toBeGreaterThan(10);
  });

  it("ignores GPS jitter while stopped", () => {
    const r = new RideRecorder();
    r.addPoint(0, LON, LAT, null);
    for (let i = 1; i <= 20; i++) {
      r.addPoint(i * 1000, LON + 1 * DLON, LAT, null); // ~1 m wiggle
    }
    expect(r.metersSoFar).toBeLessThan(5);
    expect(r.finish("young_kids")).toBeNull();
  });

  it("does not save trivial rides", () => {
    expect(ride(100).finish("young_kids")).toBeNull();
    expect(ride(400).finish("young_kids")).not.toBeNull();
  });
});

describe("rideTotals", () => {
  const mk = (meters: number, startedAt: string, pctProtected = 50): RideSummary => ({
    id: startedAt,
    startedAt,
    meters,
    durationS: 600,
    movingS: 500,
    byClass: {},
    pctProtected,
    pctQuiet: 20,
    profile: "young_kids",
    polyline: [],
  });

  it("aggregates counts, distance, and monthly totals", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    const totals = rideTotals(
      [mk(5000, "2026-07-18T10:00:00.000Z"), mk(3000, "2026-06-01T10:00:00.000Z", 80)],
      now,
    );
    expect(totals.count).toBe(2);
    expect(totals.km).toBe(8);
    expect(totals.thisMonthKm).toBe(5);
    expect(totals.longestKm).toBe(5);
    expect(totals.avgProtectedPct).toBe(61); // (50*5000 + 80*3000) / 8000
  });
});

describe("distance measurement under GPS wander", () => {
  /** Deterministic wander so the expectation is stable. */
  function noise(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff - 0.5;
    };
  }

  /** Ride straight east at `speedKmh`, 1 Hz, with `jitterM` of wander. */
  function measure(speedKmh: number, jitterM: number, metres: number): number {
    const rec = new RideRecorder();
    const lat = 42.38;
    const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
    const step = (speedKmh * 1000) / 3600;
    const rnd = noise(99);
    let t = 0;
    for (let d = 0; d <= metres; d += step) {
      const lon = -71.1 + (d + rnd() * jitterM * 2) / mPerDegLon;
      rec.addPoint(t, lon, lat + (rnd() * jitterM * 2) / 110_540, "quiet_street");
      t += 1000;
    }
    return rec.finish("young_kids")?.meters ?? 0;
  }

  it("is close to the truth at a young-kids pace with realistic wander", () => {
    // 8 km/h is 2.2 m per fix — well under typical 5-15 m bike-GPS wander, which
    // used to make the recorded ride 18-60% long
    const measured = measure(8, 7, 3000);
    expect(measured).toBeGreaterThan(3000 * 0.85);
    expect(measured).toBeLessThan(3000 * 1.15);
  });

  it("doesn't accumulate distance while stopped", () => {
    const rec = new RideRecorder();
    const rnd = noise(7);
    for (let i = 0; i < 120; i++) {
      // parked at a light, 8 m of wander, two minutes
      rec.addPoint(i * 1000, -71.1 + (rnd() * 16) / 82_000, 42.38 + (rnd() * 16) / 110_540, null);
    }
    expect(rec.metersSoFar).toBeLessThan(60);
  });

  it("still measures a fast rider correctly", () => {
    const measured = measure(20, 5, 5000);
    expect(measured).toBeGreaterThan(5000 * 0.9);
    expect(measured).toBeLessThan(5000 * 1.1);
  });
});

// ── the along-route path, and the crash-recovery stash ──────────────────────
// The distance model was wrong twice before this shape landed (a distance-gated
// window measured 32% long, then step-summing 22% long), and none of the
// along-route branches had a test.

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

describe("distance along a known route", () => {
  it("measures from the first fix, which only starts the clock", () => {
    // The first addPoint initialises and returns, so its alongM is a datum and
    // not a distance. Easy to misread, and it changes every expectation here.
    const r = new RideRecorder();
    r.addPoint(0, LON, LAT, "quiet_street", 500);
    expect(r.metersSoFar).toBe(0);
    // the second fix becomes the datum — the first returns before the
    // along-route branch is even reached — so distance starts at the third
    r.addPoint(1000, LON, LAT, "quiet_street", 900);
    expect(r.metersSoFar).toBe(0);
    r.addPoint(2000, LON, LAT, "quiet_street", 1300);
    expect(r.metersSoFar).toBe(400);
  });

  it("counts forward progress and ignores drift backwards", () => {
    const r = new RideRecorder();
    // GPS wander moves the along-track position back and forth; only the
    // high-water mark counts, or wander ratchets the total upwards
    for (const [t, along] of [
      [0, 0], [1000, 50], [2000, 40], [3000, 90], [4000, 85], [5000, 200],
    ] as const) {
      r.addPoint(t, LON, LAT, "quiet_street", along);
    }
    // 50 is the datum (the first counted fix), 200 the high-water mark
    expect(r.metersSoFar).toBe(150);
  });

  it("banks the ridden distance when a reroute rebases the track", () => {
    const r = new RideRecorder();
    r.addPoint(0, LON, LAT, "quiet_street", 0); // datum
    r.addPoint(1000, LON, LAT, "quiet_street", 800);
    r.addPoint(2000, LON, LAT, "quiet_street", 1500);
    // rerouted: the new track's positions start again from near zero
    r.addPoint(3000, LON, LAT, "quiet_street", 10);
    r.addPoint(4000, LON, LAT, "quiet_street", 300);
    // 700 banked from the first track (1500 - 800), 290 on the second
    expect(r.metersSoFar).toBe(990);
  });

  it("attributes forward progress to the class ridden", () => {
    const r = new RideRecorder();
    r.addPoint(0, LON, LAT, "path", 0); // datum
    r.addPoint(1000, LON, LAT, "path", 500);
    r.addPoint(2000, LON, LAT, "path", 1500);
    r.addPoint(3000, LON, LAT, "busy_street", 2000);
    const summary = r.finish("young_kids");
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.byClass["path"]).toBe(1000);
    expect(summary.byClass["busy_street"]).toBe(500);
    expect(summary.pctProtected).toBeGreaterThan(60);
  });
});

describe("a ride interrupted by the app going away", () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage =
      new MemoryStorage();
  });

  it("comes back once, then is gone", () => {
    const ride: RideSummary = {
      id: "r1", startedAt: "2026-08-05T10:00:00.000Z", meters: 4200, durationS: 900,
      movingS: 800, byClass: {}, pctProtected: 50, pctQuiet: 20,
      profile: "young_kids", polyline: [],
    };
    stashInProgress(ride);
    expect(takeInProgress()?.meters).toBe(4200);
    // taking it clears it: a recovered ride must not resurrect on every launch
    expect(takeInProgress()).toBeNull();
  });

  it("returns nothing rather than throwing on junk", () => {
    expect(takeInProgress()).toBeNull();
    localStorage.setItem("rideInProgress", "{not json");
    expect(takeInProgress()).toBeNull();
    localStorage.setItem("rideInProgress", JSON.stringify({ id: 7 }));
    expect(takeInProgress()).toBeNull();
  });

  it("clears the stash when there's nothing underway", () => {
    stashInProgress({
      id: "r2", startedAt: "x", meters: 1, durationS: 1, movingS: 1, byClass: {},
      pctProtected: 0, pctQuiet: 0, profile: "solo", polyline: [],
    });
    stashInProgress(null);
    expect(takeInProgress()).toBeNull();
  });
});
