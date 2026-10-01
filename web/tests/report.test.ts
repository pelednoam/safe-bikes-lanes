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
  type Setup,
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

  it("doesn't take Chrome's message line for a frame, however it is written", () => {
    const stack = `Error: failed@https://x.example/a.js:1:2\n    at real (https://localhost/app-X.js:3:4)`;
    expect(framesOf(stack)).toEqual(["real (app-X.js:3:4)"]);
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
    // no version to read: still a name the endpoint takes, not "Edge "
    ["Mozilla/5.0 Gecko/20100101 Firefox/", "Firefox"],
    ["Mozilla/5.0 AppleWebKit/537.36 Chrome/ Safari/537.36", "Chrome"],
    ["Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/", "Edge"],
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

  it("says only the fact of a rejection with something that isn't an Error, never its contents", () => {
    const { sent, r } = reporter();
    r.report("rejection", "no tiles for Home at 42.38,-71.1");
    r.report("rejection", { place: "Home", lngLat: [-71.1, 42.38], rider: "Noam" });
    r.report("rejection", null);
    r.report("rejection", [1, 2]);
    expect(sent.map((b) => b.message)).toEqual([
      "Rejected with string, not an Error",
      "Rejected with object, not an Error",
      "Rejected with null, not an Error",
      "Rejected with an array, not an Error",
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/Home|Noam|42\.38/);
    expect(sent.every((b) => check(b).ok)).toBe(true);
  });

  it("still sends a browser's own message for an error nothing caught", () => {
    const { sent, r } = reporter();
    r.report("error", "Uncaught TypeError: x is not a function");
    expect(sent.map((b) => b.message)).toEqual(["Uncaught TypeError: x is not a function"]);
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

describe("when reporting starts", () => {
  const listeners: string[] = [];
  const sent: string[] = [];
  const setup = (over: Partial<Setup> = {}): Setup => ({
    endpoint: "https://reports.example/report",
    automated: false,
    target: { addEventListener: ((type: string) => listeners.push(type)) as Window["addEventListener"] },
    send: (b) => sent.push(b),
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    android: false,
    ...over,
  });

  it("is not at all under test automation, whatever the endpoint: no test run files an issue", () => {
    listeners.length = 0;
    expect(startReporting("planner", setup({ automated: true }))).toBeNull();
    expect(listeners).toEqual([]);
  });

  it("is not at all without an endpoint", () => {
    expect(startReporting("planner", setup({ endpoint: "" }))).toBeNull();
  });

  it("is on in a real browser with one: it listens, and a report says which page and platform", () => {
    listeners.length = 0;
    sent.length = 0;
    const r = startReporting("build", setup({ android: true }));
    expect(r).not.toBeNull();
    expect(listeners).toEqual(["error", "unhandledrejection"]);
    r?.report("error", new Error("boom"));
    const body = JSON.parse(sent[0] ?? "{}") as { page: string; platform: string; browser: string };
    expect(body).toMatchObject({ page: "build", platform: "android", browser: "Firefox 131" });
  });
});

describe("reporting is off", () => {
  it("a caught error goes nowhere once reporting has been stopped, however it was started before", () => {
    // an earlier start leaves its reporter behind, and a later, disabled one used
    // to leave it sending: this checks that a report really isn't sent, which
    // "doesn't throw" never did
    const sent: string[] = [];
    const base: Setup = {
      endpoint: "https://reports.example/report",
      automated: false,
      target: { addEventListener: (() => undefined) as Window["addEventListener"] },
      send: (b) => sent.push(b),
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      android: false,
    };
    expect(startReporting("planner", base)).not.toBeNull();
    reportCaught("worker", new Error("first"));
    expect(sent).toHaveLength(1);
    expect(startReporting("planner", { ...base, automated: true })).toBeNull();
    reportCaught("worker", new Error("second"));
    expect(sent, "a report was sent after reporting was switched off").toHaveLength(1);
  });
});
