// What the destination search matches, and in what order.
//
// The order is the feature. A list that contains the right place fourth is a list
// someone scrolls past, and a destination chosen wrongly is a ride to the wrong
// side of an arterial with a child — so these tests are mostly about precedence,
// not about whether a match exists at all.
import { describe as suite, expect, it } from "vitest";

import {
  type Candidate,
  describe,
  matchScore,
  metresBetween,
  normalise,
  rank,
  words,
} from "../src/search.js";

const DAVIS: [number, number] = [-71.1223, 42.3968];

function at(name: string, lon: number, lat: number, extra: Partial<Candidate> = {}): Candidate {
  return { name, lon, lat, source: "poi", ...extra };
}

suite("normalising what people type", () => {
  it("expands the abbreviations nobody spells out", () => {
    expect(normalise("Mass Ave")).toBe("massachusetts avenue");
    expect(normalise("Elm St.")).toBe("elm street");
    expect(normalise("N Beacon Rd")).toBe("north beacon road");
    expect(normalise("Highland Ave")).toBe("highland avenue");
  });

  it("folds accents and punctuation, which nobody types either", () => {
    expect(normalise("Poznań Café")).toBe("poznan cafe");
    expect(normalise("St. Peter's")).toBe("street peters");
  });

  it("drops filler so a missing 'the' cannot lose a match", () => {
    expect(words("the park at the end")).toEqual(["park", "end"]);
  });

  it("is the same function for both sides of a comparison", () => {
    // the point of normalising: "Mass. Ave" and "Massachusetts Avenue" meet in
    // the middle rather than one being rewritten into the other
    expect(normalise("Mass. Ave")).toBe(normalise("Massachusetts Avenue"));
  });
});

suite("what counts as a match", () => {
  it("ranks an exact name above a prefix above scattered words", () => {
    const exact = matchScore("Elm Street", "Elm Street");
    const prefix = matchScore("Elm", "Elm Street");
    const ordered = matchScore("kennedy elem", "John F Kennedy Elementary School");
    const anyOrder = matchScore("school kennedy", "John F Kennedy Elementary School");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(ordered);
    expect(ordered).toBeGreaterThan(anyOrder);
    expect(anyOrder).toBeGreaterThan(0);
  });

  it("counts an abbreviation as the word it stands for, not as a near miss", () => {
    // "mass ave" IS "Massachusetts Avenue" once both sides are normalised, so it
    // scores as an exact match and outranks every partial. That is the whole
    // point of expanding both sides rather than fuzzy-matching one.
    expect(matchScore("mass ave", "Massachusetts Avenue")).toBe(
      matchScore("Massachusetts Avenue", "Massachusetts Avenue"),
    );
    expect(matchScore("mass ave", "Massachusetts Avenue")).toBeGreaterThan(
      matchScore("mass", "Massachusetts Avenue"),
    );
  });

  it("matches the way people actually type a street", () => {
    expect(matchScore("mass ave", "Massachusetts Avenue")).toBeGreaterThan(0);
    expect(matchScore("mass av", "Massachusetts Avenue")).toBeGreaterThan(0);
    expect(matchScore("massachusetts", "Mass Ave")).toBeGreaterThan(0);
    expect(matchScore("beacon", "Beacon Street")).toBeGreaterThan(0);
    expect(matchScore("somerville ave", "Somerville Avenue")).toBeGreaterThan(0);
  });

  it("finds a school by the words in its name, in any order", () => {
    expect(matchScore("kennedy school", "John F Kennedy Elementary School")).toBeGreaterThan(0);
    expect(matchScore("school kennedy", "John F Kennedy Elementary School")).toBeGreaterThan(0);
  });

  it("refuses a name that is not an answer, however desperate the list", () => {
    // A fuzzy scorer puts something at the top no matter what, and here that
    // would be a place someone rides a child to.
    expect(matchScore("elm", "Broadway")).toBe(0);
    expect(matchScore("dentist", "Davis Square")).toBe(0);
    expect(matchScore("xyzzy", "Elm Street")).toBe(0);
  });

  it("says nothing about an empty query", () => {
    expect(matchScore("", "Elm Street")).toBe(0);
    expect(matchScore("  ", "Elm Street")).toBe(0);
    expect(matchScore("elm", "")).toBe(0);
  });
});

suite("ordering the list", () => {
  it("puts the nearer of two identically named streets first", () => {
    const near = at("Elm Street", -71.1215, 42.3961, { source: "street" });
    const far = at("Elm Street", -71.06, 42.35, { source: "street" });
    const out = rank("elm", [far, near], { origin: DAVIS });
    expect(out).toHaveLength(2);
    expect(out[0]?.lon).toBe(near.lon);
    expect(out[0]?.distanceM).toBeLessThan(out[1]?.distanceM ?? 0);
  });

  it("never lets distance beat a better name", () => {
    // A playground at your feet is not the answer to "Elm Street".
    const wrongButClose = at("Broadway Playground", -71.1224, 42.3969);
    const rightButFar = at("Elm Street", -71.06, 42.35, { source: "street" });
    const out = rank("elm street", [wrongButClose, rightButFar], { origin: DAVIS });
    expect(out.map((r) => r.name)).toEqual(["Elm Street"]);
  });

  it("prefers a place the rider saved over a street of the same name", () => {
    const saved = at("Elm Street", -71.06, 42.35, { source: "place" });
    const street = at("Elm Street", -71.1215, 42.3961, { source: "street" });
    const out = rank("elm street", [street, saved], {});
    expect(out[0]?.source).toBe("place");
  });

  it("prefers somewhere they have already been over one they haven't", () => {
    const been = at("Elm Street Park", -71.06, 42.35, { source: "recent" });
    const other = at("Elm Street Park", -71.05, 42.34, { source: "poi" });
    const out = rank("elm street park", [other, been], {});
    expect(out[0]?.source).toBe("recent");
  });

  it("shows one row per place, however many sources found it", () => {
    // the same school from the local index and from the geocoder
    const local = at("Kennedy School", -71.1, 42.38, { source: "poi" });
    const remote = at("Kennedy School", -71.1001, 42.3801, { source: "geocoder" });
    const out = rank("kennedy", [local, remote], {});
    expect(out).toHaveLength(1);
  });

  it("keeps two genuinely different places that share a name", () => {
    const one = at("Elm Street", -71.12, 42.39, { source: "street" });
    const other = at("Elm Street", -71.05, 42.34, { source: "street" });
    expect(rank("elm street", [one, other], {})).toHaveLength(2);
  });

  it("returns nothing rather than something wrong", () => {
    expect(rank("xyzzy", [at("Elm Street", -71.1, 42.39)], {})).toEqual([]);
    expect(rank("", [at("Elm Street", -71.1, 42.39)], {})).toEqual([]);
  });

  it("keeps the list short enough to read", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      at(`Elm Street ${String(i)}`, -71.1 - i / 1000, 42.39),
    );
    expect(rank("elm", many, { origin: DAVIS }).length).toBeLessThanOrEqual(8);
    expect(rank("elm", many, { origin: DAVIS, limit: 3 })).toHaveLength(3);
  });

  it("works with no origin at all, which is how the app opens", () => {
    const out = rank("elm", [at("Elm Street", -71.1, 42.39, { source: "street" })], {});
    expect(out).toHaveLength(1);
    expect(out[0]?.distanceM).toBeUndefined();
  });
});

suite("the second line", () => {
  const mi = (m: number): string => `${(m / 1609.344).toFixed(1)} mi`;

  it("says what the place is and how far, in that order", () => {
    const row = { ...at("Kennedy School", -71.1, 42.38, { kind: "school" }), distanceM: 1609.344 };
    expect(describe(row, mi)).toBe("school · 1.0 mi away");
  });

  it("tells two Elm Streets apart by town when it knows one", () => {
    const row = { ...at("Elm Street", -71.1, 42.38, { source: "street", context: "Somerville" }) };
    expect(describe(row, mi)).toBe("Somerville");
  });

  it("says nothing rather than an empty separator when it knows nothing", () => {
    expect(describe(at("Somewhere", -71.1, 42.38, { kind: "", context: "" }), mi)).toBe("");
  });
});

suite("distance", () => {
  it("measures city distances closely enough to order a list", () => {
    // Davis Square to Porter Square is about 1.2 km
    const porter: [number, number] = [-71.1191, 42.3884];
    const d = metresBetween(DAVIS, porter);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1500);
    expect(metresBetween(DAVIS, DAVIS)).toBe(0);
  });
});
