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
/** Street-name abbreviations, both directions.
 *
 * Nobody types "Massachusetts Avenue". They type "mass ave", and both halves
 * need expanding: the query's, and the candidate's when OSM abbreviated it.
 */
const ABBREVIATIONS = {
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
export function words(text) {
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
export function normalise(text) {
    return words(text).join(" ");
}
/** How well a candidate answers the query, 0 for "not an answer at all".
 *
 * Tiered rather than fuzzy. A fuzzy score puts a bad match at the top when
 * nothing good exists, and for a destination that is worse than an empty list:
 * you would ride to it.
 */
export function matchScore(query, name) {
    const q = words(query);
    const n = words(name);
    if (q.length === 0 || n.length === 0)
        return 0;
    const qs = q.join(" ");
    const ns = n.join(" ");
    if (qs === ns)
        return 100;
    if (ns.startsWith(qs))
        return 90; // "elm" -> "Elm Street"
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
    if (ordered)
        return 75;
    // same words, any order: "school elm" -> "Elm Street School"
    if (q.every((qw) => n.some((nw) => nw.startsWith(qw))))
        return 60;
    // a word begins somewhere inside a name word: "vard" in "Harvard"
    if (q.length === 1 && ns.includes(qs))
        return 40;
    return 0;
}
const EARTH_M = 6371000;
/** Metres between two lon/lat points, near enough at city scale. */
export function metresBetween(a, b) {
    const toRad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toRad;
    const dLon = (b[0] - a[0]) * toRad * Math.cos(((a[1] + b[1]) / 2) * toRad);
    return Math.hypot(dLat, dLon) * EARTH_M;
}
/** Ties broken towards what the reader more likely meant. */
const SOURCE_BONUS = {
    place: 8, // they named it themselves
    recent: 6, // they have been there
    poi: 3, // a school or playground, which is usually the errand
    street: 1,
    geocoder: 0,
};
/**
 * The list as shown: matches only, best first, one row per place.
 *
 * Proximity is a tiebreaker inside a match tier and never crosses one — a
 * playground 20 m away is not a better answer to "Elm Street" than Elm Street
 * itself. Within a tier it dominates, because in a city there are four Elm
 * Streets and you meant the near one.
 */
export function rank(query, candidates, opts = {}) {
    const limit = opts.limit ?? 8;
    const scored = [];
    for (const c of candidates) {
        const m = matchScore(query, c.name);
        if (m === 0)
            continue;
        const distanceM = opts.origin === undefined ? undefined : metresBetween(opts.origin, [c.lon, c.lat]);
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
    const out = [];
    const seen = new Set();
    for (const { row } of scored) {
        const key = normalise(row.name);
        const near = out.find((o) => normalise(o.name) === key && metresBetween([o.lon, o.lat], [row.lon, row.lat]) < 250);
        if (near !== undefined)
            continue;
        if (seen.has(`${key}|${Math.round(row.lon * 3000)}|${Math.round(row.lat * 3000)}`))
            continue;
        seen.add(`${key}|${Math.round(row.lon * 3000)}|${Math.round(row.lat * 3000)}`);
        out.push(row);
        if (out.length >= limit)
            break;
    }
    return out;
}
/** The second line of a row: what this is, and how far. */
export function describe(row, fmtDist) {
    const bits = [];
    if (row.kind !== undefined && row.kind !== "")
        bits.push(row.kind);
    if (row.context !== undefined && row.context !== "")
        bits.push(row.context);
    if (row.distanceM !== undefined)
        bits.push(`${fmtDist(row.distanceM)} away`);
    return bits.join(" · ");
}
