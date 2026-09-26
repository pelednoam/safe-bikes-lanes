// localStorage, without the exceptions.
//
// Every access can throw: a full store refuses writes (QuotaExceededError), and
// with site data blocked — cookies off, some private modes, some embedded
// browsers — even reading throws (SecurityError). app.ts read two preferences
// at module level with no guard, so on such a browser the whole module aborted
// on load and the page was a blank map with nothing wired to it.
/** The stored string, or null when there is none or storage is unavailable. */
export function readItem(key) {
    try {
        return localStorage.getItem(key);
    }
    catch {
        return null;
    }
}
/** Store a string. False when storage refused it (full or blocked); the
 * preference then lasts only as long as the page. */
export function writeItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    }
    catch {
        return false;
    }
}
export function removeItem(key) {
    try {
        localStorage.removeItem(key);
    }
    catch {
        // blocked: there is nothing stored to remove
    }
}
/** Parsed JSON, or `fallback` when missing, unreadable or corrupt. */
export function readJson(key, fallback) {
    const raw = readItem(key);
    if (raw === null)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
/** The newest `max` entries of a cache kept as a plain object, in insertion
 * order — which for keys that are not array indices is the order they were
 * first added, so the ones dropped are the ones added longest ago. */
export function trimRecord(record, max) {
    const keys = Object.keys(record);
    if (keys.length <= max)
        return record;
    const kept = {};
    for (const k of keys.slice(keys.length - max))
        kept[k] = record[k];
    return kept;
}
