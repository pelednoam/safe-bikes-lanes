// Saved places and recent routes: Home and Work, the list of rides just taken, and
// backing all of it up to a file.

import { links } from "./links.js";
import { trip } from "./services.js";
import { clearRecent, deletePlace, exportBackup, importBackup, listPlaces, listRecent, pushRecent, savePlace } from "../places.js";
import { h, render } from "preact";
import { RecentRoutes, SavedPlaces } from "../ui/PlacesAndRecent.js";
import { setPoint } from "./markers.js";
import { map } from "./map.js";
import { el } from "./dom.js";
import { saveBlob } from "../share.js";
import { loadSketchy, store } from "./store.js";

/** Label a just-planned route from its street names for the recent list. */
export function recordRecentRoute(s: [number, number], e: [number, number]): void {
  const sel = trip.selected ?? trip.options[0];
  if (!sel) return;
  const names = sel.payload.geojson.features
    .map((f) => f.properties.name)
    .filter((n): n is string => n !== null && n !== "");
  const from = names[0] ?? "start";
  const to = names[names.length - 1] ?? "end";
  pushRecent({
    s,
    e,
    label: `${from} → ${to}`,
    km: Math.round(sel.payload.summary.meters / 100) / 10,
    grade: sel.grade,
    t: Date.now(),
  });
  renderPlacesAndRecent();
}

export function promptSavePlace(lon: number, lat: number): void {
  const name = window.prompt("Name this place (e.g. Home, Work, School):");
  if (name === null || name.trim() === "") return;
  savePlace({ name: name.trim(), lon, lat });
  renderPlacesAndRecent();
}

export function renderPlacesAndRecent(): void {
  render(
    h(SavedPlaces, {
      places: listPlaces(),
      onUse: (place, as) => {
        setPoint(as, [place.lon, place.lat]);
        map.flyTo({ center: [place.lon, place.lat], zoom: 15 });
      },
      onDelete: (place) => {
        deletePlace(place.name);
        renderPlacesAndRecent();
      },
    }),
    el<HTMLDivElement>("places-list"),
  );
  const recent = listRecent();
  // collapsed by default; the whole section is hidden when there's no history
  el<HTMLDetailsElement>("recent-box").style.display = recent.length > 0 ? "block" : "none";
  render(
    h(RecentRoutes, {
      routes: recent,
      onPlan: (s, e) => links.planBetween.call(s, e),
      onClear: () => {
        clearRecent();
        renderPlacesAndRecent();
      },
    }),
    el<HTMLDivElement>("recent-list"),
  );
}

export function initPlaces(): void {
  el<HTMLButtonElement>("backup-save").addEventListener("click", () => {
    const backup = exportBackup(new Date().toISOString());
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const places = listPlaces().length;
    const note = el<HTMLDivElement>("backup-note");
    void saveBlob(blob, `family-bike-router-backup-${new Date().toISOString().slice(0, 10)}.json`).then((r) => {
      note.textContent =
        "saved" in r
          ? `Backed up ${places} saved place${places === 1 ? "" : "s"} and your marks` +
            (r.where === undefined ? "." : `, in ${r.where}.`)
          : `The backup was not saved: ${r.error}`;
    });
  });

  el<HTMLButtonElement>("backup-load").addEventListener("click", () => {
    el<HTMLInputElement>("backup-file").click();
  });

  el<HTMLInputElement>("backup-file").addEventListener("change", () => {
    const file = el<HTMLInputElement>("backup-file").files?.[0];
    if (!file) return;
    void file
      .text()
      .then(async (text) => {
        const n = importBackup(JSON.parse(text));
        renderPlacesAndRecent();
        store.sketchyMarks = loadSketchy();
        // the hazards a backup brings back are in the mirror that listHazards merges
        // into the device's store: read them again, which also tells the router (with
        // the marks), instead of keeping the list from before the restore
        await links.refreshHazards.call();
        links.renderSketchy.call();
        el<HTMLDivElement>("backup-note").textContent =
          `Restored ${n} item${n === 1 ? "" : "s"} — ${listPlaces().length} saved places.`;
      })
      .catch((err: unknown) => {
        el<HTMLDivElement>("backup-note").textContent =
          `Couldn't restore that file: ${err instanceof Error ? err.message : String(err)}`;
      });
    el<HTMLInputElement>("backup-file").value = "";
  });

  renderPlacesAndRecent();
}
