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

  it("is how every route the app asks for is planned, with every preference", () => {
    // The reroute, the detour and the resume each spelled the positional call
    // out for themselves, and all three left the walking limit off. Routing now
    // runs in a worker (src/routing.ts), so this holds both halves: the worker
    // plans only through planOptions, and every question the page puts to it
    // carries the rider's whole set of preferences.
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const code = (name: string): string[] =>
      readFileSync(join(src, name), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !line.startsWith("//") && !line.startsWith("*"));

    for (const name of ["app.ts", "routing.ts"]) {
      const direct = code(name).filter((line) => /\.routeOptions\(/.test(line));
      expect(direct, `${name} plans around planOptions`).toEqual([]);
    }
    const worker = code("routing.ts").join("\n");
    expect(worker.match(/planOptions\(/g)?.length ?? 0).toBeGreaterThan(0);

    // Every plan the page asks for: the arguments after the two points are the
    // rider's preferences, routePrefs(), or (search grades, planned against a
    // snapshot of them) an object that names every field of RoutePrefs.
    const app = code("app.ts").join("\n");
    const calls = [...app.matchAll(/routing\.plan(?:With)?\(/g)].map((m) => {
      // the call's own arguments, up to its matching parenthesis
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const from = i;
      for (; i < app.length && depth > 0; i++) {
        if (app[i] === "(") depth++;
        else if (app[i] === ")") depth--;
      }
      return app.slice(from, i - 1);
    });
    expect(calls.length, "app.ts no longer plans through the worker").toBeGreaterThan(4);
    for (const call of calls) {
      const complete =
        call.includes("routePrefs()") ||
        ["profileId", "preferFlat", "avoid", "walkMaxM"].every((field) => call.includes(field));
      expect(complete, `routing.plan(${call.slice(0, 80)}…) drops a preference`).toBe(true);
    }
  });
});
