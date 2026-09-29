// Error reports, as the app builds them: the stack cut to names, the browser to
// its family, and at most a few a page load. And the contract: what the app
// sends is what the endpoint (reports/) takes.
import { describe, expect, it } from "vitest";

import { check } from "../../reports/src/report.js";
import {
  browserOf,
  createReporter,
  framesOf,
  MAX_PER_LOAD,
  type Reporter,
  type ReportBody,
  reportCaught,
  reportUncaught,
  startReporting,
} from "../src/report.js";

const CHROME_STACK = `TypeError: Cannot read properties of undefined (reading 'lngLat')
    at renderRibbon (https://pelednoam.github.io/safe-bikes-lanes/app-BrmPk3gH.js:1:23456)
    at async showSummary (https://pelednoam.github.io/safe-bikes-lanes/app-BrmPk3gH.js:1:24000)
    at https://pelednoam.github.io/safe-bikes-lanes/app-BrmPk3gH.js:3:10`;

const GECKO_STACK = `renderRibbon@https://localhost/app-BrmPk3gH.js:1:23456
@https://localhost/app-BrmPk3gH.js?x=1#y:3:10`;

function reporter(): { sent: ReportBody[]; r: Reporter } {
  const sent: ReportBody[] = [];
  const r = createReporter({
    build: "app-v55 d649c79",
    page: "planner",
    platform: "web",
    browser: "Chrome 140",
    send: (body) => sent.push(JSON.parse(body) as ReportBody),
  });
  return { sent, r };
}

function errorWith(message: string, stack: string): Error {
  const e = new TypeError(message);
  e.stack = stack;
  return e;
}

describe("the stack", () => {
  it("is cut to function and file names, from Chrome's form", () => {
    expect(framesOf(CHROME_STACK)).toEqual([
      "renderRibbon (app-BrmPk3gH.js:1:23456)",
      "showSummary (app-BrmPk3gH.js:1:24000)",
      "<anonymous> (app-BrmPk3gH.js:3:10)",
    ]);
  });

  it("and from Firefox's and Safari's, dropping a query and a hash", () => {
    expect(framesOf(GECKO_STACK)).toEqual([
      "renderRibbon (app-BrmPk3gH.js:1:23456)",
      "<anonymous> (app-BrmPk3gH.js:3:10)",
    ]);
  });

  it("keeps at most fifteen frames", () => {
    const deep = Array.from({ length: 40 }, (_, i) => `    at f${i} (https://x/a.js:1:${i})`).join("\n");
    expect(framesOf(deep)).toHaveLength(15);
  });

  it("is empty with no stack", () => {
    expect(framesOf(undefined)).toEqual([]);
  });
});

describe("the browser", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Chrome 140",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.51 Mobile Safari/537.36",
      "WebView 140",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox 131"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari 18",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      "Edge 140",
    ],
    ["curl/8.5.0", ""],
  ])("names %s as %j, and nothing more", (ua, name) => {
    expect(browserOf(ua)).toBe(name);
  });
});

describe("a report", () => {
  it("carries what went wrong and where in the code, and the endpoint takes it", () => {
    const { sent, r } = reporter();
    r.report("error", errorWith("Cannot read properties of undefined (reading 'lngLat')", CHROME_STACK));
    expect(sent).toHaveLength(1);
    const body = sent[0];
    expect(body).toEqual({
      v: 1,
      kind: "error",
      message: "TypeError: Cannot read properties of undefined (reading 'lngLat')",
      frames: framesOf(CHROME_STACK),
      build: "app-v55 d649c79",
      page: "planner",
      platform: "web",
      browser: "Chrome 140",
    });
    expect(check(body)).toEqual({ ok: true, report: body });
  });

  it("describes a rejection that isn't an Error", () => {
    const { sent, r } = reporter();
    r.report("rejection", "no tiles");
    r.report("rejection", { code: 7 });
    expect(sent.map((b) => b.message)).toEqual(["no tiles", '{"code":7}']);
    expect(sent.every((b) => check(b).ok)).toBe(true);
  });

  it("cuts a long message to what the endpoint takes", () => {
    const { sent, r } = reporter();
    r.report("error", new Error("x".repeat(2000)));
    expect(check(sent[0]).ok).toBe(true);
  });

  it("is sent once for the same error, however often it happens", () => {
    const { sent, r } = reporter();
    for (let i = 0; i < 20; i++) r.report("error", errorWith("boom", CHROME_STACK));
    expect(sent).toHaveLength(1);
  });

  it("stops after a few a page load", () => {
    const { sent, r } = reporter();
    for (let i = 0; i < 20; i++) r.report("error", new Error(`boom ${i}`));
    expect(sent).toHaveLength(MAX_PER_LOAD);
  });

  it("isn't sent for noise every site gets, or an extension's errors", () => {
    const { sent, r } = reporter();
    r.report("error", "Script error.");
    r.report("error", new Error("ResizeObserver loop completed with undelivered notifications."));
    r.report("error", errorWith("x", "f@chrome-extension://abcdef/content.js:1:1"));
    r.report("error", "");
    expect(sent).toEqual([]);
  });
});

describe("what nobody caught", () => {
  it("is reported: errors, and promises rejected with no handler", () => {
    const listeners = new Map<string, (e: unknown) => void>();
    const target = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    } as unknown as Pick<Window, "addEventListener">;
    const seen: [string, unknown][] = [];
    reportUncaught(target, { report: (kind, err) => seen.push([kind, err]) });
    const boom = new Error("boom");
    listeners.get("error")?.({ error: boom, message: "boom" });
    listeners.get("error")?.({ error: null, message: "Script error." });
    listeners.get("unhandledrejection")?.({ reason: "no tiles" });
    expect(seen).toEqual([
      ["error", boom],
      ["error", "Script error."],
      ["rejection", "no tiles"],
    ]);
  });
});

describe("reporting is off", () => {
  it("in a build that names no endpoint, as every test build does", () => {
    expect(startReporting("planner")).toBeNull();
  });

  it("and then a caught error goes nowhere, and says nothing", () => {
    expect(() => reportCaught("worker", new Error("the route finder didn't start"))).not.toThrow();
  });
});
