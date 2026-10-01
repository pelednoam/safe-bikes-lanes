// Error reports: what went wrong, and where in the code, sent to the endpoint
// in reports/ (a Cloudflare Worker that files them as GitHub issues).
//
// Never where the rider is. A report is the error's message and its stack,
// cut to function and file names, plus the build, the page, the platform and
// the browser's name; nothing from the URL (a permalink holds a trip's ends),
// the map, or the device. The endpoint checks and scrubs all of it again: it
// refuses a field it doesn't know, and the issues it files are public.
//
// Off unless the build was given REPORT_URL, and off under test automation, so
// no test run files an issue.
import { isNativeApp } from "./native.js";

export type Kind = "error" | "rejection" | "worker" | "native";

/** The format the endpoint takes (reports/src/report.ts checks it). */
export interface ReportBody {
  v: 1;
  kind: Kind;
  message: string;
  frames: string[];
  build: string;
  page: string;
  platform: "web" | "android";
  browser: string;
}

const MAX_MESSAGE = 500;
const MAX_FRAMES = 15;
const MAX_FRAME = 200;
/** Reports a page load sends at most: an error in a loop is one bug, not a flood. */
export const MAX_PER_LOAD = 5;

const CHROME_AT = /^\s*at (?:async )?(.*?) \((.+):(\d+):(\d+)\)$/;
const CHROME_BARE = /^\s*at (?:async )?(.+):(\d+):(\d+)$/;
const GECKO = /^(.*?)@(.+):(\d+):(\d+)$/;

/** The file a script URL names, without its origin, path, query or hash. */
function fileOf(url: string): string {
  const path = url.replace(/^[a-z-]+:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
  return path.split("/").filter((p) => p !== "").pop() ?? "?";
}

/** A stack as "fn (file:line:col)" frames, innermost first. Chrome writes
 * "at fn (url:1:2)", Firefox and Safari "fn@url:1:2"; lines that are neither
 * (the message Chrome repeats first) are left out. */
export function framesOf(stack: string | undefined): string[] {
  const frames: string[] = [];
  const lines = (stack ?? "").split("\n");
  // Chrome opens a stack with the error's message, which can itself look like
  // "something@somewhere:1:2" and pass for a Firefox frame (and so put the
  // message in the frames). A stack with any "at" line is Chrome's, and only
  // those lines are frames.
  const chrome = lines.some((l) => /^\s*at /.test(l));
  for (const line of lines) {
    const m = CHROME_AT.exec(line) ?? (chrome ? null : GECKO.exec(line.trim()));
    const bare = m === null ? CHROME_BARE.exec(line) : null;
    const [fn, url, row, col] =
      m !== null ? [m[1], m[2], m[3], m[4]] : bare !== null ? ["", bare[1], bare[2], bare[3]] : [];
    if (url === undefined) continue;
    const name = (fn ?? "").trim().slice(0, 80) || "<anonymous>";
    frames.push(`${name} (${fileOf(url)}:${row}:${col})`.slice(0, MAX_FRAME));
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

/** An extension's script: its errors are not the app's. */
function fromExtension(stack: string | undefined): boolean {
  return /\b(chrome|moz|safari(-web)?)-extension:\/\//.test(stack ?? "");
}

/** The browser's family and major version, and nothing else from the UA. */
export function browserOf(ua: string): string {
  const v = (re: RegExp): string => re.exec(ua)?.[1] ?? "";
  // trimmed: with no version to read, "Edge " would fail the endpoint's check,
  // and the report would be dropped for the very browser it is about
  if (/Edg\//.test(ua)) return `Edge ${v(/Edg\/(\d+)/)}`.trim();
  if (/Firefox\//.test(ua)) return `Firefox ${v(/Firefox\/(\d+)/)}`.trim();
  if (/Chrome\//.test(ua)) {
    return `${/; wv\)/.test(ua) ? "WebView" : "Chrome"} ${v(/Chrome\/(\d+)/)}`.trim();
  }
  if (/Safari\//.test(ua)) return `Safari ${v(/Version\/(\d+)/)}`.trim();
  return "";
}

/** What is said of an error. An Error says its name and message (the Worker
 * takes anything locating out of them before they are public). A browser's
 * message for an uncaught error is a string too. But a promise rejected with a
 * bare value says nothing of its contents: it could be any object the app had
 * to hand, a place, a name, a token, and a serialised copy of it would go into a
 * public issue; the fact of the rejection, and its stack if it has one, is what
 * can be acted on. */
function describe(kind: Kind, error: unknown): { message: string; stack: string | undefined } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack };
  }
  if (typeof error === "string" && kind !== "rejection") return { message: error, stack: undefined };
  const what = error === null ? "null" : Array.isArray(error) ? "an array" : typeof error;
  return { message: `Rejected with ${what}, not an Error`, stack: undefined };
}

/** Noise every site gets: not errors in this app's code. */
function isNoise(message: string): boolean {
  return /^(Script error\.?|ResizeObserver loop)/.test(message.replace(/^\w+: /, ""));
}

export interface ReporterOptions {
  build: string;
  page: string;
  platform: "web" | "android";
  browser: string;
  send(body: string): void;
}

export interface Reporter {
  report(kind: Kind, error: unknown): void;
}

export function createReporter(o: ReporterOptions): Reporter {
  const sent = new Set<string>();
  return {
    report(kind, error) {
      if (sent.size >= MAX_PER_LOAD) return;
      const { message, stack } = describe(kind, error);
      if (message.trim() === "" || isNoise(message) || fromExtension(stack)) return;
      const frames = framesOf(stack);
      const body: ReportBody = {
        v: 1,
        kind,
        message: message.slice(0, MAX_MESSAGE),
        frames,
        build: o.build,
        page: o.page,
        platform: o.platform,
        browser: o.browser,
      };
      const once = `${kind}|${body.message}|${frames[0] ?? ""}`;
      if (sent.has(once)) return;
      sent.add(once);
      o.send(JSON.stringify(body));
    },
  };
}

/** Report what nobody caught: errors, and promises rejected with no handler. */
export function reportUncaught(target: Pick<Window, "addEventListener">, reporter: Reporter): void {
  target.addEventListener("error", (e: ErrorEvent) => {
    reporter.report("error", e.error ?? e.message);
  });
  target.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    reporter.report("rejection", e.reason);
  });
}

/** Posted as text/plain, which needs no preflight, with keepalive so a report
 * sent as the page closes still goes, and without cookies. A report that fails
 * to send is dropped: nothing about reporting may itself be an error. */
function sender(endpoint: string): (body: string) => void {
  return (body) => {
    try {
      void fetch(endpoint, {
        method: "POST",
        body,
        keepalive: true,
        credentials: "omit",
        headers: { "content-type": "text/plain;charset=UTF-8" },
      }).catch(() => {});
    } catch {
      // a browser without fetch, or keepalive, has nothing to report with
    }
  };
}

// typeof, so that a module importing this outside a build (the unit tests)
// finds reporting off rather than an undefined name
const ENDPOINT = typeof __REPORT_URL__ === "string" ? __REPORT_URL__ : "";
const BUILD =
  typeof __BUILD_VERSION__ === "string" && typeof __BUILD_COMMIT__ === "string"
    ? `${__BUILD_VERSION__} ${__BUILD_COMMIT__}`.slice(0, 40)
    : "dev unknown";

let active: Reporter | null = null;

/** What reporting needs from the page: where to send, whether a test is driving
 * the browser, and the page it can listen on. Real values by default; a test
 * says its own. */
export interface Setup {
  endpoint: string;
  /** navigator.webdriver: set by Playwright, Selenium, and other automation. */
  automated: boolean;
  target: Pick<Window, "addEventListener">;
  send(body: string): void;
  userAgent: string;
  android: boolean;
}

function pageSetup(): Setup {
  return {
    endpoint: ENDPOINT,
    automated: navigator.webdriver === true,
    target: window,
    send: sender(ENDPOINT),
    userAgent: navigator.userAgent,
    android: isNativeApp(),
  };
}

/** Start reporting for this page. Null, and nothing is sent, in a build
 * without an endpoint and under test automation, so that no test run files an
 * issue. */
export function startReporting(page: string, setup: Setup = pageSetup()): Reporter | null {
  if (setup.endpoint === "" || setup.automated) {
    // and nothing from an earlier start carries on sending
    active = null;
    return null;
  }
  active = createReporter({
    build: BUILD,
    page,
    platform: setup.android ? "android" : "web",
    browser: browserOf(setup.userAgent),
    send: setup.send,
  });
  reportUncaught(setup.target, active);
  return active;
}

/** Report an error that was caught, because it still shouldn't have happened
 * (the routing worker failing, a native call throwing). A no-op when off. */
export function reportCaught(kind: Kind, error: unknown): void {
  active?.report(kind, error);
}
