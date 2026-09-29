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
    ["page", { page: "../etc" }],
    ["browser", { browser: "Chrome <140>" }],
  ])("refuses a bad %s", (why, over) => {
    expect(check({ ...sample(), ...over })).toEqual({ ok: false, why });
  });

  it.each([null, [], "report", 1])("refuses %j", (body) => {
    expect(check(body).ok).toBe(false);
  });
});

describe("the scrubbing", () => {
  it("takes out coordinates, whatever they're written in", () => {
    expect(scrub("no route from -71.1223,42.3967 to [-71.0867, 42.3626]")).toBe(
      "no route from ‹n›,‹n› to [‹n›, ‹n›]",
    );
  });

  it("keeps whole numbers: counts and sizes say what went wrong, and nobody is found by them", () => {
    expect(scrub("tile 1234 of 2500 failed with 404")).toBe("tile 1234 of 2500 failed with 404");
  });

  it("cuts a URL to its file's name, which drops a permalink's ends and a searched address", () => {
    expect(
      scrub("Failed to fetch https://pelednoam.github.io/safe-bikes-lanes/#s=-71.12,42.39&e=-71.08,42.36"),
    ).toBe("Failed to fetch safe-bikes-lanes");
    expect(scrub("at https://localhost/app-BrmPk3gH.js?v=3:1:200")).toBe("at app-BrmPk3gH.js:1:200");
    expect(
      scrub("GET https://nominatim.openstreetmap.org/search?q=12+Elm+St+Somerville&format=json failed"),
    ).toBe("GET search failed");
  });

  it("takes out an email address", () => {
    expect(scrub("login failed for someone@example.com")).toBe("login failed for ‹email›");
  });

  it("drops control characters", () => {
    expect(scrub("a\u0000b\u001bc\nd")).toBe("abc\nd");
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
    expect(body).toContain("build app-v55 d649c79");
  });
});
