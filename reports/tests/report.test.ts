// The report format, the scrubbing, and what makes two reports one problem.
import { describe, expect, it } from "vitest";

import {
  check,
  fingerprint,
  issueBody,
  issueTitle,
  scrub,
  scrubbed,
  signature,
} from "../src/report.js";
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
      "geocode (‹url›:4:5)",
      "near ‹n› (app-AbCd1234.js:9:9)",
    ]);
  });

  it("takes out a control character first, so one inside a coordinate doesn't hide it", () => {
    expect(scrub("at 42\u0001.3967,-71\u001b.1223")).toBe("at ‹n›,‹n›");
    expect(scrub("https\u0000://x.example/search?q=Elm")).toBe("‹url›");
    expect(scrub("42\u200b.3967")).toBe("‹n›");
  });

  it("takes out the characters that render as nothing, whichever script they come from", () => {
    expect(scrub("a\u034fb\u3164c\ufe0fd\u{E0041}e")).toBe("abcde");
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

  it("is the same problem whether its number was short enough to survive the scrubbing or not", async () => {
    const a = scrubbed(sample({ message: "no tile 12 at z14" }));
    const b = scrubbed(sample({ message: "no tile 12345 at z14" }));
    expect(await fingerprint(a)).toBe(await fingerprint(b));
  });

  it("is the same problem with a URL that has a query and one that has none", async () => {
    const a = scrubbed(sample({ message: "GET https://api.example/search failed with 404" }));
    const b = scrubbed(sample({ message: "GET https://api.example/search?q=Elm failed with 404" }));
    expect(await fingerprint(a)).toBe(await fingerprint(b));
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
