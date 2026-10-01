// What an error report is, and what is done to it before anyone sees it.
//
// The reports end up as issues on a public repository, and they come from
// phones that are riding somewhere with children. So a report carries only
// what went wrong and where in the code (never where the rider is) and this
// is checked here, on the server, whatever the app sent: fields not in the
// format are refused, and what is left is scrubbed of anything that could say
// where someone is or who: any decimal number (coordinates, at any precision),
// numbers written as pairs or tile addresses, long digit runs, URLs, emails and
// street addresses. A scrubber can't know every way a place gets written, so it
// errs towards taking too much out: an error message with a number missing is
// still a bug report.

export const KINDS = ["error", "rejection", "worker", "native"] as const;
export type Kind = (typeof KINDS)[number];

export const PLATFORMS = ["web", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** A report as the app sends it (web/src/report.ts builds these). */
export interface Report {
  v: 1;
  kind: Kind;
  message: string;
  /** Stack frames, innermost first, as "fn (file:line:col)" with the file's
   * name only: no origin, no query. */
  frames: string[];
  /** Which build: its version and commit, e.g. "app-v55 d649c79". */
  build: string;
  /** Which page: "planner", "build", "install", a city's slug. */
  page: string;
  platform: Platform;
  /** The browser's family and major version, e.g. "Chrome 140". */
  browser: string;
}

export const LIMITS = {
  body: 16 * 1024,
  message: 500,
  frames: 15,
  frame: 200,
  build: 40,
  page: 24,
  browser: 40,
} as const;

const FIELDS = new Set(["v", "kind", "message", "frames", "build", "page", "platform", "browser"]);

export type Checked = { ok: true; report: Report } | { ok: false; why: string };

function isOneOf<T extends string>(list: readonly T[], x: unknown): x is T {
  return typeof x === "string" && (list as readonly string[]).includes(x);
}

function shortString(x: unknown, max: number): x is string {
  return typeof x === "string" && x.length <= max;
}

/** The report, if it is one: exactly the format's fields, each within limits. */
export function check(body: unknown): Checked {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, why: "not an object" };
  }
  const o = body as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !FIELDS.has(k));
  // refused rather than dropped: whatever sent it isn't sending this format
  if (extra.length > 0) return { ok: false, why: `unknown fields: ${extra.join(", ")}` };
  if (o["v"] !== 1) return { ok: false, why: "version" };
  if (!isOneOf(KINDS, o["kind"])) return { ok: false, why: "kind" };
  if (!isOneOf(PLATFORMS, o["platform"])) return { ok: false, why: "platform" };
  if (!shortString(o["message"], LIMITS.message) || o["message"].trim() === "") {
    return { ok: false, why: "message" };
  }
  const frames = o["frames"];
  if (
    !Array.isArray(frames) ||
    frames.length > LIMITS.frames ||
    !frames.every((f) => shortString(f, LIMITS.frame))
  ) {
    return { ok: false, why: "frames" };
  }
  // Words and one commit-ish token, no dots: "www.example.com" in a public issue
  // is a link, and a build is "app-v55 d649c79", never a host.
  if (!shortString(o["build"], LIMITS.build) || !/^[A-Za-z0-9_-]{1,24}( [A-Za-z0-9_-]{1,16})?$/.test(o["build"])) {
    return { ok: false, why: "build" };
  }
  if (!shortString(o["page"], LIMITS.page) || !/^[a-z][a-z-]*$/.test(o["page"])) {
    return { ok: false, why: "page" };
  }
  if (!shortString(o["browser"], LIMITS.browser) || !/^([A-Za-z]{1,12}( \d{1,3})?)?$/.test(o["browser"])) {
    return { ok: false, why: "browser" };
  }
  return {
    ok: true,
    report: {
      v: 1,
      kind: o["kind"],
      message: o["message"],
      frames: frames as string[],
      build: o["build"],
      page: o["page"],
      platform: o["platform"],
      browser: o["browser"],
    },
  };
}

/** Any decimal number. Three places was once the line (about 100 m), but
 * "42.38" is a kilometre and "42.4" ten: a coordinate is found at whatever
 * precision it was cut to, and a decimal in an error message is almost never
 * what the bug is. */
const DECIMAL = /-?\d+\.\d+/g;
/** Two numbers set side by side: "42,-71", "14/4953/6060" (a tile), "12_34"
 * (a grid cell). Counts and sizes stand alone; these are positions. */
const NUMBER_RUN = /\d+(?:\s*[,/_;]\s*-?\d+)+/g;
/** A long run of digits: a tile index, an id, a phone number. Statuses (404),
 * line numbers and small counts are shorter. */
const LONG_DIGITS = /\d{5,}/g;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
/** A house number and street: "12 Elm Street", "1600 Mass. Ave". Free text
 * can't be fully recognised; this takes the usual written forms. */
const ADDRESS =
  /\b\d{1,5}[A-Za-z]?\s+(?:[A-Za-z][\w.'’-]*\s+){0,3}?(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Way|Pkwy|Parkway|Sq|Square|Ter|Terrace|Hwy|Highway)\b\.?/gi;
/** Any scheme: the app's own (bikecache://14/4953/6060, capacitor://localhost)
 * as well as the web's. After a "?" or "#" it takes the rest of the line, spaces
 * included: "…/search?q=12 Elm St Somerville&format=json" has spaces in the
 * query, and stopping at the first would publish the rest. */
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)?#]*(?:[?#][^"'`<>)\n]*)?/gi;
/** Characters that change how text reads without showing: direction overrides
 * and isolates, zero-width and joiner characters, the soft hyphen, line and
 * paragraph separators, the byte-order mark. In a public issue's title they make
 * one report look like another. */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** A URL down to its file's name, if it has one (a name with an extension): the
 * host is ours, and the path, query and hash are where a trip's ends and a
 * searched address would be. A path ending in anything else ("…/14/4953/6060")
 * is an address, not a file, and goes whole. */
function urlToFile(url: string): string {
  // a stack frame's position comes after everything, query included
  const at = /(:\d+(?::\d+)?)$/.exec(url)?.[1] ?? "";
  const bare = url.slice(0, url.length - at.length);
  const path = bare.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/s, "");
  const file = path.split("/").filter((p) => p !== "").pop();
  return file !== undefined && /^[\w-]+(\.[\w-]+)*\.[A-Za-z]\w{0,7}$/.test(file) ? file + at : "‹url›" + at;
}

/** Text with anything that could say where someone is, or who, taken out. */
export function scrub(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(URL_TEXT, (u) => urlToFile(u))
    .replace(EMAIL, "‹email›")
    .replace(ADDRESS, "‹address›")
    .replace(DECIMAL, "‹n›")
    .replace(NUMBER_RUN, "‹n›")
    .replace(LONG_DIGITS, "‹n›")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export function scrubbed(r: Report): Report {
  return {
    ...r,
    message: scrub(r.message).slice(0, LIMITS.message),
    frames: r.frames.map((f) => scrub(f).slice(0, LIMITS.frame)),
  };
}

/** What makes two reports the same problem: the kind, the message with its
 * numbers taken out, and the innermost frame without its position. Bundles are
 * renamed by every build (app-BrmPk3gH.js), so a file's hash is left out too,
 * or each build would open a new issue for the same bug. */
export function signature(r: Report): string {
  const message = r.message.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const frame = (r.frames[0] ?? "")
    .replace(/:\d+(:\d+)?\)?$/, "")
    .replace(/-[\w-]{6,12}\.(m?js)\b/, ".$1");
  return `${r.kind}|${message}|${frame}`;
}

export async function fingerprint(r: Report): Promise<string> {
  const bytes = new TextEncoder().encode(signature(r));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The marker an issue carries, so a lost record can be found again by search. */
export function marker(fp: string): string {
  return `fp-${fp}`;
}

/** Inside a fenced block nothing is markup (no mentions, links or images) as
 * long as the text can't close the fence. */
function fenced(text: string): string {
  return "```text\n" + text.replace(/`/g, "ʼ") + "\n```";
}

export function issueTitle(r: Report): string {
  const oneLine = r.message.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
  return `[${r.kind}] ${short}`;
}

export function issueBody(r: Report, fp: string, day: string): string {
  return [
    `An error the app reported by itself, first seen ${day}.`,
    "",
    // everything the app sent is inside the fence, so none of it is markup
    fenced(
      [
        `page: ${r.page} · ${r.platform} · ${r.browser || "unknown browser"} · build ${r.build}`,
        "",
        r.message,
        ...r.frames.map((f) => `    at ${f}`),
      ].join("\n"),
    ),
    "",
    // In the text, not an HTML comment: it is what a search finds the issue by
    // when the Worker's record of it is gone.
    `The same error again is counted here in a comment, at most once a day. Its fingerprint: \`${marker(fp)}\``,
  ].join("\n");
}

export function repeatComment(count: number, since: string, r: Report): string {
  const times = count === 1 ? "once more" : `${count} more times`;
  // the build and the rest are the app's words, so they go inside code spans
  return `Seen ${times} since ${since}, most recently on the \`${r.page}\` page, \`${r.platform}\`, build \`${r.build}\`.`;
}
