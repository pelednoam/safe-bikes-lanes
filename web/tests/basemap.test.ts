// Tests for the basemap: Protomaps' styles over our own basemap.pmtiles.
//
// What matters is what the map ends up showing, because every one of these is
// a failure that renders as a plausible map rather than as an error: a theme
// that never turns off leaves two basemaps stacked, a label layer that ignores
// ride mode puts upside-down street names under the rider's own, a font stack
// this app doesn't vendor requests glyph ranges that 404 and draws nothing, and
// an icon layer asks for a sprite there isn't one of.
import { describe, expect, it } from "vitest";

import {
  BASEMAP_MAXZOOM,
  BASEMAP_SOURCE,
  basemapLayers,
  basemapSource,
  createBasemap,
  VENDORED_FONT_STACK,
} from "../src/basemap.js";
import { TILE_TEMPLATE } from "../src/tilecache.js";

interface FakeLayer {
  id: string;
  type: string;
  source?: string;
  layout?: Record<string, unknown>;
}

/** Enough of a MapLibre map to record what was added and how it was toggled. */
function fakeMap(withSource = true): {
  map: Parameters<typeof createBasemap>[0];
  layers: FakeLayer[];
  order: (string | undefined)[];
  sources: string[];
  vis: (id: string) => string;
} {
  // Seeded with the layer the real app anchors to
  const layers: FakeLayer[] = [{ id: "aerial", type: "raster" }];
  const order: (string | undefined)[] = [];
  const sources = withSource ? [BASEMAP_SOURCE] : [];
  const map = {
    addLayer(layer: FakeLayer, beforeId?: string) {
      layers.push(layer);
      order.push(beforeId);
    },
    getLayer(id: string) {
      return layers.find((l) => l.id === id);
    },
    getSource(id: string) {
      return sources.includes(id) ? {} : undefined;
    },
    addSource(id: string) {
      sources.push(id);
    },
    setLayoutProperty(id: string, prop: string, value: unknown) {
      const layer = layers.find((l) => l.id === id);
      if (!layer) throw new Error(`no layer ${id}`);
      layer.layout = { ...(layer.layout ?? {}), [prop]: value };
    },
  };
  const vis = (id: string): string =>
    String(layers.find((l) => l.id === id)?.layout?.["visibility"] ?? "unset");
  return { map: map as unknown as Parameters<typeof createBasemap>[0], layers, order, sources, vis };
}

const basemapIds = (layers: FakeLayer[], theme: string): FakeLayer[] =>
  layers.filter((l) => l.id.startsWith(`bm-${theme}-`));

describe("the basemap's layers", () => {
  it("draw from our own file, to the zoom it was cut at", () => {
    const src = basemapSource();
    expect(src.tiles).toEqual([TILE_TEMPLATE]);
    expect(src.maxzoom).toBe(BASEMAP_MAXZOOM);
    expect(String(src.attribution)).toContain("OpenStreetMap");
    for (const l of basemapLayers("light")) {
      if (l.type !== "background") expect((l as { source?: string }).source).toBe(BASEMAP_SOURCE);
    }
  });

  it("draw every label in the one font stack this app vendors", () => {
    // Protomaps asks for Noto Sans Regular, Medium and Italic, some through an
    // expression; only Regular is vendored, and a stack that isn't draws nothing
    const labels = basemapLayers("light").filter((l) => l.type === "symbol");
    expect(labels.length).toBeGreaterThan(5);
    for (const l of labels) {
      expect((l.layout as Record<string, unknown>)["text-font"], l.id).toEqual(VENDORED_FONT_STACK);
    }
  });

  it("need no sprite: icon-only layers go, and text keeps its words", () => {
    const all = basemapLayers("light");
    for (const l of all) {
      expect((l.layout as Record<string, unknown> | undefined)?.["icon-image"], l.id).toBeUndefined();
    }
    // the one-way arrows and route shields were icons and nothing else
    expect(all.some((l) => l.id.endsWith("roads_oneway"))).toBe(false);
    // place names drew an icon beside their text; the text stays
    expect(all.some((l) => l.id.endsWith("places_locality"))).toBe(true);
  });

  it("arrive hidden, and labels-only means labels only", () => {
    for (const l of basemapLayers("dark")) {
      expect((l.layout as Record<string, unknown>)["visibility"]).toBe("none");
    }
    const labels = basemapLayers("light", { labelsOnly: true, prefix: "labels" });
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => l.type === "symbol" && l.id.startsWith("labels-light-"))).toBe(true);
  });

  it("differ between the themes, which is the point of having two", () => {
    const paint = (theme: "light" | "dark"): string =>
      JSON.stringify(basemapLayers(theme).find((l) => l.type === "background")?.paint);
    expect(paint("light")).not.toBe(paint("dark"));
  });
});

describe("the basemap on a map", () => {
  it("adds every layer beneath the anchor, so the route stays on top", async () => {
    const m = fakeMap();
    const bm = createBasemap(m.map, () => "aerial");
    await bm.ensure("light");
    expect(basemapIds(m.layers, "light").length).toBeGreaterThan(20);
    expect(m.order.every((b) => b === "aerial")).toBe(true);
  });

  it("arrives hidden, and shows only when asked", async () => {
    const m = fakeMap();
    const bm = createBasemap(m.map, () => "aerial");
    await bm.ensure("light");
    const ids = basemapIds(m.layers, "light").map((l) => l.id);
    expect(ids.every((id) => m.vis(id) === "none")).toBe(true);
    bm.show({ theme: "light", labels: true, on: true });
    expect(ids.every((id) => m.vis(id) === "visible")).toBe(true);
  });

  it("hides the basemap's own labels while riding, and keeps the rest", async () => {
    const m = fakeMap();
    const bm = createBasemap(m.map, () => "aerial");
    await bm.ensure("light");
    bm.show({ theme: "light", labels: false, on: true });
    for (const l of basemapIds(m.layers, "light")) {
      expect(m.vis(l.id), l.id).toBe(l.type === "symbol" ? "none" : "visible");
    }
  });

  it("turns the whole basemap off for the aerial view", async () => {
    const m = fakeMap();
    const bm = createBasemap(m.map, () => "aerial");
    await bm.ensure("light");
    bm.show({ theme: "light", labels: true, on: false });
    expect(basemapIds(m.layers, "light").every((l) => m.vis(l.id) === "none")).toBe(true);
  });

  it("shows one theme at a time, so two basemaps never stack", async () => {
    const m = fakeMap();
    const bm = createBasemap(m.map, () => "aerial");
    await bm.ensure("light");
    await bm.ensure("dark");
    bm.show({ theme: "dark", labels: true, on: true });
    expect(basemapIds(m.layers, "light").every((l) => m.vis(l.id) === "none")).toBe(true);
    expect(basemapIds(m.layers, "dark").every((l) => m.vis(l.id) === "visible")).toBe(true);
  });

  it("adds a theme once, however often it is asked for", async () => {
    const m = fakeMap();
    const bm = createBasemap(m.map, () => "aerial");
    await bm.ensure("light");
    const n = m.layers.length;
    await bm.ensure("light");
    expect(m.layers.length).toBe(n);
  });

  it("applies the visibility asked for before its layers existed", async () => {
    const m = fakeMap();
    const bm = createBasemap(m.map, () => "aerial");
    bm.show({ theme: "light", labels: false, on: true });
    await bm.ensure("light");
    const layers = basemapIds(m.layers, "light");
    expect(layers.some((l) => l.type === "symbol" && m.vis(l.id) === "visible")).toBe(false);
    expect(layers.some((l) => l.type !== "symbol" && m.vis(l.id) === "visible")).toBe(true);
  });

  it("adds its source if the page's style didn't declare it", async () => {
    const m = fakeMap(false);
    const bm = createBasemap(m.map, () => "aerial");
    expect(m.sources).toEqual([]); // not while the style may still be loading
    await bm.ensure("light");
    expect(m.sources).toEqual([BASEMAP_SOURCE]);
  });
});
