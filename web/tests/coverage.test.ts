// The area the app covers, and telling a map outside it that it is.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COVERAGE, HOME, outsideCoverage } from "../src/coverage.js";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "pipeline", "config.py");

describe("the area the app covers", () => {
  it("is the one the pipeline builds, so a new ring can't leave the app behind", () => {
    const config = readFileSync(CONFIG, "utf8");
    const edge = (name: string): number => {
      const m = new RegExp(`^BBOX_${name}[^=]*=\\s*(-?[\\d.]+)`, "m").exec(config);
      if (m?.[1] === undefined) throw new Error(`no BBOX_${name} in config.py`);
      return Number(m[1]);
    };
    const built = { west: edge("WEST"), south: edge("SOUTH"), east: edge("EAST"), north: edge("NORTH") };
    expect(COVERAGE).toEqual(built);
  });

  it("opens the map inside itself", () => {
    const [lon, lat] = HOME.center;
    expect(outsideCoverage({ west: lon, south: lat, east: lon, north: lat })).toBe(false);
  });
});

describe("a view outside it", () => {
  it("is outside when none of it overlaps", () => {
    // Mountain View, where Android's emulators put the phone
    expect(outsideCoverage({ west: -122.1, south: 37.38, east: -122.06, north: 37.41 })).toBe(true);
  });

  it("is inside if any of it overlaps, even from beyond the edge", () => {
    // straddling the western edge: half of it has streets to show
    expect(outsideCoverage({ west: -71.8, south: 42.2, east: -71.5, north: 42.3 })).toBe(false);
    // the whole region and more, zoomed out
    expect(outsideCoverage({ west: -75, south: 40, east: -68, north: 45 })).toBe(false);
  });
});
