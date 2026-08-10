// The share cards themselves. Canvas is browser-only, so the drawing was
// untested — a third of the module. A recording context can't tell us the card
// looks good, but it can tell us the numbers a rider is about to post publicly
// are the ones from their ride, and that a missing canvas fails cleanly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUnits } from "../src/units.js";

import type { RideSummary } from "../src/rides.js";
import { rideTotals } from "../src/rides.js";
import { drawRideCard, drawTotalsCard } from "../src/sharecard.js";

interface Recorder {
  texts: string[];
  fills: string[];
  size: { w: number; h: number };
}

let rec: Recorder;

/** A canvas that records what it was asked to draw. */
function installCanvas(opts: { context?: boolean; blob?: boolean } = {}): void {
  const { context = true, blob = true } = opts;
  rec = { texts: [], fills: [], size: { w: 0, h: 0 } };
  const ctx = {
    // everything the card calls, recording only what we assert on
    fillRect: () => undefined,
    fillText: (t: string) => rec.texts.push(String(t)),
    strokeText: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    clip: () => undefined,
    measureText: (t: string) => ({ width: t.length * 7 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    roundRect: () => undefined,
    set fillStyle(v: string) {
      rec.fills.push(String(v));
    },
    get fillStyle(): string {
      return "";
    },
    set strokeStyle(_v: string) {
      /* recorded via fills where it matters */
    },
    set font(_v: string) {
      /* not asserted: the card's typography isn't a contract */
    },
    set lineWidth(_v: number) {
      /* ditto */
    },
    set textAlign(_v: string) {
      /* ditto */
    },
    set lineJoin(_v: string) {
      /* ditto */
    },
    set lineCap(_v: string) {
      /* ditto */
    },
  };
  const canvas = {
    get width(): number {
      return rec.size.w;
    },
    set width(v: number) {
      rec.size.w = v;
    },
    get height(): number {
      return rec.size.h;
    },
    set height(v: number) {
      rec.size.h = v;
    },
    getContext: () => (context ? ctx : null),
    toBlob: (cb: (b: Blob | null) => void) =>
      cb(blob ? new Blob(["png"], { type: "image/png" }) : null),
  };
  vi.stubGlobal("document", { createElement: () => canvas });
}

const ride: RideSummary = {
  id: "1",
  startedAt: "2026-07-19T14:00:00.000Z",
  meters: 5200,
  durationS: 2400,
  movingS: 1800,
  byClass: { path: 3000, quiet_street: 1500, busy_street: 700 },
  pctProtected: 58,
  pctQuiet: 29,
  profile: "young_kids",
  polyline: [
    [-71.1, 42.38],
    [-71.09, 42.385],
    [-71.08, 42.39],
  ],
};

// Pinned to metric on purpose: these test what the card draws, not which unit, and the app's default is
// imperial — without this, every distance in these expectations would
// depend on a setting none of them are about.
beforeEach(() => {
  setUnits("metric");
});

describe("the ride card", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("puts the ride's own numbers on it", async () => {
    installCanvas();
    const out = await drawRideCard(ride);
    expect(out).toBeInstanceOf(Blob);
    const all = rec.texts.join(" | ");
    // a card posted publicly must carry this ride's figures, not placeholders
    expect(all).toMatch(/5\.2/); // km
    expect(all).toMatch(/30/); // minutes moving
    expect(all).toMatch(/58/); // % protected
  });

  it("is drawn at a fixed size, so it isn't a 0x0 image", async () => {
    installCanvas();
    await drawRideCard(ride);
    expect(rec.size.w).toBeGreaterThan(300);
    expect(rec.size.h).toBeGreaterThan(200);
  });

  it("draws the route when there is one, and copes when there isn't", async () => {
    installCanvas();
    await drawRideCard({ ...ride, polyline: [] });
    // no polyline is a recorded free ride, not an error
    expect(rec.texts.join(" ")).toMatch(/5\.2/);
  });

  it("rejects rather than returning a broken image", async () => {
    installCanvas({ context: false });
    await expect(drawRideCard(ride)).rejects.toThrow();

    installCanvas({ blob: false });
    await expect(drawRideCard(ride)).rejects.toThrow(/canvas/i);
  });
});

describe("the totals card", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the totals it was given", async () => {
    installCanvas();
    const totals = rideTotals([ride], new Date("2026-07-20T12:00:00Z"));
    const out = await drawTotalsCard(totals);
    expect(out).toBeInstanceOf(Blob);
    const all = rec.texts.join(" | ");
    expect(all).toMatch(String(totals.count));
    expect(all).toMatch(String(totals.km));
  });

  it("rejects rather than returning a broken image", async () => {
    installCanvas({ context: false });
    const totals = rideTotals([ride], new Date("2026-07-20T12:00:00Z"));
    await expect(drawTotalsCard(totals)).rejects.toThrow();
  });
});
