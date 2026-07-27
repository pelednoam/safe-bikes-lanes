// Tests for saved places and recent-route logic (pure parts).
import { beforeEach, describe, expect, it } from "vitest";

import {
  emojiFor,
  exportBackup,
  importBackup,
  listPlaces,
  recentWithNew,
  savePlace,
} from "../src/places.js";
import type { RecentRoute } from "../src/places.js";

describe("emojiFor", () => {
  it("matches common tags", () => {
    expect(emojiFor("Home")).toBe("🏠");
    expect(emojiFor("noam's work")).toBe("💼");
    expect(emojiFor("School - dropoff")).toBe("🏫");
    expect(emojiFor("Danehy Park")).toBe("🛝");
    expect(emojiFor("Random Cafe")).toBe("📍");
  });
});

describe("recentWithNew", () => {
  const route = (
    s: [number, number],
    e: [number, number],
    label: string,
    t = 0,
  ): RecentRoute => ({ s, e, label, km: 5, grade: "A", t });

  it("prepends and dedupes near-identical endpoint pairs", () => {
    const a = route([-71.1, 42.38], [-71.09, 42.39], "old", 1);
    const b = route([-71.10001, 42.38001], [-71.09002, 42.39001], "same again", 2);
    const merged = recentWithNew([a], b);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe("same again");
  });

  it("keeps distinct routes and caps at 8", () => {
    let list: RecentRoute[] = [];
    for (let i = 0; i < 12; i++) {
      list = recentWithNew(list, route([-71.1 + i * 0.01, 42.38], [-71.0, 42.4], `r${i}`, i));
    }
    expect(list).toHaveLength(8);
    expect(list[0]?.label).toBe("r11");
    expect(list[7]?.label).toBe("r4");
  });
});

/** vitest runs in node, so the storage-backed helpers need somewhere to write. */
class MemoryStorage {
  private map = new Map<string, string>();
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

describe("backup / restore", () => {
  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage() as Storage;
  });

  it("round-trips saved places and marks", () => {
    localStorage.clear();
    savePlace({ name: "Home", lon: -71.1, lat: 42.38 });
    savePlace({ name: "School", lon: -71.09, lat: 42.37 });
    localStorage.setItem("sketchyMarks", JSON.stringify([[-71.1, 42.39]]));

    const backup = exportBackup("2026-07-27T00:00:00.000Z");
    expect(backup.app).toBe("family-bike-router");

    // an uninstall wipes the device
    localStorage.clear();
    expect(listPlaces()).toHaveLength(0);

    const n = importBackup(JSON.parse(JSON.stringify(backup)));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(listPlaces().map((p) => p.name).sort()).toEqual(["Home", "School"]);
    expect(localStorage.getItem("sketchyMarks")).toBe(JSON.stringify([[-71.1, 42.39]]));
  });

  it("refuses a file that isn't one of ours, and ignores unknown keys", () => {
    expect(() => importBackup({ app: "something-else", data: {} })).toThrow(/backup/);
    expect(() => importBackup(null)).toThrow(/backup/);
    localStorage.clear();
    importBackup({ app: "family-bike-router", data: { evilKey: "x", savedPlaces: "[]" } });
    expect(localStorage.getItem("evilKey")).toBeNull();
  });
});
