// The report format, the scrubbing, and what makes two reports one problem.
import { describe, expect, it } from "vitest";

import {
  check,
  fingerprint,
  issueBody,
  issueTitle,
  BUNDLE_BASES,
  scrub,
  scrubbed,
  signature,
} from "../src/report.js";
import bundlesJson from "../src/bundles.json";
import { sample } from "./sample.js";

describe("the format", () => {
  it("takes a report", () => {
    expect(check(sample())).toEqual({ ok: true, report: sample() });
  });

  it("takes the builds the app really has: a tag, a branch build with its commit, the site, a dev build", () => {
    for (const build of ["app-v55 d649c79", "app-v52-dev.1a2b3c4 1a2b3c4", "web 04d064d", "dev unknown", "web"]) {
      expect(check(sample({ build })).ok, build).toBe(true);
    }
  });

  it("refuses a field it doesn't know, rather than passing it on", () => {
    const r = check({ ...sample(), location: [-71.1, 42.38] });
    expect(r).toEqual({ ok: false, why: "unknown fields: location" });
  });

  it.each([
    ["version", { v: 2 }],
    ["kind", { kind: "panic" }],
    ["platform", { platform: "ios" }],
    ["message", { message: "" }],
    ["message", { message: "x".repeat(501) }],
    ["frames", { frames: "at x" }],
    ["frames", { frames: Array.from({ length: 16 }, () => "f (a.js:1:1)") }],
    ["frames", { frames: [42] }],
    ["build", { build: "<script>" }],
    ["build", { build: "www.example.com" }],
    ["build", { build: "app-v52-dev.1a2b3c4.evil" }],
    ["build", { build: "app-v55 d649c79 extra" }],
    ["page", { page: "../etc" }],
    ["browser", { browser: "Chrome <140>" }],
    ["browser", { browser: "www.example.com" }],
    ["browser", { browser: "Chrome 140.0.0.0" }],
  ])("refuses a bad %s", (why, over) => {
    expect(check({ ...sample(), ...over })).toEqual({ ok: false, why });
  });

  it.each([null, [], "report", 1])("refuses %j", (body) => {
    expect(check(body).ok).toBe(false);
  });
});

describe("the scrubbing", () => {
  it("takes out coordinates at any precision, and written however", () => {
    expect(scrub("no route from -71.1223,42.3967 to [-71.0867, 42.3626]")).toBe("no route from ‹n›,‹n› to [‹n›, ‹n›]");
    // a kilometre and ten kilometres: still where someone is
    expect(scrub("at 42.38 -71.1")).toBe("at ‹n› ‹n›");
    expect(scrub("lat=42.3967;lon=-71.1223")).toBe("lat=‹n›;lon=‹n›");
    expect(scrub("center 42,-71")).toBe("center ‹n›");
  });

  it("takes out tile and grid addresses, which are places too", () => {
    expect(scrub("not a basemap tile: bikecache://14/4953/6060")).toBe("not a basemap tile: ‹url›");
    expect(scrub("failed 12_34.json then 5/6")).toBe("failed ‹n›.json then ‹n›");
    expect(scrub("tile 1234567 failed")).toBe("tile ‹n› failed");
  });

  it("keeps small whole numbers: counts, statuses and line numbers say what went wrong", () => {
    expect(scrub("tile 12 of 25 failed with 404")).toBe("tile 12 of 25 failed with 404");
  });

  it("cuts a URL to its file's name, which drops a permalink's ends and a searched address", () => {
    expect(
      scrub("Failed to fetch https://pelednoam.github.io/safe-bikes-lanes/#s=-71.12,42.39&e=-71.08,42.36"),
    ).toBe("Failed to fetch ‹url›");
    // in a message a position is a pair of numbers like any other; the frames
    // (below) are where positions are kept
    expect(scrub("at https://localhost/app-BrmPk3gH.js?v=3:1:200")).toBe("at app-BrmPk3gH.js:‹n›");
    expect(scrub("GET https://nominatim.openstreetmap.org/search?q=12+Elm+St+Somerville&format=json failed")).toBe(
      "GET ‹url›",
    );
  });

  it("takes the rest of a query that has spaces in it, which a URL stopped at the first space published", () => {
    const out = scrub("GET https://nominatim.openstreetmap.org/search?q=Elm Street Somerville&format=json failed");
    expect(out).toBe("GET ‹url›");
    expect(out).not.toContain("Somerville");
    expect(scrub('fetch("https://x.example/a?q=my home") rejected')).toBe('fetch("‹url›") rejected');
  });

  it("takes out an address written out in words", () => {
    expect(scrub("no route to 12 Elm Street, Somerville")).toBe("no route to ‹address›, Somerville");
    expect(scrub("geocode 1600 Massachusetts Ave failed")).toBe("geocode ‹address› failed");
    expect(scrub("saved place 221B Baker St")).toBe("saved place ‹address›");
  });

  it("takes out an email address", () => {
    expect(scrub("login failed for someone@example.com")).toBe("login failed for ‹email›");
  });

  it("drops control characters, and characters that change how a title reads without showing", () => {
    expect(scrub("a\u0000b\u001bc\nd")).toBe("abc\nd");
    // a right-to-left override, a zero-width space, and a word joiner
    expect(scrub("Fatal\u202e error\u200b!\u2060")).toBe("Fatal error!");
  });

  it("scrubs the frames as well as the message, and leaves a frame's position alone", () => {
    const r = scrubbed(
      sample({
        frames: [
          "onFix (app-AbCd1234.js:1:23456)",
          "geocode (https://nominatim.example/search?q=12 Elm Street:4:5)",
          "near 42.38123 (app-AbCd1234.js:9:9)",
        ],
      }),
    );
    expect(r.frames).toEqual([
      // a column past five digits is a position, not an id
      "onFix (app-AbCd1234.js:1:23456)",
      "geocode (‹url›)",
      "near ‹n› (app-AbCd1234.js:9:9)",
    ]);
  });

  it("scrubs a frame whole when its file isn't one of the app's bundles, 'position' and all", () => {
    // the last two numbers of "f (42:3967:711223)" are not a line and a column
    const r = scrubbed(sample({ frames: ["f (42:3967:711223)", "g (geo:423967:711223)", "h (home-dr5regw3.js:1:2)"] }));
    expect(r.frames).toEqual(["f (‹url›)", "g (‹url›)", "h (‹url›)"]);
  });

  it("takes out a control character first, so one inside a coordinate doesn't hide it", () => {
    expect(scrub("at 42\u0001.3967,-71\u001b.1223")).toBe("at ‹n›,‹n›");
    expect(scrub("https\u0000://x.example/search?q=Elm")).toBe("‹url›");
    expect(scrub("42\u200b.3967")).toBe("‹n›");
  });

  it("takes out the characters that render as nothing, whichever script they come from", () => {
    expect(scrub("a\u034fb\u3164c\ufe0fd\u{E0041}e")).toBe("abcde");
    // by class: these were missing from a hand-made list, and each splits a coordinate
    expect(scrub("42\ufff9.3967,-71\ufff9.1223")).toBe("‹n›,‹n›");
    expect(scrub("42\u180b.3967")).toBe("‹n›");
    expect(scrub("42\u{E0100}.3967")).toBe("‹n›");
  });

  it("takes out a coordinate whose decimal point is any of the separators phones and locales use", () => {
    for (const dot of ["\u2396", "\u00b7", "\u3002", "\uff61", "\u2027"]) {
      expect(scrub(`42${dot}3967 | -71${dot}1223`), dot).toBe("‹n› | ‹n›");
    }
  });

  it("takes out a coordinate a combining mark or a space is set into", () => {
    expect(scrub("42\u0301.3967")).toBe("‹n›");
    expect(scrub("42.\u20dd3967")).toBe("‹n›");
    expect(scrub("lat 42 .3967")).toBe("lat ‹n›");
  });

  it("takes out labelled numbers in escaped JSON, camelCase, upper case, and with a sign", () => {
    // JSON inside JSON writes a backslash before each quote
    expect(scrub('{\\"x\\":4953,\\"y\\":6060,\\"z\\":14}')).not.toMatch(/4953|6060/);
    expect(scrub("tileX=4953 tileY=6060")).toBe("tile‹n› tile‹n›");
    expect(scrub('{"centerLat":42}')).toBe('{"center‹n›}');
    expect(scrub("LAT=42 LON=-71")).toBe("‹n› ‹n›");
    expect(scrub('{"lat":+42,"lon":\u221271}')).toBe('{"‹n›,"‹n›}');
  });

  it("doesn't wreck an email address with digits either side of the @", () => {
    expect(scrub("login failed for wang123@163.com")).toBe("login failed for ‹email›");
    expect(scrub("rider1@2wheels.org")).toBe("‹email›");
  });

  it("takes out tile coordinates written with x between numbers, or as run-together axes", () => {
    expect(scrub("14x4953x6060")).toBe("‹n›");
    expect(scrub("14×4953×6060")).toBe("‹n›");
    expect(scrub("z14_x4953_y6060")).toBe("‹n›");
    expect(scrub("x4953y6060")).toBe("‹n›");
    expect(scrub("z14x4953y6060")).toBe("‹n›");
    expect(scrub("x 4953 y 6060")).toBe("‹n›");
    expect(scrub("z 14 x 4953 y 6060")).toBe("‹n›");
    // a pair joined by x is indistinguishable from a screen size, and stays: decided,
    // spaced or not
    expect(scrub("viewport 4953x6060")).toBe("viewport 4953x6060");
    expect(scrub("viewport 1920 x 1080")).toBe("viewport 1920 x 1080");
  });

  it("takes tile axes written after a word, or with a space, comma or slash between them", () => {
    for (const text of ["tileX4953Y6060", "tileZ14X4953Y6060", "tile x4953 y6060 z14", "(x4953, y6060)", "x4953/y6060", "tilex4953y6060"]) {
      expect(scrub(text), text).not.toMatch(/4953|6060/);
    }
  });

  it("takes axes joined by & or +, and leaves a letter that merely ends a word alone", () => {
    for (const text of ["x4953&y6060", "x4953+y6060", "x=4953&y=6060", "?z=14&x=4953&y=6060"]) {
      expect(scrub(text), text).not.toMatch(/4953|6060/);
    }
    // an x or y that is the end of a word is not an axis
    for (const text of ["index 3: y 4", "max 2; y 5", "prefix 1|y 2"]) {
      expect(scrub(text), text).toBe(text);
    }
    // while a word that is tile, or camelCase, is
    for (const text of ["tilex4953y6060", "tileX4953Y6060"]) expect(scrub(text), text).toBe("tile‹n›");
    // in any case, and after any word, when the digits are attached (no space to read it as text)
    for (const text of ["Tilex4953y6060", "TILEX4953Y6060", "TileX4953Y6060", "posx4953y6060", "POSX4953Y6060", "gridX4953_Y6060"]) {
      expect(scrub(text), text).not.toMatch(/4953|6060/);
    }
    // and still not ordinary words, one letter twice, or a gap in the middle
    for (const text of ["Matrix4x4", "INDEX 3: Y 4", "hex4a", "index3 y4"]) expect(scrub(text), text).toBe(text);
  });

  it("takes tiles with a zoom first and the axes either way round, or joined by any separator", () => {
    expect(scrub("z14y6060x4953")).toBe("‹n›");
    for (const text of ["z14.x4953.y6060", "x4953:y6060", "x4953;y6060", "y6060|x4953", "z14:y6060:x4953"]) {
      expect(scrub(text), text).not.toMatch(/4953|6060/);
    }
  });

  it("takes a tile written y first, and a lone y or z axis after a number", () => {
    for (const text of ["y 6060 x 4953", "y6060x4953", "y=6060 x=4953"]) {
      expect(scrub(text), text).not.toMatch(/4953|6060/);
    }
    expect(scrub("zoom 14 y 6060")).not.toMatch(/6060/);
    // while a screen size stays whatever number is in front of it
    expect(scrub("viewport 1920 x 1080")).toBe("viewport 1920 x 1080");
  });

  it("takes the whole of a tile with a fraction, not the fraction first", () => {
    for (const text of ["z14_x4953_y6060.5", "14x4953x6060.5", "x4953.5y6060.5"]) {
      expect(scrub(text), text).toBe("‹n›");
    }
  });

  it("takes degrees, minutes and seconds written with apostrophes and no degree sign", () => {
    // nothing of the position is left, the seconds included
    expect(scrub(`at 42'23'48"N 71'7'20"W`)).not.toMatch(/42|23|48|71|20/);
    expect(scrub("42*23'48 71*7'20")).not.toMatch(/42|23|48|71|20/);
    expect(scrub("42*23.5 71*7.2")).not.toMatch(/42|23|71/);
    // and the degree-sign form still goes whole
    expect(scrub(`42°23'48"N`)).toBe("‹n›");
  });

  it("takes the long number after an x that isn't a hex prefix", () => {
    expect(scrub("4250x4239677")).not.toMatch(/4239677/);
    expect(scrub("4251x4239677")).not.toMatch(/4239677/);
    expect(scrub("HRESULT_0x80070005")).toBe("HRESULT_0x80070005");
  });

  it("takes out camelCase labels written in capitals, and a hex code stays whatever it follows", () => {
    expect(scrub("centerLAT=42 centerLON=-71")).toBe("center‹n› center‹n›");
    for (const text of ["HRESULT_0x80070005", "error0x80070005", "code=0xDEAD12345"]) {
      expect(scrub(text), text).toBe(text);
    }
  });

  it("reads punctuation set between digits, with spaces around it, as a decimal point", () => {
    expect(scrub("42\u2e31 3967")).toBe("‹n›");
    // and strips what normalising makes: U+FF9E becomes a combining mark
    expect(scrub("42\uff9e.3967")).toBe("‹n›");
  });

  it("doesn't take the x and z in hex, sizes and architectures for coordinates: different failures stay apart", () => {
    for (const text of ["HRESULT 0x80070005 on x64", "1920x1080", "max=5", "app-X4bCdEfG.js", "app-Ab_x1CdE.js"]) {
      expect(scrub(text), text).toBe(text);
    }
    // "x86_64" is the cost of reading "86_64" as a pair of numbers: over-scrubbed, accepted
    expect(scrub("x86_64")).toBe("x‹n›");
  });

  it("takes out a coordinate set with any combining mark, spacing ones too", () => {
    expect(scrub("42\u093e.3967")).toBe("‹n›");
    expect(scrub("42\u0301.3967")).toBe("‹n›");
  });

  it("takes out compatibility forms: fullwidth digits and any punctuation between digits as a decimal point", () => {
    expect(scrub("４２．３９６７")).toBe("‹n›");
    for (const dot of ["\u2219", "\u22c5", "\u0387", "\u2e31"]) {
      expect(scrub(`42${dot}3967,-71${dot}1223`), dot).toBe("‹n›,‹n›");
    }
  });

  it("takes out latitude and longitude written as JSON keys, snake_case, or with no separator", () => {
    expect(scrub('{"lat":42,"lon":-71}')).toBe('{"‹n›,"‹n›}');
    expect(scrub("tile_x=4953 user_lat=42")).toBe("tile_‹n› user_‹n›");
    expect(scrub("lat 42")).toBe("‹n›");
    // and not the ends of longer words
    expect(scrub("max 5 latency 200")).toBe("max 5 latency 200");
  });

  it("takes out coordinates written with other separators between ASCII digits", () => {
    expect(scrub("42．3967,-71．1223")).toBe("‹n›,‹n›");
    expect(scrub("42.3967，-71.1223")).toBe("‹n›,‹n›");
  });

  it("takes out latitude and longitude by name", () => {
    expect(scrub("lat=42 lon=-71")).toBe("‹n› ‹n›");
    expect(scrub("latitude: 42.38, longitude: -71.1")).toBe("latitude: ‹n›, longitude: ‹n›");
    expect(scrub("lng=-71")).toBe("‹n›");
  });

  it("takes out tile and coordinate forms with other separators, labels, degrees, and other digits", () => {
    expect(scrub("14-4953-6060.pbf")).toBe("‹n›.pbf");
    expect(scrub("14:4953:6060")).toBe("‹n›");
    expect(scrub("tile z=14 x=4953 y=6060")).toBe("tile ‹n› ‹n› ‹n›");
    expect(scrub("tile 4953 6060")).toBe("tile ‹n›");
    expect(scrub("POINT(-71 42)")).toBe("POINT(‹n›)");
    expect(scrub(`at 42°23'48"N 71°7'20"W`)).toBe("at ‹n› ‹n›");
    // Arabic-Indic digits and decimal separator, as a phone set to Arabic writes
    expect(scrub("٤٢٫٣٩٦٧")).toBe("‹n›");
  });

  it("keeps a bundle's name and nothing else from a URL, so a feed's file name can't carry an address", () => {
    expect(scrub("GET https://api.example/routes/12_Elm_St.json failed")).toBe("GET ‹url› failed");
    expect(scrub("GET https://localhost/app-BrmPk3gH.js failed")).toBe("GET app-BrmPk3gH.js failed");
    expect(scrub("https://localhost/sw.js")).toBe("sw.js");
  });

  it("doesn't keep a file name that carries a coordinate, whatever its hash looks like", () => {
    // the pattern let digits and dots into the name part for "routing.worker-…"; a
    // name with a coordinate in it was then kept as the app's own
    for (const name of ["p42.3967-71.1223-AbCdEfGh.js", "pin-42.3967--71.1223-Location.js", "Home-dr5regw3-AbCdEfGh.js"]) {
      expect(scrub(`https://example.test/${name}`), name).toBe("‹url›");
    }
    expect(scrubbed(sample({ frames: ["f (p42.3967-71.1223-AbCdEfGh.js:1:2)"] })).frames).toEqual(["f (‹url›)"]);
    expect(scrubbed(sample({ frames: ["f (lat42.3967-lon71.1223-AbCdEfGh.js:1:2)"] })).frames).toEqual(["f (‹url›)"]);
  });

  it("doesn't keep a name whose suffix could be a geohash: a place to within tens of metres", () => {
    // eight lowercase characters and digits: Vite's hash has a capital in it
    expect(scrub("https://example.test/home-dr5regw3.js")).toBe("‹url›");
  });

  it("keeps a name only if it is one of the app's chunks, whatever shape a geohash or a coordinate gives it", () => {
    for (const name of ["home-drkrqkrr-AbCdEfGh.js", "drkrqkrr-AbCdEfGh.js", "Broadway-AbCdEfGh.js", "lat42-AbCdEfGh.js"]) {
      expect(scrub(`https://example.test/${name}`), name).toBe("‹url›");
    }
  });

  it("reads the list of chunk names from bundles.json, which the build checks the same way", () => {
    // not parsed out of the source: the build (web/scripts/check-dist.mjs) reads
    // this file as JSON, so the two can't drift on a reformat
    expect(BUNDLE_BASES).toEqual(bundlesJson.bases);
    expect(bundlesJson.fixed).toContain("sw.js");
  });

  it("keeps no hash that holds a coordinate or a place, though its name is listed", () => {
    for (const name of ["app-L42_71xx.js", "app-X4239677.js", "report-A12345bc.js"]) {
      expect(scrub(`https://example.test/${name}`), name).toBe("‹url›");
    }
  });

  it("keeps the names of the bundles this app really builds", () => {
    for (const name of [
      "app-BrmPk3gH.js",
      "SegmentCard-BfR1ViFb.js",
      "report-DPXCPETW.js",
      "routing.worker-Cb0awvtT.js",
      "maplibre-gl.mjs",
      "maplibre-gl-shared.mjs",
      "sw.js",
    ]) {
      expect(scrub(`https://localhost/${name}`), name).toBe(name);
    }
  });
});


describe("one problem, one issue", () => {
  it("is the same problem at a different column of the minified line", async () => {
    // scrubbed as a report is filed, a frame's column keeps its digits: it used
    // to become ‹n› from five digits, which differs from a shorter column
    const a = scrubbed(sample({ frames: ["f (app-AbCd1234.js:1:9876)"] }));
    const b = scrubbed(sample({ frames: ["f (app-ZyXw5678.js:1:12345)"] }));
    expect(a.frames[0]).toBe("f (app-AbCd1234.js:1:9876)");
    expect(b.frames[0]).toBe("f (app-ZyXw5678.js:1:12345)");
    expect(await fingerprint(a)).toBe(await fingerprint(b));
  });

  it("is a different fingerprint for a dotted chain the scrubber now takes whole: a one-time re-file, accepted", () => {
    // what an issue filed under the old scrubber carries ("WebView ‹n›.6099"), and what
    // the same message is now. Pinned so the change is a decision and not a surprise.
    expect(signature({ ...sample(), message: "failed on WebView ‹n›.6099" })).toContain("failed on WebView #.#");
    expect(signature({ ...sample(), message: "failed on WebView ‹n›" })).toContain("failed on WebView #|");
  });

  it("is the same problem whether its number was short enough to survive the scrubbing or not", async () => {
    const a = scrubbed(sample({ message: "no tile 12 at z14" }));
    const b = scrubbed(sample({ message: "no tile 12345 at z14" }));
    expect(await fingerprint(a)).toBe(await fingerprint(b));
  });

  it("reads the same failure differently with a URL that has a query and one that hasn't: an accepted split", async () => {
    // A query is taken whole to the end of the line (privacy: its words can have
    // spaces in them, and stopping at the first would publish the rest), which also
    // takes what follows it; without one, the rest of the message stays. Folding
    // the two together (everything after a URL dropped from the fingerprint) was
    // tried, and folds different failures at the same URL into one issue instead.
    // Duplicates are bounded by the daily cap; a hidden failure is not.
    const a = scrubbed(sample({ message: "GET https://api.example/search failed with 404" }));
    const b = scrubbed(sample({ message: "GET https://api.example/search?q=Elm failed with 404" }));
    expect(a.message).toBe("GET ‹url› failed with 404");
    expect(b.message).toBe("GET ‹url›");
    expect(await fingerprint(a)).not.toBe(await fingerprint(b));
  });

  it("is a different problem when what followed the URL differs: the failures aren't folded into one issue", async () => {
    const a = scrubbed(sample({ message: "GET https://api.example/a failed with 404" }));
    const b = scrubbed(sample({ message: "GET https://api.example/b failed with CORS" }));
    expect(await fingerprint(a)).not.toBe(await fingerprint(b));
  });

  it("is the same problem in the next build, whose bundle has a new name", async () => {
    const next = sample({
      frames: ["renderRibbon (app-Zq81LmP0.js:1:23511)"],
      build: "app-v56 aaaaaaa",
    });
    expect(signature(next)).toBe(signature(sample()));
    expect(await fingerprint(next)).toBe(await fingerprint(sample()));
  });

  it("is the same problem when a bundle's hash has a hyphen in it", async () => {
    const a = sample({ frames: ["f (app-Abc-d_efGh.js:1:2)"] });
    const b = sample({ frames: ["f (app-Zy-x_wvUt.js:9:9)"] });
    expect(await fingerprint(a)).toBe(await fingerprint(b));
  });

  it("is the same problem with different numbers in its message", async () => {
    const a = sample({ message: "no tile 12 at z14" });
    const b = sample({ message: "no tile 907 at z14" });
    expect(await fingerprint(a)).toBe(await fingerprint(b));
  });

  it("is a different problem in a different place, or of a different kind", async () => {
    const elsewhere = sample({ frames: ["showSummary (app-BrmPk3gH.js:1:24000)"] });
    expect(await fingerprint(elsewhere)).not.toBe(await fingerprint(sample()));
    expect(await fingerprint(sample({ kind: "rejection" }))).not.toBe(await fingerprint(sample()));
  });

  it("is twelve hex digits", async () => {
    expect(await fingerprint(sample())).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("the issue", () => {
  it("is titled by its kind and message, cut to a line", () => {
    expect(issueTitle(sample())).toBe("[error] TypeError: Cannot read properties of undefined (reading 'lngLat')");
    expect(issueTitle(sample({ message: `${"word ".repeat(40)}\nsecond line` }))).toMatch(/^\[error\] .{79}…$/u);
  });

  it("keeps what was reported inside a fence it can't close, so none of it is markup", () => {
    const body = issueBody(
      sample({ message: "```\n@pelednoam ![x](https://evil.example/p.png)" }),
      "abc123abc123",
      "2026-09-29",
    );
    const fence = body.indexOf("```text\n");
    const close = body.indexOf("\n```", fence + 8);
    const inside = body.slice(fence + 8, close);
    expect(inside).toContain("@pelednoam");
    expect(inside).not.toContain("`");
    // nothing after the fence but the app's own words
    expect(body.slice(close + 4)).not.toContain("@");
    expect(body).toContain("Its fingerprint: `fp-abc123abc123`");
    // all of it inside the fence: page, platform, browser and build are the app's words
    expect(inside).toContain("build app-v55 d649c79");
  });
});
