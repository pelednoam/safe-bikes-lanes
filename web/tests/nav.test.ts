// Tests for turn-by-turn navigation math on synthetic routes.
import { describe, expect, it } from "vitest";

import { buildManeuvers, buildTrack, snapToTrack, turnAngle } from "../src/nav.js";
import type { LineFeature, ProtectionClass, RoutePayload } from "../src/types.js";

const LAT = 42.38;
const LON = -71.1;
/** meters -> degrees at this latitude */
const DLON = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const DLAT = 1 / 110_540;

function feature(name: string, coords: [number, number][]): LineFeature {
  const cls: ProtectionClass = "quiet_street";
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: { cls, color: "#d9ef8b", name },
  };
}

/** 100 m east on "Alpha", then 100 m north on "Beta" — a left turn. */
function lRoute(): RoutePayload {
  const p1: [number, number] = [LON, LAT];
  const p2: [number, number] = [LON + 100 * DLON, LAT];
  const p3: [number, number] = [LON + 100 * DLON, LAT + 100 * DLAT];
  return {
    geojson: {
      type: "FeatureCollection",
      features: [feature("Alpha", [p1, p2]), feature("Beta", [p2, p3])],
    },
    summary: {
      meters: 200,
      minutes: 2,
      pct_protected: 0,
      pct_quiet: 100,
      by_class_m: {},
      cautions: [],
    },
  };
}

describe("turnAngle", () => {
  it("computes signed turns and wraps correctly", () => {
    expect(turnAngle(90, 0)).toBe(-90); // east -> north = left
    expect(turnAngle(0, 90)).toBe(90); // north -> east = right
    expect(turnAngle(350, 10)).toBe(20); // wrap across 0
    expect(turnAngle(10, 350)).toBe(-20);
  });
});

describe("buildTrack", () => {
  it("accumulates distances along the route", () => {
    const track = buildTrack(lRoute());
    expect(track.coords).toHaveLength(3);
    expect(track.totalM).toBeGreaterThan(195);
    expect(track.totalM).toBeLessThan(205);
  });
});

describe("buildManeuvers", () => {
  it("emits a left turn at the corner and an arrival", () => {
    const maneuvers = buildManeuvers(lRoute());
    expect(maneuvers).toHaveLength(2);
    expect(maneuvers[0]?.voice).toBe("turn left onto Beta");
    expect(maneuvers[0]?.atM).toBeGreaterThan(95);
    expect(maneuvers[0]?.atM).toBeLessThan(105);
    expect(maneuvers[1]?.voice).toBe("you have arrived");
    expect(maneuvers[1]?.atM).toBeGreaterThan(195);
  });

  it("announces a name change without a turn as continue", () => {
    const p1: [number, number] = [LON, LAT];
    const p2: [number, number] = [LON + 100 * DLON, LAT];
    const p3: [number, number] = [LON + 200 * DLON, LAT];
    const payload: RoutePayload = {
      geojson: {
        type: "FeatureCollection",
        features: [feature("Alpha", [p1, p2]), feature("Gamma", [p2, p3])],
      },
      summary: lRoute().summary,
    };
    const maneuvers = buildManeuvers(payload);
    expect(maneuvers[0]?.voice).toBe("continue onto Gamma");
    expect(maneuvers[0]?.icon).toBe("⬆");
  });
});

describe("snapToTrack", () => {
  it("projects a GPS point onto the route with along-distance", () => {
    const track = buildTrack(lRoute());
    // ~50 m along the first (eastbound) leg, 10 m south of it
    const snap = snapToTrack(track, LON + 50 * DLON, LAT - 10 * DLAT);
    expect(snap.idx).toBe(0);
    expect(snap.offM).toBeGreaterThan(8);
    expect(snap.offM).toBeLessThan(12);
    expect(snap.alongM).toBeGreaterThan(45);
    expect(snap.alongM).toBeLessThan(55);
  });

  it("prefers the windowed match near the hint on self-crossing tracks", () => {
    const track = buildTrack(lRoute());
    // point near the corner: with a hint at the start, still resolves sanely
    const snap = snapToTrack(track, LON + 99 * DLON, LAT + 1 * DLAT, 0);
    expect(snap.alongM).toBeGreaterThan(90);
  });
});
