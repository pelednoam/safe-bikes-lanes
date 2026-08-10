// Tests for share text builders (canvas rendering is browser-only).
import { beforeEach, describe, expect, it } from "vitest";
import { setUnits } from "../src/units.js";

import type { RideSummary } from "../src/rides.js";
import { rideTotals } from "../src/rides.js";
import { rideShareText, totalsShareText } from "../src/sharecard.js";

const ride: RideSummary = {
  id: "1",
  startedAt: "2026-07-19T14:00:00.000Z",
  meters: 5200,
  durationS: 2400,
  movingS: 1800,
  byClass: {},
  pctProtected: 78,
  pctQuiet: 15,
  profile: "young_kids",
  polyline: [],
};

// Pinned to metric on purpose: these test what the card says, not which unit, and the app's default is
// imperial — without this, every distance in these expectations would
// depend on a setting none of them are about.
beforeEach(() => {
  setUnits("metric");
});

describe("share text", () => {
  it("summarizes a ride with distance, pace, and safety", () => {
    const text = rideShareText(ride);
    expect(text).toContain("5.2 km");
    expect(text).toContain("30 min");
    expect(text).toContain("10.4 km/h");
    expect(text).toContain("78% on protected");
    expect(text).toContain("https://pelednoam.github.io/safe-bikes-lanes/");
  });

  it("summarizes totals", () => {
    const totals = rideTotals([ride, { ...ride, id: "2", meters: 3000 }], new Date("2026-07-20"));
    const text = totalsShareText(totals);
    expect(text).toContain("2 rides");
    expect(text).toContain("8.2 km total");
    expect(text).toContain("longest 5.2 km");
  });
});
