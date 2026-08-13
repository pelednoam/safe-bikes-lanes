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
  GEOCODE_MIN_GAP_MS,
  geocodeDelayMs,
  matchScore,
  metresBetween,
  normalise,
  rank,
  words,
  worthGeocoding,
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

  it("finds a single word inside a longer one, for a half-remembered name", () => {
    // "vard" is what is left when someone types the middle of Harvard. Only for a
    // single word: applying it to several would match almost anything.
    expect(matchScore("vard", "Harvard Square")).toBeGreaterThan(0);
    expect(matchScore("vard", "Harvard Square")).toBeLessThan(
      matchScore("harvard", "Harvard Square"),
    );
    // two words get no such licence
    expect(matchScore("vard uare", "Harvard Square")).toBe(0);
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
    // Both of these match, at different tiers, so the ranking has to choose — the
    // first version used a candidate that scored 0 and was filtered out, which
    // made the test pass without ever comparing anything.
    const looseButUnderfoot = at("Elm Street Extension Playground", -71.1224, 42.3969, {
      source: "place", // the strongest source bonus, too
    });
    const exactButFar = at("Elm Street", -71.06, 42.35, { source: "street" });
    expect(matchScore("elm street", looseButUnderfoot.name)).toBeGreaterThan(0);
    const out = rank("elm street", [looseButUnderfoot, exactButFar], { origin: DAVIS });
    expect(out[0]?.name, "a loose match at the door outranked an exact match").toBe("Elm Street");
  });

  it("keeps every bonus smaller than the gap between tiers", () => {
    // The invariant stated above, checked as arithmetic rather than trusted: the
    // largest possible bonus (nearest possible place, best source) must not lift a
    // candidate from one tier into the one above.
    const here: [number, number] = [-71.1223, 42.3968];
    const best = rank("elm", [at("Elm", here[0], here[1], { source: "place" })], {
      origin: here,
    });
    expect(best).toHaveLength(1);
    // exact match at zero distance from the best source, versus the tier below at
    // any distance: the tiers are 100 apart and the bonuses total at most 16
    const tierBelow = matchScore("elm", "Elm Street");
    const tierAbove = matchScore("elm", "Elm");
    expect(tierAbove - tierBelow).toBeGreaterThan(16);
  });

  it("finds an address by its full text, not just the geocoder's short label", () => {
    // Nominatim answers "123 Broadway" with name "123" and the address in
    // display_name. Scoring the short name alone dropped every house-number query,
    // which is the one thing the geocoder is kept for.
    const house: Candidate = {
      name: "123",
      lon: -71.1,
      lat: 42.39,
      source: "geocoder",
      context: "Broadway, Somerville",
      match: "123 Broadway, Somerville, Middlesex County",
    };
    expect(rank("123 broadway", [house], {})).toHaveLength(1);
    expect(rank("broadway 123", [house], {})).toHaveLength(1);
    // and it is still the short label that gets shown
    expect(rank("123 broadway", [house], {})[0]?.name).toBe("123");
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
    expect(describe(row, mi)).toBe("school · 1.0 mi as the crow flies");
  });

  it("tells two Elm Streets apart by town when it knows one", () => {
    const row = { ...at("Elm Street", -71.1, 42.38, { source: "street", context: "Somerville" }) };
    expect(describe(row, mi)).toBe("Somerville");
  });

  it("says nothing rather than an empty separator when it knows nothing", () => {
    expect(describe(at("Somewhere", -71.1, 42.38, { kind: "", context: "" }), mi)).toBe("");
  });
});

suite("what the abbreviation table must not break", () => {
  it("still answers a single letter that happens to be a direction", () => {
    // "n", "s", "e" and "w" expand to compass words. Applied to a one-letter query
    // that made four letters of the alphabet stop answering at all.
    expect(matchScore("s", "Somerville Avenue")).toBeGreaterThan(0);
    expect(matchScore("n", "Newbury Street")).toBeGreaterThan(0);
    expect(matchScore("e", "Elm Street")).toBeGreaterThan(0);
    // and still reads a real direction when there is more to go on
    expect(matchScore("n beacon", "North Beacon Street")).toBeGreaterThan(0);
  });

  it("finds a saint by the abbreviation people write", () => {
    // "st" means "street" far more often, so it expands that way — but it must not
    // stop "St Peter" finding "Saint Peter". 24 shipped POIs are saints.
    expect(matchScore("st peter", "Saint Peter School")).toBeGreaterThan(0);
    expect(matchScore("saint peter", "St Peter School")).toBeGreaterThan(0);
    // without losing the street reading
    expect(matchScore("elm st", "Elm Street")).toBeGreaterThan(0);
  });
});

suite("telling two places apart", () => {
  it("rejoins the segments of one street but keeps two streets", () => {
    // A street arrives as many segments; two streets sharing a name do not.
    const pieces = [
      at("Elm Street", -71.1200, 42.3900, { source: "street" }),
      at("Elm Street", -71.1220, 42.3905, { source: "street" }), // ~200 m along
      at("Elm Street", -71.0600, 42.3500, { source: "street" }), // another town
    ];
    expect(rank("elm street", pieces, {})).toHaveLength(2);
  });

  it("keeps two shops of the same name two streets apart", () => {
    // 200 m apart is two destinations for a POI, where it would be one street.
    const a = at("Dunkin", -71.12, 42.39);
    const b = at("Dunkin", -71.1176, 42.39); // ~200 m
    expect(rank("dunkin", [a, b], {})).toHaveLength(2);
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

suite("when the geocoder gets asked", () => {
  // Nominatim asks for at most one request per second and says it is not for
  // autocomplete. Tested here as arithmetic: through the browser, the request
  // offsets vary by more than a second between runs on the same machine, so a
  // wall-clock assertion is both flaky and unable to tell whether the policy is
  // there at all — the first version of that E2E test passed with it deleted.

  it("does not ask for a fragment somebody is still typing", () => {
    expect(worthGeocoding("p", 0)).toBe(false);
    expect(worthGeocoding("pl", 0)).toBe(false);
    expect(worthGeocoding("pla", 0)).toBe(false);
    expect(worthGeocoding("  pl  ", 0)).toBe(false); // whitespace is not typing
  });

  it("does not ask when the device already answered", () => {
    // The whole point of the local index: 2,500 places and every street on screen
    // are already here, and asking a donated service for them is asking for nothing.
    expect(worthGeocoding("playground", 5)).toBe(false);
    expect(worthGeocoding("playground", 3)).toBe(false);
    expect(worthGeocoding("playground", 2)).toBe(true); // came up short: worth asking
    expect(worthGeocoding("playground", 0)).toBe(true);
  });

  it("always asks about a house number, which only it knows", () => {
    expect(worthGeocoding("123 broadway", 8)).toBe(true);
    expect(worthGeocoding("10 elm st", 5)).toBe(true);
    // …but still not a fragment
    expect(worthGeocoding("1 b", 0)).toBe(false);
  });

  it("waits out the floor rather than dropping the query", () => {
    // 0 means now; anything else is how long to wait. Returning "no" instead would
    // mean a fast typist gets no answer at all rather than a late one.
    expect(geocodeDelayMs(10_000, 0)).toBe(0);
    expect(geocodeDelayMs(10_000, 10_000 - GEOCODE_MIN_GAP_MS)).toBe(0);
    expect(geocodeDelayMs(10_000, 9_600)).toBe(GEOCODE_MIN_GAP_MS - 400);
    expect(geocodeDelayMs(10_000, 10_000)).toBe(GEOCODE_MIN_GAP_MS);
    // A clock that moved backwards must not stall the geocoder: the device wakes
    // from sleep, or NTP corrects it, and the unclamped form asked for an
    // eleven-second wait — after which the same thing would happen again.
    expect(geocodeDelayMs(10_000, 20_000)).toBe(GEOCODE_MIN_GAP_MS);
    expect(geocodeDelayMs(0, 1_000_000)).toBe(GEOCODE_MIN_GAP_MS);
  });

  it("keeps a second's clearance, which is what the policy asks for", () => {
    expect(GEOCODE_MIN_GAP_MS).toBeGreaterThan(1_000);
  });
});
