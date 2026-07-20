// Tests for ride recording and history stats.
import { describe, expect, it } from "vitest";

import { RideRecorder, rideTotals } from "../src/rides.js";
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
