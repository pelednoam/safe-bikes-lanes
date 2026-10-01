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
    expect(scrub("at https://localhost/app-BrmPk3gH.js?v=3:1:200")).toBe("at app-BrmPk3gH.js:1:200");
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

  it("scrubs the frames as well as the message", () => {
    const r = scrubbed(sample({ frames: ["onFix (https://localhost/ride-x.js:4:5) at 42.38123"] }));
    expect(r.frames).toEqual(["onFix (ride-x.js:4:5) at ‹n›"]);
  });
});

describe("one problem, one issue", () => {
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
