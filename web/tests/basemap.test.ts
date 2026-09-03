// Tests for the Carto vector basemap: the raster tiles it replaced were
// stamped "API KEY REQUIRED", and the switch moved three behaviours that used
// to be four separate raster layers into one layer set toggled by visibility.
//
// What matters here is what the map ends up showing, because every one of these
// is a failure that renders as a plausible map rather than as an error: a theme
// that never turns off leaves two basemaps stacked, a label layer that ignores
// ride mode puts upside-down street names under the rider's own, and a font
// stack left as Carto shipped it requests a glyph range this app does not
// vendor and simply draws nothing.
import { describe, expect, it } from "vitest";

import { createBasemap, VENDORED_FONT_STACK } from "../src/basemap.js";

/** A style with the shape that matters: a background, some lines, some labels. */
function style(): unknown {
  return {
    version: 8,
    sources: { carto: { type: "vector", url: "https://example.invalid/t.json" } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#fff" } },
      { id: "water", type: "fill", source: "carto", "source-layer": "water" },
      { id: "roads", type: "line", source: "carto", "source-layer": "transportation" },
      {
        id: "roadname_major",
        type: "symbol",
        source: "carto",
        "source-layer": "transportation_name",
        layout: { "text-field": "{name}", "text-font": ["Montserrat Medium", "Open Sans Bold"] },
      },
      {
        id: "place_town",
        type: "symbol",
        source: "carto",
        "source-layer": "place",
        layout: { "text-field": "{name}", "text-font": ["Montserrat Regular", "Open Sans Regular"] },
      },
      // low-zoom city dot: needs a sprite, and is invisible at any zoom this
      // app opens at, so it should be dropped rather than pull in a sprite URL
      {
        id: "place_city_dot_r4",
        type: "symbol",
        source: "carto",
        "source-layer": "place",
        layout: { "icon-image": "circle-11" },
      },
    ],
  };
}

interface FakeLayer {
  id: string;
  type: string;
  layout?: Record<string, unknown>;
}

/** Enough of a MapLibre map to record what was added and how it was toggled. */
function fakeMap(): {
  map: Parameters<typeof createBasemap>[0];
  layers: FakeLayer[];
  order: (string | undefined)[];
  vis: (id: string) => string;
} {
  // Seeded with the layer the real app anchors to: by the time a style lands,
  // the map load handler has already added "aerial" and everything above it.
  const layers: FakeLayer[] = [{ id: "aerial", type: "raster" }];
  const order: (string | undefined)[] = [];
  const map = {
    addLayer(layer: FakeLayer, beforeId?: string) {
      layers.push(layer);
      order.push(beforeId);
    },
    getLayer(id: string) {
      return layers.find((l) => l.id === id);
    },
    setLayoutProperty(id: string, prop: string, value: unknown) {
      const layer = layers.find((l) => l.id === id);
      if (!layer) throw new Error(`no layer ${id}`);
      layer.layout = { ...(layer.layout ?? {}), [prop]: value };
    },
    getStyle() {
      return { layers };
    },
  };
  return {
    map: map as unknown as Parameters<typeof createBasemap>[0],
    layers,
    order,
    vis: (id) => String(layers.find((l) => l.id === id)?.layout?.["visibility"] ?? "visible"),
  };
}

const load = async (): Promise<ReturnType<typeof fakeMap> & { bm: ReturnType<typeof createBasemap> }> => {
  const f = fakeMap();
  const bm = createBasemap(f.map, () => "aerial", {
    fetchJson: async () => style() as never,
    textFont: VENDORED_FONT_STACK,
  });
  await bm.ensure("light");
  return { ...f, bm };
};

describe("Carto vector basemap", () => {
  it("re-points every label at the vendored glyph stack", async () => {
    // Carto's stacks name five fonts and MapLibre asks its glyph server for the
    // whole joined string as one fontstack. web/fonts/glyphs has only "Noto Sans
    // Regular", so left alone each label requests a range that 404s and draws
    // nothing — no error, just a map with no names on it.
    const { layers } = await load();
    const fonts = layers
      .filter((l) => l.type === "symbol")
      .map((l) => l.layout?.["text-font"]);
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) expect(font).toEqual(["Noto Sans Regular"]);
  });

  it("leaves the style's own fonts alone when no stack is named", async () => {
    // The city and build pages serve glyphs from Carto rather than vendoring
    // them, so rewriting the font would point their labels at a stack that
    // server does not have.
    const f = fakeMap();
    const bm = createBasemap(f.map, () => undefined, { fetchJson: async () => style() as never });
    await bm.ensure("light");
    const fontOf = (id: string): unknown => f.layers.find((l) => l.id === id)?.layout?.["text-font"];
    // each keeps the stack the style gave it, rather than all collapsing to one
    expect(fontOf("bm-light-roadname_major")).toEqual(["Montserrat Medium", "Open Sans Bold"]);
    expect(fontOf("bm-light-place_town")).toEqual(["Montserrat Regular", "Open Sans Regular"]);
  });

  it("drops the layers that would need a sprite", async () => {
    const { layers } = await load();
    expect(layers.map((l) => l.id)).not.toContain("bm-light-place_city_dot_r4");
  });

  it("adds every layer beneath the anchor, so the route stays on top", async () => {
    const { order } = await load();
    expect(order.length).toBeGreaterThan(0);
    for (const beforeId of order) expect(beforeId).toBe("aerial");
  });

  it("arrives hidden, and shows only when asked", async () => {
    const { bm, vis } = await load();
    expect(vis("bm-light-roads")).toBe("none");
    bm.show({ theme: "light", labels: true, on: true });
    expect(vis("bm-light-roads")).toBe("visible");
    expect(vis("bm-light-roadname_major")).toBe("visible");
  });

  it("hides the basemap's own labels while riding, and keeps the rest", async () => {
    // The whole point of the old _nolabels tile set: with the map turned to the
    // heading, baked-in labels rode upside-down and slid off their streets. The
    // app draws its own upright ones instead (see "street-labels").
    const { bm, vis } = await load();
    bm.show({ theme: "light", labels: false, on: true });
    expect(vis("bm-light-roadname_major")).toBe("none");
    expect(vis("bm-light-place_town")).toBe("none");
    expect(vis("bm-light-roads")).toBe("visible");
    expect(vis("bm-light-water")).toBe("visible");
    // and back again when the ride ends
    bm.show({ theme: "light", labels: true, on: true });
    expect(vis("bm-light-roadname_major")).toBe("visible");
  });

  it("turns the whole basemap off for the aerial view", async () => {
    const { bm, vis } = await load();
    bm.show({ theme: "light", labels: true, on: false });
    for (const id of ["bm-light-roads", "bm-light-water", "bm-light-roadname_major"]) {
      expect(vis(id)).toBe("none");
    }
  });

  it("shows one theme at a time, so two basemaps never stack", async () => {
    const f = fakeMap();
    const bm = createBasemap(f.map, () => undefined, { fetchJson: async () => style() as never });
    await bm.ensure("light");
    await bm.ensure("dark");
    bm.show({ theme: "dark", labels: true, on: true });
    expect(f.vis("bm-dark-roads")).toBe("visible");
    expect(f.vis("bm-light-roads")).toBe("none");
    bm.show({ theme: "light", labels: true, on: true });
    expect(f.vis("bm-light-roads")).toBe("visible");
    expect(f.vis("bm-dark-roads")).toBe("none");
  });

  it("fetches a theme once, however often it is asked for", async () => {
    const f = fakeMap();
    let fetches = 0;
    const bm = createBasemap(f.map, () => undefined, {
      fetchJson: async () => {
        fetches++;
        return style() as never;
      },
    });
    await Promise.all([bm.ensure("light"), bm.ensure("light")]);
    await bm.ensure("light");
    expect(fetches).toBe(1);
  });

  it("does not remember a failed fetch as done", async () => {
    // Otherwise one offline moment at startup means no basemap for the rest of
    // the session, with nothing to retry it.
    const f = fakeMap();
    let calls = 0;
    const bm = createBasemap(f.map, () => undefined, {
      fetchJson: async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return style() as never;
      },
    });
    await expect(bm.ensure("light")).rejects.toThrow("offline");
    await bm.ensure("light");
    expect(f.layers.map((l) => l.id)).toContain("bm-light-roads");
  });

  it("applies the visibility asked for while the style was still loading", async () => {
    // applyBasemap runs long before the fetch lands, so a ride that starts in
    // that window has to survive the layers arriving late.
    const f = fakeMap();
    const bm = createBasemap(f.map, () => undefined, { fetchJson: async () => style() as never });
    bm.show({ theme: "light", labels: false, on: true });
    await bm.ensure("light");
    expect(f.vis("bm-light-roads")).toBe("visible");
    expect(f.vis("bm-light-roadname_major")).toBe("none");
  });
});
