import { PROFILES } from "./router.js";
export const CLASS_LABELS = {
    path: "off-street path",
    separated: "separated lane",
    buffered: "buffered lane",
    quiet_street: "quiet street",
    service: "alley/service",
    lane: "painted lane",
    sharrow: "sharrow",
    moderate_street: "moderate street",
    busy_street: "busy street",
};
/** What each class means for riding with kids, in plain words. */
export const CLASS_SAFETY = {
    path: "off-street — no car traffic at all",
    separated: "physically protected from car traffic",
    buffered: "painted buffer only — no physical protection",
    quiet_street: "low-traffic residential street, riding with cars",
    service: "alley / service way, occasional vehicles",
    lane: "paint only, directly beside moving traffic",
    sharrow: "shared with car traffic, marking only",
    moderate_street: "no bike facility, moderate traffic",
    busy_street: "no protection on a busy street",
};
export const GRADE_COLORS = {
    A: "#1a9850",
    B: "#66bd63",
    C: "#fdae61",
    D: "#f46d43",
    F: "#d73027",
};
/** Classes that represent an actual bike facility, as opposed to a road we
 * merely tolerate. Used to flag one that only OSM knows about. */
export const FACILITY_CLASSES = ["path", "separated", "buffered", "lane"];
/** Segment grade on the same kid-stress scale used for whole routes, or null if
 * we don't recognise the class.
 *
 * Null rather than a default grade on purpose: these properties come out of a
 * data file that a page may be a build behind, and an unlabelled street silently
 * falling through the comparisons came out as an F — the map telling a parent a
 * street is as bad as it gets when we simply don't know. */
export function classGrade(cls) {
    const m = PROFILES.young_kids.mult[cls];
    if (typeof m !== "number" || !Number.isFinite(m))
        return null;
    return m <= 1.6 ? "A" : m <= 2.4 ? "B" : m <= 4 ? "C" : m <= 8 ? "D" : "F";
}
/** Street names come from OpenStreetMap, which anyone can edit, and both pages
 * render this card through MapLibre's setHTML — i.e. innerHTML. A name of
 * `<img src=x onerror=...>` would then run script on the page's own origin,
 * where the rider's saved routes live. Escape anything that came from data. */
export function esc(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
/** The card shown for a street: grade, what it is, what that means for a child,
 * how far they'd detour to avoid it, and whether anyone has crashed there. */
export function segmentHtml(props, opts = { photo: false }) {
    const cls = props.cls;
    // a class we can't grade is a class we can't describe either: say nothing
    // rather than something confident and wrong
    const grade = cls !== undefined ? classGrade(cls) : null;
    const known = cls !== undefined && grade !== null;
    const label = known ? esc(CLASS_LABELS[cls] ?? cls) : "type unknown";
    const badge = grade !== null
        ? `<span style="background:${GRADE_COLORS[grade]};color:#fff;border-radius:5px;` +
            `padding:0 6px;font-weight:700">${grade}</span> `
        : "";
    const meaning = known ? `<br>${CLASS_SAFETY[cls]}` : "";
    const mult = known ? PROFILES.young_kids.mult[cls] : null;
    const stress = mult !== null
        ? `<br><small>kid-stress ×${mult} — young kids would detour up to ` +
            `${mult}× the distance to avoid ${mult > 1.6 ? "this" : "worse"}</small>`
        : "";
    const crashCount = props.crashes ?? 0;
    const crashes = crashCount > 0
        ? `<br><small>⚠ ${crashCount} bike crash${crashCount > 1 ? "es" : ""} ` +
            `recorded nearby (2021–26)</small>`
        : "";
    const unconfirmed = props.source === "osm" && known && FACILITY_CLASSES.includes(cls)
        ? "<br><small><i>facility per OSM only (not in official layers yet)</i></small>"
        : "";
    const photoSlot = opts.photo ? `<div data-seg-photo></div>` : "";
    const name = props.name !== undefined && props.name !== null && props.name !== ""
        ? props.name
        : "unnamed";
    return `${badge}<b>${esc(name)}</b><br>${label}${meaning}${stress}${crashes}${unconfirmed}${photoSlot}`;
}
const photoCache = new Map();
let photoGen = 0;
/** How far a street-level photo may be and still be *this* street. Beyond this
 * it is a picture of somewhere else, which is worse than showing none. */
const PHOTO_MAX_M = 60;
/** The Mapillary image nearest a point, or null if the nearest is too far to be
 * this street.
 *
 * Search wide, then choose by real distance. A ±44 m box finds a photo on only
 * some hovers: Mapillary filters bbox on the raw GPS fix while the refined
 * computed_geometry can sit tens of metres away, so nearby images fall outside
 * it. A wider box with a hard distance cap finds more of them and still never
 * shows a picture of the next street over.
 *
 * Shared so there is one answer to "which photo is of this place": the settings
 * preview in app.ts had its own copy and kept the old narrow-box, newest-wins
 * version of this after the card was fixed.
 */
/** When to stop asking after Mapillary pushes back.
 *
 * One token is shared by everyone using the published site, and it is rate
 * limited per token — so at any real number of users the answer to some hovers
 * is 429. Not caching that was right (a rate limit is not "there is no photo
 * here"), but it left every hover retrying into a limit that is still in force.
 * Back off instead, and lengthen the pause while it keeps failing.
 */
const PHOTO_BACKOFF_MS = [15000, 60000, 300000];
let photoPausedUntil = 0;
let photoFailures = 0;
/** Why there is no photo, when the reason isn't "nobody has taken one". */
export function photosPaused() {
    return Date.now() < photoPausedUntil;
}
export async function nearestMapillary(lon, lat, token, fields = "id,thumb_256_url,captured_at") {
    if (token === "")
        return null;
    // computed_geometry is how "nearest" is decided, so it is not the caller's to
    // forget: without it every image is Infinity away and this returns null for
    // everything, which looks exactly like "no photos here".
    const asked = fields.includes("computed_geometry")
        ? fields
        : `${fields},computed_geometry`;
    const d = 0.0015; // ~165 m to search
    const url = "https://graph.mapillary.com/images?" +
        new URLSearchParams({
            access_token: token,
            bbox: `${lon - d},${lat - d},${lon + d},${lat + d}`,
            fields: asked,
            limit: "20",
        }).toString();
    if (photosPaused())
        throw new Error("mapillary paused");
    const resp = await fetch(url);
    if (!resp.ok) {
        // 429 is the one we expect; treat any refusal the same way, since hammering
        // a service that just said no is how a shared token gets shut off entirely
        photoFailures++;
        const wait = PHOTO_BACKOFF_MS[Math.min(photoFailures - 1, PHOTO_BACKOFF_MS.length - 1)] ?? 0;
        photoPausedUntil = Date.now() + wait;
        throw new Error(`mapillary ${resp.status}`);
    }
    photoFailures = 0;
    photoPausedUntil = 0;
    const data = (await resp.json());
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const nearest = data.data
        .map((im) => {
        const c = im.computed_geometry?.coordinates;
        const away = c === undefined ? Infinity : Math.hypot((c[0] - lon) * kx, (c[1] - lat) * 110540);
        return { im, away };
    })
        .filter((x) => x.away <= PHOTO_MAX_M)
        .sort((a, b) => a.away - b.away)[0];
    return nearest?.im ?? null;
}
/** Street-level photo nearest a point, or nulls.
 *
 * Cached per ~22 m cell: hovering a street fires this repeatedly, and the same
 * stretch of road shouldn't cost a request per pixel. */
export async function fetchSegmentPhoto(lon, lat, token) {
    if (token === "")
        return { url: null, captured: null };
    // A coarse cell would let a cached photo stand in for a point most of a cell
    // away, on top of the PHOTO_MAX_M cap — the two errors add up. ~22 m keeps
    // the total inside a block.
    const key = `${Math.round(lon / 0.0002)},${Math.round(lat / 0.0002)}`;
    const cached = photoCache.get(key);
    if (cached !== undefined)
        return cached;
    const gen = photoGen;
    let result = { url: null, captured: null };
    try {
        const near = await nearestMapillary(lon, lat, token);
        result = { url: near?.thumb_256_url ?? null, captured: near?.captured_at ?? null };
    }
    catch {
        // A rate limit or a dropped connection is not "there is no photo of this
        // street". Answer without one, but don't remember it — caching the failure
        // makes one 429 while panning turn into a permanently photo-less block for
        // the rest of the session.
        return { url: null, captured: null };
    }
    if (gen === photoGen)
        photoCache.set(key, result);
    return result;
}
/** Forget every looked-up photo. Called when the Mapillary token changes: the
 * cache holds misses fetched with the old token, and keeping them means a
 * corrected token shows no photos until the page is reloaded. */
export function clearPhotoCache() {
    photoCache.clear();
    // and the back-off: a pause earned by the old token shouldn't outlive it
    photoPausedUntil = 0;
    photoFailures = 0;
    // Bump the generation too. Clearing the map doesn't touch a lookup already in
    // flight, and when that one resolves it writes the old token's answer into
    // the fresh cache — so correcting a bad token still showed no photos.
    photoGen++;
}
/** Fill a card's photo slot once the image resolves, if the card is still up. */
export function fillSegmentPhoto(slotOwner, lon, lat, token, stillWanted) {
    if (!slotOwner || token === "")
        return;
    void fetchSegmentPhoto(lon, lat, token).then(({ url, captured }) => {
        if (!stillWanted())
            return; // the pointer moved on
        const slot = slotOwner.querySelector("div[data-seg-photo]");
        if (!slot || !slot.isConnected)
            return;
        if (url === null) {
            // "no photo here" is a claim about the world; when we simply stopped
            // asking, it isn't one we can make
            slot.innerHTML = photosPaused()
                ? `<small><i>street-level photos are rate-limited right now</i></small>`
                : `<small><i>no street-level photo here</i></small>`;
            return;
        }
        const when = captured !== null ? ` <small>${new Date(captured).toLocaleDateString()}</small>` : "";
        slot.innerHTML =
            `<img src="${esc(url)}" alt="" style="max-width:210px;border-radius:6px;display:block;` +
                `margin-top:4px">📷${when}`;
    });
}
