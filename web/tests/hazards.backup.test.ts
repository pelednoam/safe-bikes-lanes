// Hazard reports go into the backup file with everything else the rider has
// taught the app.
//
// They live in IndexedDB, and the backup read only localStorage, so a restore
// after an uninstall — or after Safari cleared a non-installed site's storage
// on its seven-day rule — brought back saved places and marks and silently
// lost every hazard. Photos are deliberately left out (see hazards.ts).
import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  addHazard,
  HAZARD_MIRROR_KEY,
  listHazards,
  removeHazard,
  setHazardCategory,
  type HazardReport,
} from "../src/hazards.js";
import { exportBackup, importBackup } from "../src/places.js";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

function report(id: string, t: number, note = "glass across the lane"): HazardReport {
  return { id, t, lon: -71.1, lat: 42.38, category: "surface", note, hasPhoto: false };
}

/** What an uninstall, or Safari's seven-day rule, leaves behind: nothing. */
async function wipeDevice(): Promise<void> {
  for (const h of await listHazards()) await removeHazard(h.id);
  localStorage.clear();
}

describe("hazard reports in the backup", () => {
  beforeEach(async () => {
    globalThis.localStorage = new MemoryStorage() as Storage;
    await wipeDevice();
  });

  it("survive a wipe and a restore, without their photos", async () => {
    await addHazard(report("a", 1000, "pothole by the bridge"), new Blob(["jpeg"]));
    await addHazard(report("b", 2000), null);
    await setHazardCategory("b", "blocked");

    const file = JSON.parse(JSON.stringify(exportBackup("2026-09-26T00:00:00.000Z"))) as unknown;
    await wipeDevice();
    expect(await listHazards()).toEqual([]);

    importBackup(file);
    const back = await listHazards();
    expect(back.map((h) => h.id)).toEqual(["b", "a"]);
    expect(back.find((h) => h.id === "a")?.note).toBe("pothole by the bridge");
    // the category chosen after filing is the one restored
    expect(back.find((h) => h.id === "b")?.category).toBe("blocked");
    // the photo did not travel, and the report does not claim it did
    expect(back.find((h) => h.id === "a")?.hasPhoto).toBe(false);
    // and they are real reports again, stored where the app keeps them
    await removeHazard("a");
    expect((await listHazards()).map((h) => h.id)).toEqual(["b"]);
  });

  it("includes reports filed before the backup knew about them", async () => {
    await addHazard(report("old", 500), null);
    // as if filed by a build that kept them only in IndexedDB
    localStorage.removeItem(HAZARD_MIRROR_KEY);
    await listHazards();
    const file = exportBackup("2026-09-26T00:00:00.000Z");
    expect(JSON.parse(file.data[HAZARD_MIRROR_KEY] ?? "[]")).toHaveLength(1);
  });

  it("merges a restore with what is already on the device", async () => {
    await addHazard(report("kept", 1), null);
    const file = JSON.parse(JSON.stringify(exportBackup("x"))) as unknown;
    await removeHazard("kept");
    await addHazard(report("new", 2), null);
    importBackup(file);
    expect((await listHazards()).map((h) => h.id).sort()).toEqual(["kept", "new"]);
  });

  it("does not bring back a report the rider deleted", async () => {
    await addHazard(report("gone", 1), null);
    await removeHazard("gone");
    expect(await listHazards()).toEqual([]);
    expect(await listHazards()).toEqual([]);
  });

  it("ignores a hand-edited entry that is not a report", async () => {
    importBackup({
      app: "family-bike-router",
      data: { [HAZARD_MIRROR_KEY]: JSON.stringify([{ id: 3 }, report("ok", 5)]) },
    });
    expect((await listHazards()).map((h) => h.id)).toEqual(["ok"]);
  });
});
