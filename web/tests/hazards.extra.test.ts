// Hazard reports are user data: they live only on the phone, they change where
// routes go, and nothing had exercised the storage. fake-indexeddb gives the
// real code path (IndexedDB) rather than a mock of it.
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addHazard,
  downscalePhoto,
  buildReportText,
  getHazardPhoto,
  HAZARD_LABELS,
  listHazards,
  removeHazard,
  setHazardCategory,
} from "../src/hazards.js";
import type { HazardReport } from "../src/hazards.js";

function report(id: string, t: number, category: HazardReport["category"] = "surface"): HazardReport {
  return {
    id,
    t,
    lon: -71.1,
    lat: 42.38,
    category,
    note: "glass across the lane",
    hasPhoto: false,
  };
}

async function clear(): Promise<void> {
  for (const h of await listHazards()) await removeHazard(h.id);
}

describe("hazard storage", () => {
  beforeEach(clear);

  it("round-trips a report and lists newest first", async () => {
    await addHazard(report("a", 1000), null);
    await addHazard(report("b", 3000), null);
    await addHazard(report("c", 2000), null);
    const all = await listHazards();
    expect(all.map((h) => h.id)).toEqual(["b", "c", "a"]);
    expect(all[0]?.note).toBe("glass across the lane");
  });

  it("keeps a photo out of the listing but retrievable", async () => {
    const blob = new Blob(["not really a jpeg"], { type: "image/jpeg" });
    await addHazard(report("p", 1000), blob);
    const listed = (await listHazards())[0];
    expect(listed?.hasPhoto).toBe(true);
    // the list is used to draw the map; carrying photos through it would blow
    // memory on a phone with a hundred reports
    expect((listed as unknown as { photo?: Blob }).photo).toBeUndefined();
    const back = await getHazardPhoto("p");
    expect(back).not.toBeNull();
    expect(await back?.text()).toBe("not really a jpeg");
  });

  it("has no photo for a report filed without one", async () => {
    await addHazard(report("np", 1000), null);
    expect(await getHazardPhoto("np")).toBeNull();
    expect(await getHazardPhoto("does-not-exist")).toBeNull();
  });

  it("amends a category after the fact, keeping everything else", async () => {
    // riding files the report first and asks what it was afterwards
    const blob = new Blob(["photo"], { type: "image/jpeg" });
    await addHazard(report("q", 1000, "other"), blob);
    await setHazardCategory("q", "blocked");
    const stored = (await listHazards())[0];
    expect(stored?.category).toBe("blocked");
    expect(stored?.note).toBe("glass across the lane");
    // the photo survives the amendment
    expect(await getHazardPhoto("q")).not.toBeNull();
  });

  it("ignores an amendment to a report that's gone", async () => {
    // the rider may have deleted it between filing and answering
    await expect(setHazardCategory("missing", "traffic")).resolves.toBeUndefined();
    expect(await listHazards()).toEqual([]);
  });

  it("removes a report", async () => {
    await addHazard(report("r", 1000), null);
    await removeHazard("r");
    expect(await listHazards()).toEqual([]);
  });
});

describe("the text a rider sends onward", () => {
  it("names the hazard, locates it, and stays quotable", () => {
    const text = buildReportText(report("t", Date.parse("2026-08-05T12:00:00Z"), "blocked"));
    expect(text).toContain(HAZARD_LABELS["blocked"]);
    expect(text).toContain("glass across the lane");
    expect(text).toContain("42.38");
    expect(text).toContain("-71.1");
    // a 311 desk needs a link it can click
    expect(text).toMatch(/https:\/\/maps\.google\.com/);
  });

  it("omits an empty note rather than leaving a dangling full stop", () => {
    const bare = { ...report("t", 1000), note: "   " };
    const text = buildReportText(bare);
    expect(text).not.toMatch(/\.\s+\./);
    expect(text).toContain(HAZARD_LABELS["surface"]);
  });
});

describe("shrinking a photo before it's stored", () => {
  const bigFile = new Blob(["x".repeat(2000)], { type: "image/jpeg" });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubCanvas(opts: { context?: boolean; blob?: boolean } = {}): void {
    const { context = true, blob = true } = opts;
    const ctx = { drawImage: () => undefined };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => (context ? ctx : null),
      toBlob: (cb: (b: Blob | null) => void) =>
        cb(blob ? new Blob(["small"], { type: "image/jpeg" }) : null),
    };
    vi.stubGlobal("document", { createElement: () => canvas });
  }

  it("shrinks an oversized photo", async () => {
    // hazard photos go to IndexedDB on a phone; a 12 MP original would fill it
    vi.stubGlobal("createImageBitmap", async () => ({ width: 4000, height: 3000 }));
    stubCanvas();
    const out = await downscalePhoto(bigFile, 1280);
    expect(await out.text()).toBe("small");
  });

  it("leaves a photo that's already small alone", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 800, height: 600 }));
    stubCanvas();
    const out = await downscalePhoto(bigFile, 1280);
    expect(out).toBe(bigFile); // the same object: no needless re-encode
  });

  it("keeps the original rather than losing the report", async () => {
    // a hazard report with no photo is worth more than no report at all
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("not an image");
    });
    expect(await downscalePhoto(bigFile, 1280)).toBe(bigFile);

    vi.stubGlobal("createImageBitmap", async () => ({ width: 4000, height: 3000 }));
    stubCanvas({ context: false });
    expect(await downscalePhoto(bigFile, 1280)).toBe(bigFile);

    stubCanvas({ blob: false });
    expect(await downscalePhoto(bigFile, 1280)).toBe(bigFile);
  });
});
