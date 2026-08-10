// The last step before a number is shown or spoken. Everything inside the app
// stays in metres; this decides what the rider reads.
import { beforeEach, describe, expect, it } from "vitest";

import {
  distVoice,
  fmtClimb,
  fmtDist,
  fmtDistTight,
  fmtSpeed,
  fromMeters,
  getUnits,
  navRound,
  setUnits,
  toMeters,
  unitName,
} from "../src/units.js";

describe("imperial, which is the default here", () => {
  beforeEach(() => {
    setUnits("imperial");
  });

  it("reads short distances in feet and long ones in miles", () => {
    expect(fmtDist(30)).toBe("98 ft");
    expect(fmtDist(150)).toBe("492 ft");
    // a tenth of a mile is where a decimal starts carrying information
    expect(fmtDist(1609)).toBe("1.0 mi");
    expect(fmtDist(8047)).toBe("5.0 mi");
    expect(fmtDistTight(1609.344)).toBe("1 mi");
  });

  it("rounds guidance to a figure worth calling out", () => {
    // "in 87 metres" is noise; feet round to 50s and 100s
    const ft = (m: number): number => Math.round(navRound(m) * 3.28084);
    expect(ft(60)).toBe(200);
    expect(ft(120)).toBe(400);
    expect(navRound(10)).toBe(0); // "now"
  });

  it("speaks distances the way a person would say them", () => {
    expect(distVoice(10)).toBe("now");
    expect(distVoice(60)).toBe("200 feet");
    expect(distVoice(1609.344)).toBe("1 mile");
    expect(distVoice(3218.7)).toMatch(/^2 miles$/);
    // never "1 miles"
    expect(distVoice(1609.344)).not.toContain("1 miles");
  });

  it("gives speed in mph", () => {
    expect(fmtSpeed(4.4704)).toBe("10.0 mph");
  });

  it("reads a number the rider typed as miles", () => {
    expect(toMeters(3)).toBeCloseTo(4828, 0);
  });
});

describe("metric, for riders who think that way", () => {
  beforeEach(() => {
    setUnits("metric");
  });

  it("keeps the behaviour the app had before", () => {
    expect(fmtDist(800)).toBe("800 m");
    expect(fmtDist(3400)).toBe("3.4 km");
    expect(fmtDistTight(1000)).toBe("1 km");
    expect(distVoice(200)).toBe("200 meters");
    expect(distVoice(1000)).toBe("1 kilometer");
    expect(fmtSpeed(4.1667)).toBe("15.0 km/h");
    expect(toMeters(5)).toBe(5000);
  });
});

describe("the preference itself", () => {
  it("remembers the choice, and defaults to miles for this audience", () => {
    // no localStorage in the node test environment — units.ts copes with that
    // by falling back, which is the private-browsing path; stub one to check
    // the choice is actually written down
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
      configurable: true,
    });
    setUnits("metric");
    expect(getUnits()).toBe("metric");
    expect(store.get("units")).toBe("metric");
    setUnits("imperial");
    expect(getUnits()).toBe("imperial");
    expect(store.get("units")).toBe("imperial");
  });

  it("converts back, so a typed distance survives a change of units", () => {
    // the number in the round-trip box means a distance, not a digit: 4 mi
    // should become 6.4 km, not 4 km
    setUnits("imperial");
    const meters = toMeters(4);
    setUnits("metric");
    expect(fromMeters(meters)).toBeCloseTo(6.437, 2);
    setUnits("imperial");
    expect(fromMeters(meters)).toBeCloseTo(4, 6);
  });

  it("names the unit for a field label", () => {
    setUnits("imperial");
    expect(unitName()).toBe("miles");
    setUnits("metric");
    expect(unitName()).toBe("km");
  });

  it("gives a climb in feet, never in miles", () => {
    // nobody describes a hill in miles, and "0.04 mi of climbing" is a sentence
    // no one has wanted
    setUnits("imperial");
    expect(fmtClimb(89)).toBe("292 ft");
    expect(fmtClimb(0)).toBe("0 ft");
    setUnits("metric");
    expect(fmtClimb(89)).toBe("89 m");
  });

  it("survives storage being unavailable", () => {
    // private browsing: the choice just isn't remembered
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });
    expect(() => setUnits("metric")).not.toThrow();
    expect(getUnits()).toBe("metric"); // still honoured in memory
    // @ts-expect-error putting the environment back as it was
    delete globalThis.localStorage;
  });
});
