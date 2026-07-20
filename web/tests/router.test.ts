// Behavior tests for the in-browser router on a small synthetic graph.
import { describe, expect, it } from "vitest";

import { Router } from "../src/router.js";

/*
 * Toy network (lon/lat ~ meters-ish apart around Cambridge):
 *
 *   0 --busy(100m)-- 1
 *   0 --quiet(60m)-- 2 --quiet(60m)-- 1
 *
 * Direct busy edge is shorter, but in kids mode busy costs 25x,
 * so the quiet detour must win. Edge columns:
 * [u, v, len, wKids, wSolo, clsIdx, nameIdx, geomIdx]
 */
const CLASSES = ["busy_street", "quiet_street"] as const;

function edge(
  u: number,
  v: number,
  len: number,
  cls: (typeof CLASSES)[number],
  name: number,
): [number, number, number, number, number, number, number, number] {
  const kidsMult = cls === "busy_street" ? 25 : 1.4;
  const soloMult = cls === "busy_street" ? 6 : 1.1;
  return [u, v, len, len * kidsMult, len * soloMult, CLASSES.indexOf(cls), name, -1];
}

function toyRouter(): Router {
  const nodes: [number, number][] = [
    [-71.1, 42.38],
    [-71.099, 42.38],
    [-71.0995, 42.3805],
  ];
  const edges = [
    edge(0, 1, 100, "busy_street", 1),
    edge(1, 0, 100, "busy_street", 1),
    edge(0, 2, 60, "quiet_street", 2),
    edge(2, 0, 60, "quiet_street", 2),
    edge(2, 1, 60, "quiet_street", 2),
    edge(1, 2, 60, "quiet_street", 2),
  ];
  return new Router({
    nodes,
    names: ["", "Busy Ave", "Quiet St"],
    classes: [...CLASSES],
    edges,
    geoms: [],
  });
}

describe("Router", () => {
  it("kids mode detours around the busy street", () => {
    const r = toyRouter();
    const res = r.route([-71.1, 42.38], [-71.099, 42.38], "kids");
    expect(res.safest.summary.meters).toBe(120); // via quiet node 2
    expect(res.safest.summary.by_class_m.busy_street).toBeUndefined();
    expect(res.shortest.summary.meters).toBe(100); // direct busy edge
    expect(res.safest.summary.detour_pct).toBe(20);
  });

  it("reports cautions when forced onto a busy street", () => {
    const r = toyRouter();
    // shortest payload rides Busy Ave and must carry a caution
    const res = r.route([-71.1, 42.38], [-71.099, 42.38], "kids");
    const caution = res.shortest.summary.cautions[0];
    expect(caution).toBeDefined();
    expect(caution?.name).toBe("Busy Ave");
    expect(caution?.cls).toBe("busy_street");
  });

  it("solo mode still avoids the busy street here (6x > detour ratio)", () => {
    const r = toyRouter();
    const res = r.route([-71.1, 42.38], [-71.0995, 42.3805], "solo");
    expect(res.safest.summary.meters).toBe(60);
  });

  it("rejects points far outside the network", () => {
    const r = toyRouter();
    expect(() => r.route([-70.0, 42.0], [-71.1, 42.38], "kids")).toThrow(/too far/);
  });

  it("computes pct_quiet and pct_protected", () => {
    const r = toyRouter();
    const res = r.route([-71.1, 42.38], [-71.099, 42.38], "kids");
    expect(res.safest.summary.pct_quiet).toBe(100);
    expect(res.safest.summary.pct_protected).toBe(0);
  });
});
