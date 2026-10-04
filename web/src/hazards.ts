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

// ---------------------------------------------------------------------------
// The mirror: every report's text and place, photo excluded, in localStorage.
//
// It exists so the reports can go into the backup file (places.ts), whose
// export and import are synchronous and read localStorage. Without it the
// backup carried saved places and marks but not a single hazard — and the
// backup is the only thing that survives what wipes this device's storage:
// uninstalling the app, or Safari deleting a site's data after seven days
// without a visit when it is not installed to the home screen.
//
// Photos stay out. They are downscaled JPEGs of a few hundred KB each, and as
// base64 in a JSON file a handful would outweigh everything else in it many
// times over — and localStorage's ~5 MB could not hold the mirror at all. What
// a report needs to go on changing routes is where it is and what it is; the
// photo was evidence for whoever it was sent to. A restored report comes back
// without one, and says so (hasPhoto: false).
//
// The mirror and IndexedDB are reconciled on every listHazards() as a union:
// a report only in the mirror was restored from a backup and is written back
// to IndexedDB; a report only in IndexedDB predates the mirror and is added to
// it. Deleting removes from both, so nothing comes back on its own.
// ---------------------------------------------------------------------------

export const HAZARD_MIRROR_KEY = "hazardReports";

function readMirror(): HazardReport[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(HAZARD_MIRROR_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HazardReport[]).filter(isReport) : [];
  } catch {
    return [];
  }
}

function writeMirror(reports: HazardReport[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(HAZARD_MIRROR_KEY, JSON.stringify(reports));
  } catch {
    // storage full or blocked: the reports themselves are safe in IndexedDB
  }
}

/** A backup file is edited by hand as often as not; take only what parses. */
function isReport(r: unknown): r is HazardReport {
  const h = r as Partial<HazardReport> | null;
  return (
    h !== null &&
    typeof h === "object" &&
    typeof h.id === "string" &&
    typeof h.t === "number" &&
    typeof h.lon === "number" &&
    typeof h.lat === "number" &&
    typeof h.category === "string" &&
    h.category in HAZARD_LABELS &&
    typeof h.note === "string"
  );
}

const withoutPhoto = ({ photo, ...report }: StoredHazard): HazardReport => {
  void photo;
  return report;
};

function mirrorUpsert(report: HazardReport): void {
  writeMirror([...readMirror().filter((r) => r.id !== report.id), report]);
}

export async function addHazard(report: HazardReport, photo: Blob | null): Promise<void> {
  const stored: StoredHazard = { ...report, hasPhoto: photo !== null, photo };
  await tx("readwrite", (s) => s.put(stored));
  mirrorUpsert(withoutPhoto(stored));
}

export async function listHazards(): Promise<HazardReport[]> {
  let all: HazardReport[];
  try {
    all = (await tx<StoredHazard[]>("readonly", (s) => s.getAll() as IDBRequest<StoredHazard[]>)).map(
      withoutPhoto,
    );
  } catch {
    // IndexedDB won't open (site data blocked, a private window, a full disk). What is
    // left of the rider's reports is the mirror, text and place without the photos:
    // routes should still avoid them, and the map still show them. The mirror is
    // written whenever a report is filed or read, so an empty one means none are known:
    // for a rider who has never filed one, in a browser that blocks storage, that is the
    // ordinary case and not an error.
    return readMirror()
      .map((r) => ({ ...r, hasPhoto: false }))
      .sort((x, y) => y.t - x.t);
  }
  const mirror = readMirror();
  const known = new Set(all.map((r) => r.id));
  const restored = mirror
    .filter((r) => !known.has(r.id))
    .map((r) => ({ ...r, hasPhoto: false }));
  for (const r of restored) {
    await tx("readwrite", (s) => s.put({ ...r, photo: null } satisfies StoredHazard));
  }
  const union = [...all, ...restored];
  const mirrored = new Set(mirror.map((r) => r.id));
  if (restored.length > 0 || union.some((r) => !mirrored.has(r.id))) writeMirror(union);
  return union.sort((a, b) => b.t - a.t);
}

export async function getHazardPhoto(id: string): Promise<Blob | null> {
  const stored = await tx<StoredHazard | undefined>(
    "readonly",
    (s) => s.get(id) as IDBRequest<StoredHazard | undefined>,
  );
  return stored?.photo ?? null;
}

/** Set the category of an already-filed report.
 *
 * Reporting mid-ride files the position first and asks what it was afterwards,
 * so the answer arrives after the record does. Missing reports are ignored: the
 * rider may have let the question time out and deleted the mark. */
export async function setHazardCategory(id: string, category: HazardCategory): Promise<void> {
  const stored = await tx<StoredHazard | undefined>(
    "readonly",
    (s) => s.get(id) as IDBRequest<StoredHazard | undefined>,
  );
  if (!stored) return;
  const updated = { ...stored, category };
  await tx("readwrite", (s) => s.put(updated));
  mirrorUpsert(withoutPhoto(updated));
}

export async function removeHazard(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
  writeMirror(readMirror().filter((r) => r.id !== id));
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
