// Who owns a planner output while a computation waits, and how a what-if is
// kept from outliving the question it answers.
import { describe, expect, it } from "vitest";

import { Lane, withUpgraded } from "../src/planner.js";

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
