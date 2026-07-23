// Hazard reports: category + note + optional photo, stored on-device in
// IndexedDB (photos are too big for localStorage). Reports mark the spot as
// avoid-worthy for routing and can be shared out (city 311, email, chat).

export type HazardCategory = "surface" | "blocked" | "construction" | "traffic" | "other";

export const HAZARD_LABELS: Record<HazardCategory, string> = {
  surface: "broken surface / glass",
  blocked: "blocked lane or path",
  construction: "construction",
  traffic: "dangerous traffic spot",
  other: "other hazard",
};

export interface HazardReport {
  id: string;
  t: number;
  lon: number;
  lat: number;
  category: HazardCategory;
  note: string;
  hasPhoto: boolean;
}

interface StoredHazard extends HazardReport {
  photo: Blob | null;
}

const DB_NAME = "bike-hazards";
const STORE = "hazards";

function openDb(): Promise<IDBDatabase> {
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

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => {
          resolve(req.result);
        };
        req.onerror = () => {
          reject(req.error ?? new Error("indexeddb error"));
        };
      }),
  );
}

export async function addHazard(report: HazardReport, photo: Blob | null): Promise<void> {
  const stored: StoredHazard = { ...report, hasPhoto: photo !== null, photo };
  await tx("readwrite", (s) => s.put(stored));
}

export async function listHazards(): Promise<HazardReport[]> {
  const all = await tx<StoredHazard[]>("readonly", (s) => s.getAll() as IDBRequest<StoredHazard[]>);
  return all
    .map(({ photo, ...report }) => {
      void photo;
      return report;
    })
    .sort((a, b) => b.t - a.t);
}

export async function getHazardPhoto(id: string): Promise<Blob | null> {
  const stored = await tx<StoredHazard | undefined>(
    "readonly",
    (s) => s.get(id) as IDBRequest<StoredHazard | undefined>,
  );
  return stored?.photo ?? null;
}

export async function removeHazard(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** Human-readable report text for sharing (311, email, chat). */
export function buildReportText(report: HazardReport): string {
  const when = new Date(report.t).toLocaleString();
  const note = report.note.trim();
  return (
    `Bike hazard report: ${HAZARD_LABELS[report.category]}.` +
    (note ? ` ${note}.` : "") +
    ` Location: https://maps.google.com/?q=${report.lat.toFixed(6)},${report.lon.toFixed(6)}` +
    ` (${report.lat.toFixed(5)}, ${report.lon.toFixed(5)}), reported ${when}.` +
    ` Sent from the Family Bike Router (Greater Cambridge/Somerville).`
  );
}

/** Downscale a camera photo to keep on-device storage reasonable. */
export async function downscalePhoto(file: Blob, maxDim = 1280): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale >= 1) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return file;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => {
        resolve(b ?? file);
      }, "image/jpeg", 0.82);
    });
  } catch {
    return file;
  }
}
