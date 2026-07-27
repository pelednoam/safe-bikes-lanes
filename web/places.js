// Saved places (tagged locations like Home/Work) and recent route history.
// Everything lives in localStorage on the device.
const PLACES_KEY = "savedPlaces";
const RECENT_KEY = "recentRoutes";
const MAX_RECENT = 8;
const EMOJI_RULES = [
    [/home|house/i, "🏠"],
    [/work|office/i, "💼"],
    [/school|daycare|kinder/i, "🏫"],
    [/park|playground/i, "🛝"],
    [/grand|savta|saba|oma|opa/i, "👵"],
    [/pool|swim/i, "🏊"],
    [/library/i, "📚"],
    [/friend/i, "🧑‍🤝‍🧑"],
];
/** Pick a fitting emoji for a place name (📍 when nothing matches). */
export function emojiFor(name) {
    for (const [pattern, emoji] of EMOJI_RULES) {
        if (pattern.test(name))
            return emoji;
    }
    return "📍";
}
function load(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? [] : JSON.parse(raw);
    }
    catch {
        return [];
    }
}
export function listPlaces() {
    return load(PLACES_KEY);
}
export function savePlace(place) {
    const places = listPlaces().filter((p) => p.name !== place.name);
    places.push(place);
    places.sort((a, b) => a.name.localeCompare(b.name));
    localStorage.setItem(PLACES_KEY, JSON.stringify(places));
    return places;
}
export function deletePlace(name) {
    const places = listPlaces().filter((p) => p.name !== name);
    localStorage.setItem(PLACES_KEY, JSON.stringify(places));
    return places;
}
/** Pure recent-list update: newest first, deduped by endpoints (~30 m), capped. */
export function recentWithNew(list, entry) {
    const near = (a, b) => Math.abs(a[0] - b[0]) < 0.0004 && Math.abs(a[1] - b[1]) < 0.0003;
    const rest = list.filter((r) => !(near(r.s, entry.s) && near(r.e, entry.e)));
    return [entry, ...rest].slice(0, MAX_RECENT);
}
export function listRecent() {
    return load(RECENT_KEY);
}
export function pushRecent(entry) {
    const updated = recentWithNew(listRecent(), entry);
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    return updated;
}
export function clearRecent() {
    localStorage.removeItem(RECENT_KEY);
}
// ---------------------------------------------------------------------------
// backup / restore
// ---------------------------------------------------------------------------
/** Everything the rider has taught the app, kept on the device. Uninstalling
 * the Android app wipes it (which is how saved places used to vanish on every
 * update, back when each APK had a throwaway signature and could only be
 * installed over the top by uninstalling first). */
const BACKUP_KEYS = [
    "savedPlaces",
    "recentRoutes",
    "sketchyMarks",
    "rideHistory",
    "avoidTypes",
    "walkMaxM",
    "navMyWay",
    "darkMode",
];
export function exportBackup(nowIso) {
    const data = {};
    for (const key of BACKUP_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null)
            data[key] = value;
    }
    return { app: "family-bike-router", saved: nowIso, data };
}
/** Restore a backup, returning how many entries were written. Unknown keys are
 * ignored so a hand-edited or future file can't write arbitrary storage. */
export function importBackup(raw) {
    const backup = raw;
    if (!backup || backup.app !== "family-bike-router" || typeof backup.data !== "object") {
        throw new Error("not a Family Bike Router backup");
    }
    const data = backup.data;
    let written = 0;
    for (const key of BACKUP_KEYS) {
        const value = data[key];
        if (typeof value === "string") {
            localStorage.setItem(key, value);
            written++;
        }
    }
    return written;
}
