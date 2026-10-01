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
  // A version, with the commit a branch build adds to it ("app-v52-dev.1a2b3c4"),
  // and the commit: "app-v55 d649c79", never a host. Anything else is refused.
  if (
    !shortString(o["build"], LIMITS.build) ||
    !/^[A-Za-z0-9_-]{1,24}(\.[0-9a-f]{7})?( [A-Za-z0-9_-]{1,16})?$/.test(o["build"])
  ) {
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
const DECIMAL = /-?\d+\s*\.\s*\d+/g;
/** Numbers set side by side: "42,-71", "14/4953/6060" (a tile), "12_34" (a grid
 * cell), "14:4953:6060", "14-4953-6060", "POINT(-71 42)", "tile 4953 6060".
 * Counts and sizes stand alone; these are positions. */
const NUMBER_RUN = /-?\d+(?:(?:\s*[,/_;:x×-]\s*|\s+)-?\d+)+/g;
/** "z=14 x=4953 y=6060", "lat=42 lon=-71", '"lat":42', "tile_x=4953", "lat 42":
 * tile axes and coordinates with their names, whole numbers too (a decimal is
 * taken anyway). The name must not be the end of a longer word ("max 5"), but may
 * follow an underscore or a quote, which is how JSON.stringify and snake_case
 * write them. */
const LABELLED = /(?<![A-Za-z])(?:[xyz]|lat(?:itude)?|lon(?:gitude)?|lng)["']?\s*[=:]?\s*-?\d+(?:\.\d+)?/gi;
/** Degrees, minutes, seconds: 42°23'48"N 71°7'20"W. */
const DMS = /\d+\s*°(?:\s*\d+(?:\.\d+)?\s*['′’])?(?:\s*\d+(?:\.\d+)?\s*(?:"|″|''))?\s*[NSEW]?/gi;
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
/** Control characters, which have to go before anything is matched: one inside
 * a coordinate ("42\u0001.3967") stops it matching, and taking it out afterwards
 * leaves the coordinate whole. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Characters that change how text reads without showing: every format
 * character (direction overrides and isolates, zero-width and joiner characters,
 * the soft hyphen, interlinear annotation marks, tag characters), every
 * variation selector, fillers, line and paragraph separators. In a public
 * issue's title they make one report look like another, and, like control
 * characters, they hide a coordinate from a match. Combining marks go too
 * ("42\u0301.3967" reads as the coordinate it is). By class, not by list: a
 * hand-picked list had gaps (U+FFF9, the Mongolian selectors), each one a way to
 * split "42.3967" so that nothing matched it. */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE =
  /[\p{Cf}\p{Mn}\p{Me}\p{Variation_Selector}\u115f\u1160\u17b4\u17b5\u2028\u2029\u2800\u3164\uffa0]/gu;

/** The bundles this app builds, by name: "app-BrmPk3gH.js" (a name and Vite's
 * eight-character hash), and the few files that keep theirs. The only file
 * names that stay in a report: any other, "12_Elm_St.json" for one, is
 * whatever a feed or a rider put in a URL. */
const BUNDLE_NAME =
  /^(?:[A-Za-z][A-Za-z-]*(?:\.worker)?-([A-Za-z0-9_-]{8})|sw|compat|maplibre-gl(?:-[a-z]+)?)\.m?js$/;
/** A name of this shape, with a hash that has a capital in it, as Vite's nearly
 * always does (all but one in sixty, which loses its frame's file name). A
 * geohash ("home-dr5regw3.js", a place to within tens of metres) is lowercase
 * and digits only. */
function isBundle(file: string): boolean {
  const m = BUNDLE_NAME.exec(file);
  if (m === null) return false;
  const hash = m[1];
  if (hash !== undefined && !/[A-Z]/.test(hash)) return false;
  // The name part has no digits, which is where a coordinate would sit
  // ("p42.3967-71.1223-AbCdEfGh.js"), and, as a last check, a name that scrubbing
  // would change is not kept: whatever the pattern lets through, this can't be
  // made to publish what the rest of the scrubber would take out.
  return scrub(file) === file;
}

/** A URL down to its bundle's name, if it names one: the host is ours, and the
 * path, query and hash are where a trip's ends and a searched address would be.
 * A frame's position after it stays. */
function urlToFile(url: string): string {
  // a stack frame's position comes after everything, query included
  const at = /(:\d+(?::\d+)?)$/.exec(url)?.[1] ?? "";
  const bare = url.slice(0, url.length - at.length);
  const path = bare.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/s, "");
  const file = path.split("/").filter((p) => p !== "").pop();
  return (file !== undefined && isBundle(file) ? file : "‹url›") + at;
}

/** Digits and separators from other scripts as ASCII, so "٤٢٫٣٩٦٧" is matched
 * as the coordinate it is: `\d` is ASCII-only, and a phone set to Arabic or
 * Persian writes its numbers this way. The digits' values don't matter, only
 * that they are digits. */
function ascii(text: string): string {
  return text
    .replace(/\p{Nd}/gu, (d) => (/[0-9]/.test(d) ? d : "0"))
    .replace(/[\u066b\u2396\uff0e\u2024\u2027\ufe52\u00b7\u3002\uff61]/g, ".")
    .replace(/[\u066c\u060c\uff0c\ufe50\uff64\u3001]/g, ",");
}

/** Text with anything that could say where someone is, or who, taken out. */
export function scrub(text: string): string {
  return ascii(text)
    .replace(CONTROL, "")
    .replace(INVISIBLE, "")
    .replace(URL_TEXT, (u) => urlToFile(u))
    .replace(EMAIL, "‹email›")
    .replace(ADDRESS, "‹address›")
    .replace(DMS, "‹n›")
    // decimals before the labelled whole numbers: "lat 42 .3967" must lose its
    // fraction with it, not have "lat 42" taken and ".3967" left behind
    .replace(DECIMAL, "‹n›")
    .replace(LABELLED, "‹n›")
    .replace(NUMBER_RUN, "‹n›")
    .replace(LONG_DIGITS, "‹n›");
}

/** A frame as the app writes it, "fn (file:line:col)": the function is
 * scrubbed, and a bundle's own name and its position stay as they are. A column
 * past five digits is what a minified bundle's one long line has, and is where
 * the bug is: taken for an id, it left a frame nothing could find the bug by (and
 * a fingerprint of it that differed from build to build). Only for a bundle,
 * though: after any other file the "position" could be a coordinate
 * ("f (42:3967:711223)"), and the frame loses its file and its numbers. */
const FRAME = /^(.*) \(([^()]*?):(\d{1,7})(?::(\d{1,7}))?\)$/;
function scrubFrame(frame: string): string {
  const m = FRAME.exec(frame);
  if (m === null) return scrub(frame);
  const [, fn = "", file = "", line = "", col] = m;
  // a file that isn't one of the app's bundles is whatever a URL ended in: it, and
  // the numbers after it, go
  if (!isBundle(file)) return `${scrub(fn)} (‹url›)`;
  return `${scrub(fn)} (${file}:${line}${col === undefined ? "" : `:${col}`})`;
}

export function scrubbed(r: Report): Report {
  return {
    ...r,
    message: scrub(r.message).slice(0, LIMITS.message),
    frames: r.frames.map((f) => scrubFrame(f).slice(0, LIMITS.frame)),
  };
}

/** What makes two reports the same problem: the kind, the message with its
 * numbers taken out, and the innermost frame without its position. Bundles are
 * renamed by every build (app-BrmPk3gH.js), so a file's hash is left out too,
 * or each build would open a new issue for the same bug. */
export function signature(r: Report): string {
  const message = r.message
    // a number is a number whether the scrubber took it out or it was short
    .replace(/‹n›|\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
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
