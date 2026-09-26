// Who owns a planner output while a computation waits, how a what-if is kept
// from outliving the question it answers, and how every routing call gets
// every preference.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Lane, type OptionsRouter, planOptions, withUpgraded } from "../src/planner.js";
import type { RouteOption } from "../src/types.js";

describe("Lane", () => {
  it("keeps only the newest piece of work current", () => {
    const lane = new Lane();
    const first = lane.begin();
    expect(first.stale()).toBe(false);
    const second = lane.begin();
    expect(first.stale()).toBe(true);
    expect(second.stale()).toBe(false);
  });

  it("cancel withdraws the question from everyone waiting on it", () => {
    const lane = new Lane();
    const waiting = lane.begin();
    lane.cancel();
    expect(waiting.stale()).toBe(true);
    // and work started afterwards is current again
    expect(lane.begin().stale()).toBe(false);
  });

  it("lanes are independent: a reach map does not cancel a route", () => {
    const routes = new Lane();
    const reach = new Lane();
    const route = routes.begin();
    reach.begin();
    reach.cancel();
    expect(route.stale()).toBe(false);
  });

  it("an older answer that finishes last is recognised as stale", async () => {
    // the shape of the bug: a slow request started first, a fast one second
    const lane = new Lane();
    const written: string[] = [];
    const work = async (name: string, ms: number): Promise<void> => {
      const t = lane.begin();
      await new Promise((r) => setTimeout(r, ms));
      if (!t.stale()) written.push(name);
    };
    await Promise.all([work("far", 30), work("near", 1)]);
    expect(written).toEqual(["near"]);
  });
});

describe("withUpgraded", () => {
  class FakeRouter {
    applied: [number, number][] = [];
    history: number[] = [];
    setUpgradedPoints(points: [number, number][]): number {
      this.applied = points;
      this.history.push(points.length);
      return points.length * 2;
    }
  }

  it("answers with the upgrade applied and leaves the router clean", () => {
    const r = new FakeRouter();
    const pts: [number, number][] = [
      [-71.1, 42.38],
      [-71.09, 42.38],
    ];
    const out = withUpgraded(r, pts, (covered) => {
      expect(r.applied).toBe(pts); // the question is asked of the built street
      return covered + 1;
    });
    expect(out).toEqual({ covered: 4, result: 5 });
    expect(r.applied).toEqual([]);
  });

  it("clears the upgrade even when the question throws", () => {
    const r = new FakeRouter();
    expect(() =>
      withUpgraded(r, [[-71.1, 42.38]], () => {
        throw new Error("no path found");
      }),
    ).toThrow("no path found");
    expect(r.applied).toEqual([]);
    expect(r.history).toEqual([1, 0]);
  });
});

describe("planOptions", () => {
  it("hands the router every preference, the walking limit included", () => {
    const calls: unknown[][] = [];
    const router: OptionsRouter = {
      routeOptions: (...args): RouteOption[] => {
        calls.push(args);
        return [];
      },
    };
    const bias = new Map([[3, 8]]);
    planOptions(
      router,
      [-71.1, 42.38],
      [-71.09, 42.37],
      { profileId: "older_kids", preferFlat: true, avoid: new Set(["busy_street"]), walkMaxM: 500 },
      bias,
    );
    expect(calls).toEqual([
      [[-71.1, 42.38], [-71.09, 42.37], "older_kids", true, bias, new Set(["busy_street"]), 500],
    ]);
  });

  it("is the only way app.ts asks for route options", () => {
    // The reroute, the detour and the resume each spelled the positional call
    // out for themselves, and all three left the walking limit off. Held here
    // so the next call written by hand cannot drop a preference again.
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app.ts"),
      "utf8",
    );
    const direct = app
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\.routeOptions\(/.test(line) && !line.startsWith("//"));
    expect(direct.map(({ n, line }) => `app.ts:${n} ${line}`)).toEqual([]);
  });
});
