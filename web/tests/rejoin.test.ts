// Getting back onto a round trip: where to aim, and the route that results.
import { describe, expect, it } from "vitest";

import { loopRejoinPoint, payloadLength, rejoinOption, spliceLoop } from "../src/rejoin.js";
import type { LineFeature, ProtectionClass, RouteOption, RoutePayload } from "../src/types.js";

const LAT = 42.38;
const M_LON = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const M_LAT = 1 / 110_540;

/** A square loop of four 250 m sides, one feature per side, starting and
 * ending at the south-west corner. */
function squareLoop(): RoutePayload {
  const corner = (x: number, y: number): [number, number] => [-71.1 + x * M_LON, LAT + y * M_LAT];
  const corners = [corner(0, 0), corner(250, 0), corner(250, 250), corner(0, 250), corner(0, 0)];
  const classes: ProtectionClass[] = ["path", "quiet_street", "busy_street", "path"];
  const features: LineFeature[] = classes.map((cls, i) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: [corners[i]!, corners[i + 1]!] },
    properties: { cls, color: "#000", name: `side ${i + 1}` },
  }));
  return {
    geojson: { type: "FeatureCollection", features },
    ribbon: classes.map((cls) => ({ m: 250, cls, e0: 10, e1: 12, crossing: false })),
    summary: {
      meters: 1000,
      minutes: 8,
      pct_protected: 50,
      pct_quiet: 25,
      by_class_m: { path: 500, quiet_street: 250, busy_street: 250 },
      cautions: [
        { name: "side 3", cls: "busy_street", meters: 250, lon: corners[2]![0], lat: corners[2]![1] },
      ],
    },
  };
}

/** A 100 m lead from somewhere off the loop to its third corner. */
function lead(to: [number, number]): RoutePayload {
  const from: [number, number] = [to[0] + 100 * M_LON, to[1]];
  return {
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [from, to] },
          properties: { cls: "quiet_street", color: "#000", name: "way back" },
        },
      ],
    },
    ribbon: [{ m: 100, cls: "quiet_street", e0: 12, e1: 12, crossing: false }],
    summary: {
      meters: 100,
      minutes: 1,
      pct_protected: 0,
      pct_quiet: 100,
      by_class_m: { quiet_street: 100 },
      cautions: [],
    },
  };
}

describe("loopRejoinPoint", () => {
  it("aims past the rider's progress, at the start of a street segment", () => {
    const loop = squareLoop();
    // 300 m round (on side 2) plus 150 ahead: side 3 starts at 500 m
    const p = loopRejoinPoint(loop, 300);
    expect(p?.index).toBe(2);
    expect(p?.atM).toBeCloseTo(500, 0);
    expect(p?.at).toEqual(loop.geojson.features[2]?.geometry.coordinates[0]);
  });

  it("never aims at the start, even with no progress at all", () => {
    expect(loopRejoinPoint(squareLoop(), 0)?.index).toBe(1);
  });

  it("gives up on the loop once only a short stretch is left", () => {
    // 900 m round a 1000 m loop: nothing starts 150 m further on
    expect(loopRejoinPoint(squareLoop(), 900)).toBeNull();
  });
});

describe("spliceLoop", () => {
  it("follows the way back, then the rest of the loop to its finish", () => {
    const loop = squareLoop();
    const at = loop.geojson.features[2]!.geometry.coordinates[0]!;
    const out = spliceLoop(lead(at), loop, 2);
    const names = out.geojson.features.map((f) => f.properties.name);
    expect(names).toEqual(["way back", "side 3", "side 4"]);
    // ends where the loop does
    const lastOf = (p: RoutePayload): [number, number] | undefined => {
      const cs = p.geojson.features[p.geojson.features.length - 1]?.geometry.coordinates ?? [];
      return cs[cs.length - 1];
    };
    expect(lastOf(out)).toEqual(lastOf(loop));
    expect(out.ribbon).toHaveLength(3);
  });

  it("describes what will be ridden, not the loop as planned", () => {
    const loop = squareLoop();
    const at = loop.geojson.features[2]!.geometry.coordinates[0]!;
    const s = spliceLoop(lead(at), loop, 2).summary;
    expect(s.meters).toBe(600);
    expect(s.by_class_m).toEqual({ busy_street: 250, path: 250, quiet_street: 100 });
    expect(s.pct_protected).toBe(42); // 250 of 600
    expect(s.pct_quiet).toBe(17);
    expect(s.minutes).toBe(1 + 4); // the lead, and half the loop's time
    // the busy side is still ahead, so its caution stays
    expect(s.cautions.map((c) => c.name)).toEqual(["side 3"]);
  });

  it("drops cautions on the part already ridden", () => {
    const loop = squareLoop();
    const at = loop.geojson.features[3]!.geometry.coordinates[0]!;
    expect(spliceLoop(lead(at), loop, 3).summary.cautions).toEqual([]);
  });

  it("is as long as navigation will measure it", () => {
    const loop = squareLoop();
    const at = loop.geojson.features[2]!.geometry.coordinates[0]!;
    expect(payloadLength(spliceLoop(lead(at), loop, 2))).toBeCloseTo(600, 0);
  });
});

describe("rejoinOption", () => {
  it("stays the loop, graded by the worse of the two parts", () => {
    const loop = squareLoop();
    const at = loop.geojson.features[2]!.geometry.coordinates[0]!;
    const loopOpt: RouteOption = {
      id: "loop2",
      label: "Loop",
      grade: "B",
      gradeReason: "mostly paths",
      payload: loop,
    };
    const leadOpt: RouteOption = {
      id: "safest",
      label: "Safest",
      grade: "D",
      gradeReason: "a busy crossing",
      payload: lead(at),
    };
    const o = rejoinOption(leadOpt, loopOpt, 2);
    expect(o.id).toBe("loop2");
    expect(o.grade).toBe("D");
    expect(o.label).toMatch(/back to the loop/);
  });
});
