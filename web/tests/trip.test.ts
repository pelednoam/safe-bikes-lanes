// The trip on screen, and why a plan that lost the race can't write to it.
import { describe, expect, it } from "vitest";

import { Lane } from "../src/planner.js";
import { Trip } from "../src/trip.js";
import type { RouteOption } from "../src/types.js";

const opt = (id: RouteOption["id"]): RouteOption => ({ id }) as unknown as RouteOption;

describe("a plan's answer", () => {
  it("goes on screen while it is the plan being waited for", () => {
    const trip = new Trip();
    const lane = new Lane();
    expect(trip.publish(lane.begin(), [opt("safest"), opt("direct")])).toBe(true);
    expect(trip.options.map((o) => o.id)).toEqual(["safest", "direct"]);
  });

  it("is refused once a newer plan has begun, and writes nothing", () => {
    // the far destination's tiles arrive after the near one was asked for
    const trip = new Trip();
    const lane = new Lane();
    const far = lane.begin();
    const near = lane.begin();
    expect(trip.publish(near, [opt("safest")])).toBe(true);
    expect(trip.publish(far, [opt("direct"), opt("safest")])).toBe(false);
    expect(trip.options.map((o) => o.id)).toEqual(["safest"]);
  });

  it("is refused after the question was withdrawn (Reset)", () => {
    const trip = new Trip();
    const lane = new Lane();
    const t = lane.begin();
    lane.cancel();
    expect(trip.publish(t, [opt("safest")])).toBe(false);
    expect(trip.options).toEqual([]);
  });

  it("drops a selection that isn't one of the new options", () => {
    const trip = new Trip();
    const lane = new Lane();
    trip.publish(lane.begin(), [opt("safest"), opt("direct")]);
    trip.select("direct");
    trip.publish(lane.begin(), [opt("safest")]);
    expect(trip.selectedId).toBeNull();
    expect(trip.selected).toBeUndefined();
  });
});

describe("choosing an option", () => {
  it("chooses one that is there, and not one that isn't", () => {
    const trip = new Trip();
    trip.publish(new Lane().begin(), [opt("safest"), opt("direct")]);
    expect(trip.select("direct")).toBe(true);
    expect(trip.selected?.id).toBe("direct");
    // a card from before a re-plan: it must not leave nothing selected
    expect(trip.select("loop")).toBe(false);
    expect(trip.selectedId).toBe("direct");
  });
});

describe("undo", () => {
  it("puts back exactly what was on screen", () => {
    const trip = new Trip();
    const lane = new Lane();
    trip.publish(lane.begin(), [opt("safest"), opt("direct")]);
    trip.select("direct");
    const real = trip.snapshot();
    trip.publish(lane.begin(), [opt("safest")]); // the what-if
    trip.restore(real);
    expect(trip.options.map((o) => o.id)).toEqual(["safest", "direct"]);
    expect(trip.selectedId).toBe("direct");
  });

  it("isn't changed later by what it was taken from", () => {
    const trip = new Trip();
    trip.publish(new Lane().begin(), [opt("safest")]);
    const snap = trip.snapshot();
    trip.clear();
    expect(snap.options.map((o) => o.id)).toEqual(["safest"]);
  });
});
