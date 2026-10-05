// Hazard reports: the dialog to file one with a photo, reading them from the device
// and telling the router and the map, and the one-tap report from the bike with its
// what-was-it row.

import { links } from "./links.js";
import { newestWins } from "../newest.js";
import { PhotoUrls } from "../photourls.js";
import { addHazard, CLOSURE_LIFETIME_MS, buildReportText, downscalePhoto, getHazardPhoto, HAZARD_LABELS, type HazardCategory, type HazardReport, listHazards, removeHazard, setHazardCategory, StoreUnavailable } from "../hazards.js";
import { reportCaught } from "../report.js";
import { store } from "./store.js";
import { applyAvoidPoints } from "./avoid.js";
import { map } from "./map.js";
import { type GeoJSONSource } from "maplibre-gl";
import { el } from "./dom.js";
import { hereLabel } from "./nav-camera.js";
import { nav } from "./nav-state.js";
import { flashRideAlert, freshFix } from "./nav-banner.js";
import { distM } from "../nav.js";
import { speak, vibrate } from "./nav-voice.js";
import { requestRoute } from "./plan-route.js";
import { reportBlocked } from "./hazard-blocked.js";

let hazardPendingLoc: [number, number] | null = null;

let hazardPhoto: Blob | null = null;

/** The hazard reports' photos as the hover card shows them (src/photourls.ts):
 * read from the device once per report, tried again if a read failed, and let
 * go with the report. */
export const hazardPhotos = new PhotoUrls(getHazardPhoto);

/** Read the hazards on the device and tell the router and the map. Only the newest read
 * is applied (a slow older read must not put an older list back over a backup restore's),
 * and a caller is released when the newest has been (see src/newest.ts). */
export const refreshHazards = newestWins(applyHazards);

async function applyHazards(isCurrent: () => boolean): Promise<void> {
  let list: HazardReport[];
  try {
    list = await listHazards();
  } catch (err) {
    // Nothing could be read: not the same as nothing reported. What the router and the map
    // already have stays, since replacing a list that is known with an empty one would take
    // every hazard and closure out of the next route, mid-ride included. A store that is
    // simply unavailable (blocked site data, nothing mirrored) is not worth a report; any
    // other failure is.
    if (!(err instanceof StoreUnavailable)) reportCaught("error", err);
    return;
  }
  if (!isCurrent()) return;
  // what the device store has, and what was filed this session and is not in it (yet)
  const now = Date.now();
  const stored = new Set(list.map((h) => h.id));
  store.pendingHazards = store.pendingHazards.filter((h) => !stored.has(h.id) && now - h.t < CLOSURE_LIFETIME_MS);
  store.hazards = [...store.pendingHazards, ...list];
  applyAvoidPoints();
  hazardPhotos.prune(new Set(store.hazards.filter((h) => h.hasPhoto).map((h) => h.id)));
  const features = store.hazards.map((h) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [h.lon, h.lat] },
    properties: { id: h.id, category: h.category, note: h.note, t: h.t, hasPhoto: h.hasPhoto },
  }));
  const src = map.getSource("hazardpts");
  if (src) {
    (src as GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    } as GeoJSON.GeoJSON);
  }
}

export function openHazardDialog(lon: number, lat: number): void {
  hazardPendingLoc = [lon, lat];
  hazardPhoto = null;
  el<HTMLSelectElement>("hazard-category").value = "surface";
  el<HTMLInputElement>("hazard-note").value = "";
  el<HTMLInputElement>("hazard-photo").value = "";
  const preview = el<HTMLImageElement>("hazard-preview");
  preview.style.display = "none";
  preview.src = "";
  const where = el<HTMLDivElement>("hazard-loc");
  const note = " — saved reports appear on the map and routes avoid them";
  where.textContent = `here${note}`;
  // named as soon as the router says what kind of way this is, if the dialog
  // is still about this spot by then
  void hereLabel(lon, lat).then((label) => {
    if (hazardPendingLoc?.[0] === lon && hazardPendingLoc[1] === lat) {
      where.textContent = `${label}${note}`;
    }
  });
  el<HTMLDialogElement>("hazard").showModal();
}

function pendingHazardReport(): HazardReport | null {
  if (!hazardPendingLoc) return null;
  return {
    id: `${Date.now()}`,
    t: Date.now(),
    lon: hazardPendingLoc[0],
    lat: hazardPendingLoc[1],
    category: el<HTMLSelectElement>("hazard-category").value as HazardCategory,
    note: el<HTMLInputElement>("hazard-note").value,
    hasPhoto: hazardPhoto !== null,
  };
}

let classifyId: string | null = null;

let classifyTimer: number | undefined;

export function hideClassify(): void {
  window.clearTimeout(classifyTimer);
  classifyId = null;
  el<HTMLDivElement>("nav-classify").style.display = "none";
}

/** Whether the report the what-was-it row is asking about was filed by the last quick report,
 * and not an existing one it found at the spot. */
let classifyCreated = false;

/** A report taken off by the rider is no longer pending either. */
export function forgetPendingHazard(id: string): void {
  store.pendingHazards = store.pendingHazards.filter((h) => h.id !== id);
}

async function quickReport(): Promise<void> {
  if (!store.navActive) {
    if (nav.lastPos) openHazardDialog(nav.lastPos[0], nav.lastPos[1]);
    return;
  }
  const at = freshFix("report");
  if (at === null) return;
  // tapping again because nothing visible happened used to file a second report
  const near = store.hazards.find((hz) => distM([hz.lon, hz.lat], at) < 20);
  const id = near?.id ?? `${Date.now()}`;
  if (!near) {
    try {
      await addHazard(
        { id, t: Date.now(), lon: at[0], lat: at[1], category: "other", note: "", hasPhoto: false },
        null,
      );
      await refreshHazards();
    } catch {
      flashRideAlert("⚠️ could not save the report", "gps", 4000);
      return;
    }
  }
  classifyId = id;
  classifyCreated = !near;
  vibrate([80]);
  speak("reported. routes will avoid this spot.", "chat");
  flashRideAlert(near ? "📷 already reported here" : "📷 reported — routes will avoid it", "hazard", 4000);
  el<HTMLDivElement>("nav-classify").style.display = "flex";
  window.clearTimeout(classifyTimer);
  // long enough to answer at the next light, short enough to stop nagging
  classifyTimer = window.setTimeout(hideClassify, 20_000);
}

export function initHazardDialog(): void {
  links.refreshHazards.set(refreshHazards);
  links.openHazardDialog.set(openHazardDialog);
  links.hideClassify.set(hideClassify);
  el<HTMLInputElement>("hazard-photo").addEventListener("change", () => {
    const file = el<HTMLInputElement>("hazard-photo").files?.[0] ?? null;
    hazardPhoto = file;
    const preview = el<HTMLImageElement>("hazard-preview");
    if (file) {
      preview.src = URL.createObjectURL(file);
      preview.style.display = "block";
    } else {
      preview.style.display = "none";
    }
  });

  el<HTMLButtonElement>("hazard-save").addEventListener("click", () => {
    const report = pendingHazardReport();
    if (!report) return;
    void (async () => {
      const photo = hazardPhoto ? await downscalePhoto(hazardPhoto) : null;
      await addHazard(report, photo);
      await refreshHazards();
      el<HTMLDialogElement>("hazard").close();
      speak("hazard saved. routes will avoid it.");
      void requestRoute();
    })().catch(() => {
      el<HTMLDivElement>("hazard-loc").textContent = "could not save (storage unavailable)";
    });
  });

  // Share used to build a message and never save the report, leaving the dialog
  // open with no feedback — so a rider who tapped it kept nothing.
  el<HTMLButtonElement>("hazard-share").addEventListener("click", () => {
    el<HTMLButtonElement>("hazard-save").click();
    const report = pendingHazardReport();
    if (!report) return;
    const text = buildReportText(report);
    const files =
      hazardPhoto !== null
        ? [new File([hazardPhoto], "hazard.jpg", { type: hazardPhoto.type || "image/jpeg" })]
        : [];
    const payload = files.length > 0 ? { text, files } : { text };
    if (typeof navigator.canShare === "function" && navigator.canShare(payload)) {
      void navigator.share(payload).catch(() => undefined);
    } else {
      window.location.href = `mailto:?subject=${encodeURIComponent("Bike hazard report")}&body=${encodeURIComponent(text)}`;
    }
  });

  el<HTMLButtonElement>("hazard-close").addEventListener("click", () => {
    el<HTMLDialogElement>("hazard").close();
  });

  el<HTMLButtonElement>("nav-report").addEventListener("click", () => {
    void quickReport();
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>("#nav-classify button")) {
    btn.addEventListener("click", () => {
      const cat = btn.dataset["cat"] as HazardCategory | undefined;
      const id = classifyId;
      hideClassify();
      if (cat === undefined || id === null) return;
      if (cat === "blocked" && store.navActive) {
        // "blocked" is a closure to the router, and the rider is on the way that is
        // blocked: do what the blocked-ahead button does. The closure goes ahead of them,
        // where the barrier is, and not where they were some seconds ago, so the quick
        // report filed at the tap is replaced by it, once it is filed, and not before: if the
        // closure could not be filed (no recent position, the ride over) the report stays and
        // becomes the closure. A report that was already there is never taken away.
        const created = classifyCreated;
        void reportBlocked()
          .then(async (done) => {
            if (done && created) {
              forgetPendingHazard(id);
              await removeHazard(id);
            } else if (!done) {
              await setHazardCategory(id, "blocked");
            }
            await refreshHazards();
          })
          .catch((err: unknown) => {
            reportCaught("error", err);
          });
        return;
      }
      void setHazardCategory(id, cat)
        .then(refreshHazards)
        .catch(() => undefined);
      flashRideAlert(`✓ logged as ${HAZARD_LABELS[cat]}`, "hazard", 3000);
    });
  }

  // tap-outside is the reflex on a phone; #hazard was the one dialog ignoring it
  el<HTMLDialogElement>("hazard").addEventListener("click", (e: MouseEvent) => {
    if (e.target === el<HTMLDialogElement>("hazard")) el<HTMLDialogElement>("hazard").close();
  });
}
