// Hazard reports: category + note + optional photo, stored on-device in
// IndexedDB (photos are too big for localStorage). Reports mark the spot as
// avoid-worthy for routing and can be shared out (city 311, email, chat).
export const HAZARD_LABELS = {
    surface: "broken surface / glass",
    blocked: "blocked lane or path",
    construction: "construction",
    traffic: "dangerous traffic spot",
    other: "other hazard",
};
const DB_NAME = "bike-hazards";
const STORE = "hazards";
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE, { keyPath: "id" });
        };
        req.onsuccess = () => {
            resolve(req.result);
        };
        req.onerror = () => {
            reject(req.error ?? new Error("indexeddb unavailable"));
        };
    });
}
function tx(mode, run) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => {
            resolve(req.result);
        };
        req.onerror = () => {
            reject(req.error ?? new Error("indexeddb error"));
        };
    }));
}
export async function addHazard(report, photo) {
    const stored = { ...report, hasPhoto: photo !== null, photo };
    await tx("readwrite", (s) => s.put(stored));
}
export async function listHazards() {
    const all = await tx("readonly", (s) => s.getAll());
    return all
        .map(({ photo, ...report }) => {
        void photo;
        return report;
    })
        .sort((a, b) => b.t - a.t);
}
export async function getHazardPhoto(id) {
    const stored = await tx("readonly", (s) => s.get(id));
    return stored?.photo ?? null;
}
export async function removeHazard(id) {
    await tx("readwrite", (s) => s.delete(id));
}
/** Human-readable report text for sharing (311, email, chat). */
export function buildReportText(report) {
    const when = new Date(report.t).toLocaleString();
    const note = report.note.trim();
    return (`Bike hazard report: ${HAZARD_LABELS[report.category]}.` +
        (note ? ` ${note}.` : "") +
        ` Location: https://maps.google.com/?q=${report.lat.toFixed(6)},${report.lon.toFixed(6)}` +
        ` (${report.lat.toFixed(5)}, ${report.lon.toFixed(5)}), reported ${when}.` +
        ` Sent from the Family Bike Router (Cambridge/Somerville).`);
}
/** Downscale a camera photo to keep on-device storage reasonable. */
export async function downscalePhoto(file, maxDim = 1280) {
    try {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
        if (scale >= 1)
            return file;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        const ctx = canvas.getContext("2d");
        if (ctx === null)
            return file;
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve) => {
            canvas.toBlob((b) => {
                resolve(b ?? file);
            }, "image/jpeg", 0.82);
        });
    }
    catch {
        return file;
    }
}
