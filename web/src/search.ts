// Ranking for the destination search box.
//
// The old search waited for three characters, waited 400 ms more, then asked
// Nominatim for five results. Nominatim is a geocoder, not an autocomplete: it
// is donated infrastructure, it is slow by design, and it wants a well-formed
// address. Typing "mass ave" or "the playground on Elm" got you nothing, and
// nothing arrived at all until you stopped typing.
//
// Meanwhile the app already ships what a parent is usually looking for: 2,500
// named schools, playgrounds, libraries and water fountains, the street names of
// the whole network, and their own saved places. All of it on the device. So the
// list fills from local data as you type — instantly, and offline — and the
// geocoder's answers are merged in when they arrive, for the house numbers and
// businesses only it knows.
//
// This module is the part worth testing: what matches, and in what order.

/** Where a candidate came from. Order matters for ties — a place someone saved
 * beats a street with the same name, because they told us it mattered. */
export type SearchSource = "place" | "recent" | "poi" | "street" | "geocoder";

export interface Candidate {
  name: string;
  lon: number;
  lat: number;
  source: SearchSource;
  /** "playground", "school", "quiet street" — shown as context, not matched on. */
  kind?: string;
  /** The second line: what this is, or where. Only the geocoder fills it — the
   * local sources have no town for a POI, so their rows say kind and distance. */
  context?: string;
  /** Extra text to match against without showing it.
   *
   * The geocoder's short name is "123" for a house number and "Bakery" for a shop;
   * the address lives in display_name. Scoring the short name alone dropped every
   * address query — the one thing the geocoder is kept for. */
  match?: string;
}

export interface Ranked extends Candidate {
  /** Metres from the origin, when one was given. */
  distanceM?: number;
}

/** Street-name abbreviations, both directions.
 *
 * Nobody types "Massachusetts Avenue". They type "mass ave", and both halves
 * need expanding: the query's, and the candidate's when OSM abbreviated it.
 */
const ABBREVIATIONS: Record<string, string> = {
  st: "street",
  str: "street",
  ave: "avenue",
  av: "avenue",
  rd: "road",
  blvd: "boulevard",
  pkwy: "parkway",
  pky: "parkway",
  hwy: "highway",
  ln: "lane",
  dr: "drive",
  ct: "court",
  cir: "circle",
  pl: "place",
  sq: "square",
  ter: "terrace",
  trl: "trail",
  mass: "massachusetts",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
  mt: "mount",
  ft: "fort",
  jr: "junior",
  sr: "senior",
  elem: "elementary",
  hs: "high school",
  ms: "middle school",
  univ: "university",
  ctr: "center",
  pk: "park",
};

/** Words that carry no discrimination and shouldn't sink a match by being absent. */
const FILLER = new Set(["the", "a", "an", "of", "at", "on", "in", "and", "to"]);

/** One comparable form for a query and a candidate.
 *
 * Lowercased, accents folded, punctuation dropped, abbreviations expanded, filler
 * removed. Done to both sides so "Mass. Ave" and "Massachusetts Avenue" meet in
 * the middle rather than one being rewritten into the other's shape.
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks, so "Poznań" answers "poznan"
    // Apostrophes close up rather than splitting: "St. Peter's" became
    // "st peter s", and a lone "s" then expanded to "south" through the
    // direction table. A possessive is part of its word.
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "")
    .flatMap((w) => (ABBREVIATIONS[w] ?? w).split(" "))
    .filter((w) => !FILLER.has(w));
}

export function normalise(text: string): string {
  return words(text).join(" ");
}

/** How well a candidate answers the query, 0 for "not an answer at all".
 *
 * Tiered rather than fuzzy. A fuzzy score puts a bad match at the top when
 * nothing good exists, and for a destination that is worse than an empty list:
 * you would ride to it.
 */
/** Words without the abbreviation table applied. */
function rawWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "" && !FILLER.has(w));
}

/** A name's words with a leading "St" read as "Saint".
 *
 * "St" is "Street" at the end of a name and "Saint" in front of one, and the
 * abbreviation table can only choose one. Twenty-four shipped POIs are saints, so
 * "saint peter" has to find "St Peter School".
 */
function saintWords(text: string): string[] {
  const raw = rawWords(text);
  return raw.map((w, i) => (w === "st" && i < raw.length - 1 ? "saint" : w));
}

export function matchScore(query: string, name: string): number {
  // Scored two ways, taking whichever fits better.
  //
  // Expanded, because nobody types "Massachusetts Avenue". And literal, because
  // expansion is destructive: a lone "s" became "south", so four letters of the
  // alphabet stopped answering from the first letter.
  //
  // The literal form is saintWords rather than plain rawWords: it is the same words
  // with a leading "St" read as "Saint", which is what "St" means in front of a name
  // and not what the abbreviation table can express. A third variant with plain
  // rawWords sat here and could not change any outcome — every case it caught, one
  // of these two caught too.
  return Math.max(score(words(query), words(name)), score(saintWords(query), saintWords(name)));
}

function score(q: string[], n: string[]): number {
  if (q.length === 0 || n.length === 0) return 0;
  const qs = q.join(" ");
  const ns = n.join(" ");

  // Tiers are 100 apart and the bonuses in rank() total at most 16, so no amount
  // of proximity or source preference can promote a worse name match above a
  // better one. They used to be 10 apart (100/90/75/60/40) while the bonuses
  // reached 16 — which made the module's central claim false: a nearby saved place
  // matching loosely could outrank an exact match further away.
  if (qs === ns) return 1000;
  if (ns.startsWith(qs)) return 900; // "elm" -> "Elm Street"
  // every query word begins a name word, in order: "mass ave" -> "Massachusetts Avenue"
  let at = 0;
  let ordered = true;
  for (const qw of q) {
    const found = n.findIndex((nw, i) => i >= at && nw.startsWith(qw));
    if (found === -1) {
      ordered = false;
      break;
    }
    at = found + 1;
  }
  if (ordered) return 750;
  // same words, any order: "school elm" -> "Elm Street School"
  if (q.every((qw) => n.some((nw) => nw.startsWith(qw)))) return 600;
  // a word begins somewhere inside a name word: "vard" in "Harvard"
  if (q.length === 1 && ns.includes(qs)) return 400;
  return 0;
}

const EARTH_M = 6_371_000;

/** Metres between two lon/lat points, near enough at city scale. */
export function metresBetween(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad * Math.cos(((a[1] + b[1]) / 2) * toRad);
  return Math.hypot(dLat, dLon) * EARTH_M;
}

/** Ties broken towards what the reader more likely meant. */
const SOURCE_BONUS: Record<SearchSource, number> = {
  place: 8, // they named it themselves
  recent: 6, // they have been there
  poi: 3, // a school or playground, which is usually the errand
  street: 1,
  geocoder: 0,
};

export interface RankOptions {
  /** Where the rider is starting from, for "nearest first". */
  origin?: [number, number] | undefined;
  limit?: number;
}

/**
 * The list as shown: matches only, best first, one row per place.
 *
 * Proximity is a tiebreaker inside a match tier and never crosses one — a
 * playground 20 m away is not a better answer to "Elm Street" than Elm Street
 * itself. Within a tier it dominates, because in a city there are four Elm
 * Streets and you meant the near one.
 *
 * The cost of that rule, chosen deliberately: typing "elm" offers a street called
 * exactly "Elm" 7 km away above "Elm Street" 2 km away. Predictability is worth
 * more here than being right about which one someone meant — the list shows both
 * with their distances, and a rule that sometimes lets distance win would make the
 * top row unguessable.
 */
export function rank(query: string, candidates: Candidate[], opts: RankOptions = {}): Ranked[] {
  const limit = opts.limit ?? 8;
  const scored: { row: Ranked; score: number }[] = [];

  for (const c of candidates) {
    const m = Math.max(
      matchScore(query, c.name),
      c.match === undefined ? 0 : matchScore(query, c.match),
    );
    if (m === 0) continue;
    const distanceM =
      opts.origin === undefined ? undefined : metresBetween(opts.origin, [c.lon, c.lat]);
    // 0 at the origin, falling away over a few km — enough to order a tier,
    // never enough to outrank a better-matching name
    const near = distanceM === undefined ? 0 : 8 / (1 + distanceM / 1500);
    scored.push({
      row: distanceM === undefined ? { ...c } : { ...c, distanceM },
      score: m + near + SOURCE_BONUS[c.source],
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // One row per place. The same school arrives from the local index and from the
  // geocoder, and two rows for one destination is a worse list than one row.
  const out: Ranked[] = [];
  for (const { row } of scored) {
    const key = normalise(row.name);
    // Same name, near enough to be the same place — and how near depends on what it
    // is. A street arrives as many segments spread along its length, so pieces of
    // one street have to rejoin generously; two shops sharing a name 200 m apart
    // are two destinations, and folding them together would hide one.
    //
    // (There was a second check on a rounded coordinate key under this one. It
    // compared the same rows on a ~33 m grid, which this test already subsumes, so
    // it could never fire.)
    const sameNameRadiusM = row.source === "street" ? 700 : 120;
    const duplicate = out.some(
      (o) =>
        normalise(o.name) === key &&
        metresBetween([o.lon, o.lat], [row.lon, row.lat]) <
          (o.source === "street" ? 700 : sameNameRadiusM),
    );
    if (duplicate) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** The second line of a row: what this is, and how far. */
export function describe(row: Ranked, fmtDist: (m: number) => string): string {
  const bits: string[] = [];
  if (row.kind !== undefined && row.kind !== "") bits.push(row.kind);
  if (row.context !== undefined && row.context !== "") bits.push(row.context);
  // "as the crow flies", because the same line is replaced moments later by the
  // route's own distance and time. Two different numbers in one slot, and only one
  // of them says which it is, is how a reader plans for the wrong distance.
  if (row.distanceM !== undefined) bits.push(`${fmtDist(row.distanceM)} as the crow flies`);
  return bits.join(" · ");
}

// ── when to ask the geocoder ───────────────────────────────────────────────
//
// Nominatim asks for at most one request per second and says plainly that it is
// not for autocomplete. The first version of this search debounced at 250 ms and
// fired from the third character, which is exactly the pattern it asks people not
// to send — to a service that is donated.
//
// These two decisions are the policy. They live here, as functions of their
// inputs, because the alternative is asserting them through wall-clock timing in a
// browser: the request offsets there vary by more than a second between runs on
// the same machine, so such a test is both flaky and unable to tell whether the
// policy exists at all.

/** How long a query must have been still before the geocoder is asked. */
export const GEOCODE_DEBOUNCE_MS = 700;
/** The floor between two requests. Slightly over a second, to stay inside 1/s. */
export const GEOCODE_MIN_GAP_MS = 1_100;

/**
 * Whether this query is worth spending a geocoder request on.
 *
 * Addresses and businesses are what it knows and the local index does not. A query
 * the device already answered does not need the network, and a short fragment is
 * somebody still typing.
 */
export function worthGeocoding(query: string, localHits: number): boolean {
  const q = query.trim();
  if (q.length < 4) return false;
  if (/\d/.test(q)) return true; // a house number: only the geocoder has these
  return localHits < 3; // otherwise only when the device came up short
}

/**
 * Milliseconds to wait before asking, given when we last did.
 *
 * 0 means now. Anything else is how long until the floor has passed — the caller
 * waits and asks again rather than dropping the query, so a fast typist gets a
 * late answer instead of no answer.
 */
export function geocodeDelayMs(now: number, lastAt: number): number {
  const since = now - lastAt;
  if (since >= GEOCODE_MIN_GAP_MS) return 0;
  // Clamped, because `since` can be negative: Date.now() moves backwards when the
  // clock is corrected or the device wakes from sleep, and the unclamped form then
  // returned an eleven-second wait — the search would quietly stop asking the
  // geocoder anything at all for as long as the jump was large.
  return Math.min(GEOCODE_MIN_GAP_MS, GEOCODE_MIN_GAP_MS - since);
}
