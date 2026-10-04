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

import bundles from "./bundles.json";

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
 * what the bug is. Space around the point is allowed ("42 .3967", "42. 3967"),
 * which also takes the end of a sentence and the number after it ("line 5. 404
 * returned"): over-scrubbing, accepted, since the other way a coordinate
 * written with a space is published. */
const DECIMAL = /-?\d+\s*\.\s*\d+/g;
/** Numbers set side by side: "42,-71", "14/4953/6060" (a tile), "12_34" (a grid
 * cell), "14:4953:6060", "14-4953-6060", "POINT(-71 42)", "tile 4953 6060".
 * Counts and sizes stand alone; these are positions. */
const NUMBER_RUN = /-?\d+(?:(?:\s*[,/_;:-]\s*|\s+)-?\d+)+/g;
/** An optional quote, which may be escaped any number of times: JSON inside JSON
 * writes a backslash before each. */
const QUOTE = `(?:\\\\*["'])?`;
/** A word in either case, written out: the `i` flag would make the camelCase
 * lookbehinds ("a capital after a lowercase letter") match "max=5" as "ma" + "x=5". */
const either = (word: string): string =>
  [...word].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join("");
/** A single-letter axis: it needs its separator. */
const AXIS = `(?:(?<![A-Za-z0-9])[xyzXYZ]${QUOTE}\\s*[=:]|(?<=[a-z])[XYZ]${QUOTE}\\s*[=:])`;
/** latitude/longitude by name: the separator is optional. */
const NAMED =
  `(?:(?<![A-Za-z0-9])(?:${either("lat")}(?:${either("itude")})?|${either("lon")}(?:${either("gitude")})?|${either("lng")})` +
  `|(?<=[a-z])(?:Lat(?:itude)?|LAT(?:ITUDE)?|Lon(?:gitude)?|LON(?:GITUDE)?|Lng|LNG))${QUOTE}\\s*[=:]?`;
/** Tile axes and coordinates with their names, whole numbers too: "z=14 x=4953
 * y=6060", "lat=42 lon=-71", '"lat":42', "tile_x=4953", "tileX=4953",
 * '{\"x\":4953}' (JSON inside JSON), "lat 42", "lat=+42", "lon=\u221271". Decimals
 * are taken before this runs (DECIMAL, so "lat=42.3967" keeps its label as
 * "lat=‹n›"); a whole number loses its label with it ("lat=42" is "‹n›"). The
 * single-letter axes need their separator, or "0x1F", "x64" and "1920x1080" are
 * taken as coordinates and different failures fold together; the long names don't
 * ("lat 42"). Not the end of a longer word ("max 5", "latency 200"), except a
 * capital after lowercase, which is how camelCase writes it. */
const LABELLED = new RegExp(`(?:${AXIS}|${NAMED})\\s*${QUOTE}\\s*[-+]?\\d+(?:\\.\\d+)?`, "g");
/** Tile coordinates written with x between three numbers or more ("14x4953x6060")
 * or as axes run together ("z14_x4953_y6060", "x4953y6060", "z14x4953y6060"), or
 * an axis letter and its number set apart ("x 4953"). Two numbers joined by x
 * ("4953x6060") are NOT taken: a screen size ("1920x1080") looks the same, and a
 * report that loses every window size is a worse report; the app writes a tile as
 * z/x/y or z_x_y, which are. */
const TILE_RUN = /-?\d+(?:\.\d+)?(?:\s*[x×]\s*-?\d+(?:\.\d+)?){2,}/gi;
/** What may sit between the parts of a tile written as axes: a space, comma, slash,
 * point, colon, semicolon, bar, ampersand, plus, underscore or hyphen. */
const AXIS_SEP = String.raw`[_\s,/.;:|&+-]*`;
/** One axis and its number, with a fraction: "x4953", "y 6060.5". */
const axis = (letters: string): string => String.raw`[${letters}][_\s-]*\d+(?:\.\d+)?`;
/** Axes as a log writes them, after a word ("tileX4953Y6060", "tile x4953 y6060") or
 * alone, with separators between ("z14.x4953.y6060", "x4953:y6060"), a zoom first
 * ("z14y6060x4953"), a fraction ("z14_x4953_y6060.5"), either way round ("y 6060 x
 * 4953"). Not after a digit, which is a hex code ("0x4953y1") or a number. Taken
 * before DECIMAL: the fraction would otherwise be cut off first and leave
 * "z14_x4953_y‹n›" behind. A y and an x are both needed, so "1920 x 1080" is not one. */
const TILE_AXES = new RegExp(
  // not in the middle of a word ("index 3: y 4", "max 2; y 5"), unless it is
  // camelCase ("tileX4953Y6060") or the word is tile ("tilex4953y6060")
  String.raw`(?<![0-9])(?:(?<![A-Za-z])|(?<=[a-z])(?=[XYZ])|(?<=tile)(?=[xyz]))` +
    String.raw`(?:[zZ][_\s-]*\d+${AXIS_SEP})?` +
    String.raw`(?:${axis("xX")}${AXIS_SEP}${axis("yY")}|${axis("yY")}${AXIS_SEP}${axis("xX")})`,
  "g",
);
/** Three or more numbers joined by points: degrees, minutes and seconds that "marks"
 * wrote out ("42.23.48"), all of it and not just the first pair, or the seconds stay
 * behind ("‹n›.48"). A version number or an address goes with it. */
const DOTTED_CHAIN = /-?\d+(?:\s*\.\s*\d+){2,}/g;
/** A lone axis letter and its number ("x 4953"). An x after a number is not one:
 * "1920 x 1080" is a screen size, which is decided to stay. A y or z is, wherever
 * it is ("zoom 14 y 6060"). */
const AXIS_SPACED = /(?<![A-Za-z0-9])(?:[yzYZ]|(?<!\d\s+)[xX])\s+\d{3,}/g;
/** Degrees, minutes, seconds: 42°23'48"N 71°7'20"W. */
const DMS = /\d+\s*°(?:\s*\d+(?:\.\d+)?\s*['′’])?(?:\s*\d+(?:\.\d+)?\s*(?:"|″|''))?\s*[NSEW]?/gi;
/** A long run of digits: a tile index, an id, a phone number. Statuses (404),
 * line numbers and small counts are shorter, and so are not taken; nor are the
 * digits of a hex code ("0x80070005"), which is what tells two failures apart. A
 * hex code starts "0x" after a non-digit: "4250x4239677" is a number, an x and a
 * number, and its long half goes. */
const LONG_DIGITS = /(?<!(?:^|[^0-9])0[xX][0-9a-fA-F]*)\d{5,}/g;
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
 * characters, they hide a coordinate from a match. Every combining mark goes
 * too, spacing ones included ("42\u0301.3967", "42\u093e.3967" read as the
 * coordinate they are); the cost is that accents and vowel signs are lost from the
 * whole message, in any script, which is accepted for an error report. By class
 * where there is one: a hand-picked list had gaps (U+FFF9, the Mongolian
 * selectors), each a way to split "42.3967" so that nothing matched it. What is
 * listed by hand is what no class covers: fillers that render as blank (the Hangul
 * ones, U+3164 and U+FFA0, the Khmer inherent vowels) and the braille blank U+2800,
 * which looks like a space. */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE =
  /[\p{Cf}\p{M}\p{Variation_Selector}\u115f\u1160\u17b4\u17b5\u2028\u2029\u2800\u3164\uffa0]/gu;

/** The chunks this app builds, by name (reports/src/bundles.json): the base of
 * "app-BrmPk3gH.js". A shape ("a word, a hyphen, eight characters") can't tell a
 * bundle from "home-drkrqkrr-…", a place to within tens of metres in a name someone
 * chose, so a name is kept only if it is listed, and web/scripts/check-dist.mjs
 * fails the build when it makes a file that isn't covered. */
export const BUNDLE_BASES: readonly string[] = bundles.bases;
const FIXED_FILES = new Set<string>(bundles.fixed);
const HASHED = new RegExp(`^(?:${BUNDLE_BASES.map((b) => b.replace(/\./g, "\\.")).join("|")})-([A-Za-z0-9_-]{8})\\.m?js$`);
/** A listed name, and a hash that is Vite's: a capital in it (all but about one in
 * sixty), and nothing in it that scrubbing would take out. The hash is the only part
 * that isn't listed, and eight characters of [A-Za-z0-9_-] can hold a coordinate
 * ("app-L42_71xx.js"). A hash that trips the scrubber is a frame that loses its file
 * name in that build, a few percent of builds' chunks: the safe way to be wrong. */
function isBundle(file: string): boolean {
  if (FIXED_FILES.has(file)) return true;
  const hash = HASHED.exec(file)?.[1];
  return hash !== undefined && /[A-Z]/.test(hash) && scrub(file) === file;
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

/** Control and invisible characters, taken out. */
function strip(text: string): string {
  return text.replace(CONTROL, "").replace(INVISIBLE, "");
}

/** Digits and separators from other scripts as ASCII, so "٤٢٫٣٩٦٧" is matched
 * as the coordinate it is: `\d` is ASCII-only, and a phone set to Arabic or
 * Persian writes its numbers this way. The digits' values don't matter, only
 * that they are digits. */
function ascii(text: string): string {
  return (
    text
      // compatibility forms first: fullwidth digits and signs, superscripts, and the
      // like come out as the ASCII they stand for
      .normalize("NFKC")
      .replace(/\p{Nd}/gu, (d) => (/[0-9]/.test(d) ? d : "0"))
      // minus signs: "lon=\u221271" is a negative number
      .replace(/[\u2212\u2796\ufe63\uff0d]/g, "-")
      .replace(/[\u066b\u2396\uff0e\u2024\u2027\ufe52\u00b7\u3002\uff61\u2219\u22c5]/g, ".")
      .replace(/[\u066c\u060c\uff0c\ufe50\uff64\u3001]/g, ",")
  );
}

/** Punctuation set between two digits, with or without spaces around it, is a
 * decimal point, by class and not by list (U+0387, U+2E31 ...). Of the ASCII marks
 * only the ones coordinates are written with are: the apostrophe and quote of
 * degrees, minutes and seconds with no degree sign ("42'23'48"), and "*", which
 * stands in for the sign. '@', '&', '%' and the rest are not decimal points, and
 * "wang123@163.com" is an email address, which this must not break. Runs after
 * DMS, which wants its quotes as they were written. */
function marks(text: string): string {
  return text.replace(/(?<=\d)(\s*)([\p{Po}])(\s*)(?=\d)/gu, (m, _a: string, c: string) =>
    c.charCodeAt(0) < 0x80 && !`'"*`.includes(c) ? m : ".",
  );
}

/** Text with anything that could say where someone is, or who, taken out. */
export function scrub(text: string): string {
  // Stripped before and after the normalisation: before, so that nothing sits
  // between two digits and a mark when the marks are read as decimal points; after,
  // since normalising can make combining marks (U+FF9E becomes U+3099), which would
  // split a coordinate again.
  const plain = strip(ascii(strip(text)))
    .replace(URL_TEXT, (u) => urlToFile(u))
    .replace(EMAIL, "‹email›")
    .replace(ADDRESS, "‹address›")
    .replace(DMS, "‹n›");
  return marks(plain)
    .replace(DOTTED_CHAIN, "‹n›")
    // tiles before decimals: "z14_x4953_y6060.5" must go whole, not lose its
    // fraction first and leave "z14_x4953_y‹n›" behind
    .replace(TILE_AXES, "‹n›")
    .replace(TILE_RUN, "‹n›")
    // decimals before the labelled whole numbers: "lat 42 .3967" must lose its
    // fraction with it, not have "lat 42" taken and ".3967" left behind
    .replace(DECIMAL, "‹n›")
    .replace(AXIS_SPACED, "‹n›")
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
    // a number is a number whether the scrubber took it out or it was short. (A
    // message with a dotted chain in it, "120.0.6099", was scrubbed to "‹n›.6099" and
    // is scrubbed whole now, so it has a different fingerprint from the one an issue
    // filed under the old scrubber carries: a one-time duplicate for those, accepted;
    // they are version numbers, addresses and positions, and rarely a bug's message.)
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
