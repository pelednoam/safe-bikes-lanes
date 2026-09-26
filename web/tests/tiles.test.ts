// Tests for on-demand routing tiles: the store must fetch only the tiles a
// bbox needs, merge boundary nodes (shared global id) so tiles stitch together,
// and produce a GraphData the Router can route across tile seams.
import { describe, expect, it } from "vitest";

import { Router } from "../src/router.js";
import { type BBox, bboxOf, NetworkTiles, TileStore } from "../src/tiles.js";

// Toy world, tileDeg=1 from origin (0,0):
//   tile 0_0: node g0 (0.2,0.5) --quiet-- node g1 (0.9,0.5)   [boundary node]
//   tile 1_0: node g1 (0.9,0.5) --quiet-- node g2 (1.5,0.5)
// The g0->g1->g2 path spans both tiles, joined at g1.
const MANIFEST = {
  originLon: 0,
  originLat: 0,
  tileDeg: 1,
  classes: ["quiet_street"],
  tiles: ["0_0", "1_0"],
};

type Edge = [number, number, number, number, number, number, number, number, number, number];
// [u, v, len, clsIdx(global), nameIdx(local), geomIdx(local), crash, pen, climb, busy]
function e(u: number, v: number): Edge {
  return [u, v, 70, 0, 0, -1, 1, 0, 0, 0];
}

const TILE_0_0 = {
  nodes: [
    [0.2, 0.5, 0],
    [0.9, 0.5, 0],
  ],
  nodeIds: [0, 1], // local 0 -> global 0, local 1 -> global 1
  names: [""],
  edges: [e(0, 1), e(1, 0)],
  geoms: [],
};
const TILE_1_0 = {
  nodes: [
    [0.9, 0.5, 0], // g1: same global id as in tile 0_0 -> merges
    [1.5, 0.5, 0],
  ],
  nodeIds: [1, 2],
  names: [""],
  edges: [e(0, 1), e(1, 0)],
  geoms: [],
};

function fetcher(fetched: string[]): <T>(name: string) => Promise<T> {
  return <T,>(name: string): Promise<T> => {
    fetched.push(name);
    const table: Record<string, unknown> = {
      "tiles/manifest.json": MANIFEST,
      "tiles/0_0.json": TILE_0_0,
      "tiles/1_0.json": TILE_1_0,
    };
    const hit = table[name];
    if (hit === undefined) throw new Error(`unexpected fetch ${name}`);
    return Promise.resolve(hit as T);
  };
}

describe("TileStore", () => {
  it("loads only the tiles a bbox covers", async () => {
    const fetched: string[] = [];
    const store = new TileStore(fetcher(fetched));
    await store.loadManifest();
    // a box fully inside tile 0_0, no margin -> only that tile
    await store.ensure({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 0);
    expect(store.loadedCount).toBe(1);
    expect(fetched).toContain("tiles/0_0.json");
    expect(fetched).not.toContain("tiles/1_0.json");
  });

  it("re-fetching the same area loads nothing new", async () => {
    const store = new TileStore(fetcher([]));
    await store.loadManifest();
    const box = { west: 0.3, south: 0.4, east: 0.6, north: 0.6 };
    expect(await store.ensure(box, 0)).toBe(true); // first time: grew
    expect(await store.ensure(box, 0)).toBe(false); // cached: no growth
  });

  it("merges boundary nodes so a route crosses the tile seam", async () => {
    const store = new TileStore(fetcher([]));
    await store.loadManifest();
    // span both tiles
    await store.ensure(bboxOf([[0.2, 0.5], [1.5, 0.5]], 0), 0);
    expect(store.loadedCount).toBe(2);
    const g = store.assemble();
    // g0, g1, g2 — the shared boundary node g1 collapses to one
    expect(g.nodes.length).toBe(3);
    // 4 directed edges (2 per tile), none dropped or duplicated
    expect(g.edges.length).toBe(4);

    const router = new Router(g);
    const opts = router.routeOptions([0.2, 0.5], [1.5, 0.5], "young_kids");
    expect(opts.length).toBeGreaterThan(0);
    // the route must use both segments -> ~140 m end to end
    const meters = opts[0]?.payload.summary.meters ?? 0;
    expect(meters).toBeGreaterThan(130);
    expect(meters).toBeLessThan(150);
  });

  it("reads the full class table, so an appended class is named and priced", async () => {
    // `classes` is the legacy prefix an older app reads; `classTable` is the
    // whole append-only table (pipeline config.TILE_CLASSES)
    const manifest = {
      ...MANIFEST,
      classes: ["quiet_street"],
      classTable: ["quiet_street", "unpaved"],
      tiles: ["0_0"],
    };
    const trail = (u: number, v: number): Edge => [u, v, 70, 1, 0, -1, 1, 0, 0, 0];
    const tile = { ...TILE_0_0, edges: [trail(0, 1), trail(1, 0)] };
    const store = new TileStore(<T,>(name: string): Promise<T> =>
      Promise.resolve((name === "tiles/manifest.json" ? manifest : tile) as T),
    );
    await store.loadManifest();
    expect(store.classes).toEqual(["quiet_street", "unpaved"]);
    await store.ensure({ west: 0.1, south: 0.4, east: 0.95, north: 0.6 }, 0);
    const router = new Router(store.assemble());
    const opts = router.routeOptions([0.2, 0.5], [0.9, 0.5], "young_kids");
    const summary = opts[0]?.payload.summary;
    expect(summary?.by_class_m.unpaved).toBe(70);
    expect(Number.isFinite(summary?.meters)).toBe(true);
  });

  it("still reads a snapshot published before the full class table existed", async () => {
    const store = new TileStore(fetcher([]));
    await store.loadManifest();
    expect(store.classes).toEqual(["quiet_street"]);
  });

  it("keysForBBox grows the covered cells by the margin", async () => {
    const store = new TileStore(fetcher([]));
    await store.loadManifest();
    const box = { west: 0.3, south: 0.4, east: 0.6, north: 0.6 };
    expect(store.keysForBBox(box, 0)).toEqual(["0_0"]);
    // margin 1 reaches into the neighbor cell, but only existing tiles return
    expect(store.keysForBBox(box, 1).sort()).toEqual(["0_0", "1_0"]);
  });
});

describe("NetworkTiles", () => {
  const NET_MANIFEST = { originLon: 0, originLat: 0, tileDeg: 1, tiles: ["0_0", "1_0"] };
  const feat = (lon: number, name: string | null = null): unknown => ({
    type: "Feature",
    properties: { cls: "path", color: "#000", name, source: "osm", crashes: 0 },
    geometry: { type: "LineString", coordinates: [[lon, 0.5], [lon + 0.05, 0.5]] },
  });
  const netFetch = (fetched: string[]): (<T>(name: string) => Promise<T>) => {
    const table: Record<string, unknown> = {
      "nettiles/manifest.json": NET_MANIFEST,
      "nettiles/0_0.json": {
        type: "FeatureCollection",
        // two pieces of one street, one of another, and one the mapper never named
        features: [feat(0.2, "Elm Street"), feat(0.6, "Elm Street"), feat(0.4, "Broadway"), feat(0.5)],
      },
      "nettiles/1_0.json": { type: "FeatureCollection", features: [feat(1.4, "Oak Road")] },
    };
    return <T,>(name: string): Promise<T> => {
      fetched.push(name);
      if (table[name] === undefined) throw new Error(`unexpected ${name}`);
      return Promise.resolve(table[name] as T);
    };
  };

  it("returns only the features in the viewport", async () => {
    const fetched: string[] = [];
    const net = new NetworkTiles(netFetch(fetched));
    await net.loadManifest();
    const feats = await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 0);
    expect(feats.length).toBe(4); // every feature of tile 0_0
    expect(fetched).toContain("nettiles/0_0.json");
    expect(fetched).not.toContain("nettiles/1_0.json");
  });

  it("caches fetched tiles across calls", async () => {
    const fetched: string[] = [];
    const net = new NetworkTiles(netFetch(fetched));
    await net.loadManifest();
    const box = { west: 0.3, south: 0.4, east: 0.6, north: 0.6 };
    await net.visibleFeatures(box, 0);
    await net.visibleFeatures(box, 0);
    // manifest + one tile fetch, not two
    expect(fetched.filter((f) => f === "nettiles/0_0.json").length).toBe(1);
  });

  describe("loadedStreets", () => {
    // The destination search reads this: the street names already on the device
    // answer a keystroke instantly, where a geocoder round trip cannot.
    it("offers every named street among the tiles already fetched", async () => {
      const net = new NetworkTiles(netFetch([]));
      await net.loadManifest();
      await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 0);
      const names = net.loadedStreets().map((s) => s.name).sort();
      // two Elm Street segments and one Broadway: a segment each, not one per name
      expect(names).toEqual(["Broadway", "Elm Street", "Elm Street"]);
    });

    it("does not walk every tile again on every call", async () => {
      // It is called on each keystroke, and `loaded` never shrinks — after some
      // panning it holds every tile ever fetched. The result is cached until a new
      // tile arrives, so typing does not get slower the longer the map has been used.
      const net = new NetworkTiles(netFetch([]));
      await net.loadManifest();
      await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 0);
      const first = net.loadedStreets();
      expect(net.loadedStreets(), "a fresh array was built for an unchanged tile set").toBe(first);

      // and a new tile invalidates it, or the search would never see new streets
      await net.visibleFeatures({ west: 1.3, south: 0.4, east: 1.6, north: 0.6 }, 0);
      const second = net.loadedStreets();
      expect(second).not.toBe(first);
      expect(second.map((s) => s.name)).toContain("Oak Road");
    });

    it("fetches nothing itself", async () => {
      // It runs on every keystroke. A method that could fetch would turn typing
      // into a download.
      const fetched: string[] = [];
      const net = new NetworkTiles(netFetch(fetched));
      await net.loadManifest();
      await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 0);
      const before = fetched.length;
      net.loadedStreets();
      net.loadedStreets();
      expect(fetched.length).toBe(before);
    });

    it("keeps same-named streets apart, so the nearest one can be offered", async () => {
      // Grouping by name merged the four Elm Streets in this region into a single
      // candidate holding all their points; the ranking could then offer only one
      // of them, at whichever end happened to be nearest. A segment each keeps them
      // distinguishable, and the ranking's dedupe rejoins the pieces of one street.
      const net = new NetworkTiles(netFetch([]));
      await net.loadManifest();
      await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 0);
      const elms = net.loadedStreets().filter((s) => s.name === "Elm Street");
      expect(elms).toHaveLength(2);
      for (const e of elms) expect(e.coords).toHaveLength(2); // its own points only
      expect(elms.map((e) => e.coords[0]?.[0]).sort()).toEqual([0.2, 0.6]);
    });

    it("skips the streets nobody named", async () => {
      const net = new NetworkTiles(netFetch([]));
      await net.loadManifest();
      await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 0);
      // one of the four features in that tile has no name; a nameless row would
      // be an unlabelled destination
      expect(net.loadedStreets()).toHaveLength(3);
      for (const s of net.loadedStreets()) expect(s.name).not.toBe("");
    });

    it("knows nothing before a tile is fetched", async () => {
      const net = new NetworkTiles(netFetch([]));
      await net.loadManifest();
      expect(net.loadedStreets()).toEqual([]);
    });

    it("grows as the map moves, without refetching what it has", async () => {
      const fetched: string[] = [];
      const net = new NetworkTiles(netFetch(fetched));
      await net.loadManifest();
      await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 0);
      expect(new Set(net.loadedStreets().map((s) => s.name))).toEqual(
        new Set(["Broadway", "Elm Street"]),
      );
      await net.visibleFeatures({ west: 1.3, south: 0.4, east: 1.6, north: 0.6 }, 0);
      expect(new Set(net.loadedStreets().map((s) => s.name))).toEqual(
        new Set(["Broadway", "Elm Street", "Oak Road"]),
      );
      expect(fetched.filter((f) => f === "nettiles/0_0.json")).toHaveLength(1);
    });
  });

  it("margin pulls in the neighbouring tile", async () => {
    const net = new NetworkTiles(netFetch([]));
    await net.loadManifest();
    const feats = await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 1);
    expect(feats.length).toBe(5); // 0_0 (4) + 1_0 (1)
  });
});

describe("NetworkTiles over a long session", () => {
  // A strip of 30 tiles, one named street in each, panned across one at a time.
  const N = 30;
  const world = (
    fetched: string[],
    gate?: { tiles: Set<string>; open: Promise<void> },
  ): (<T>(name: string) => Promise<T>) => {
    return async <T,>(name: string): Promise<T> => {
      fetched.push(name);
      if (name === "nettiles/manifest.json") {
        const tiles = Array.from({ length: N }, (_v, c) => `${c}_0`);
        return { originLon: 0, originLat: 0, tileDeg: 1, tiles } as T;
      }
      const key = name.replace("nettiles/", "").replace(".json", "");
      if (gate?.tiles.has(key)) await gate.open;
      const c = Number(key.split("_")[0]);
      return {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: `Street ${c}` },
            geometry: { type: "LineString", coordinates: [[c + 0.2, 0.5], [c + 0.4, 0.5]] },
          },
        ],
      } as T;
    };
  };
  const view = (c0: number, c1 = c0): BBox => ({ west: c0 + 0.3, south: 0.4, east: c1 + 0.6, north: 0.6 });

  it("lets the tiles shown longest ago go, instead of keeping every one", async () => {
    const fetched: string[] = [];
    const net = new NetworkTiles(world(fetched), 10);
    await net.loadManifest();
    for (let c = 0; c < N; c++) await net.visibleFeatures(view(c), 0);
    // only the last ten views' streets are still held, and still searchable
    const held = net.loadedStreets().map((s) => s.name);
    expect(held).toHaveLength(10);
    expect(held).toContain("Street 29");
    expect(held).not.toContain("Street 0");
    // going back is a fetch again, and the street is back
    const feats = await net.visibleFeatures(view(0), 0);
    expect(feats).toHaveLength(1);
    expect(fetched.filter((f) => f === "nettiles/0_0.json")).toHaveLength(2);
    expect(net.loadedStreets().map((s) => s.name)).toContain("Street 0");
  });

  it("keeps what was shown recently, not what was fetched first", async () => {
    const fetched: string[] = [];
    const net = new NetworkTiles(world(fetched), 10);
    await net.loadManifest();
    for (let c = 1; c < N; c++) {
      await net.visibleFeatures(view(0), 0); // home, looked at again and again
      await net.visibleFeatures(view(c), 0);
    }
    expect(fetched.filter((f) => f === "nettiles/0_0.json")).toHaveLength(1);
    expect(net.loadedStreets().map((s) => s.name)).toContain("Street 0");
  });

  it("never lets go of a tile a pending view has yet to read", async () => {
    let open = (): void => undefined;
    const gate = {
      tiles: new Set(["1_0", "2_0", "3_0", "4_0"]),
      open: new Promise<void>((resolve) => {
        open = resolve;
      }),
    };
    const net = new NetworkTiles(world([], gate), 2);
    await net.loadManifest();
    // A wide view, bigger than the whole budget. Its first tile lands at once
    // and becomes the oldest held; the rest are slow to arrive.
    const wide = net.visibleFeatures(view(0, 4), 0);
    // meanwhile the map moves on twice, and each move evicts
    await net.visibleFeatures(view(10, 12), 0);
    await net.visibleFeatures(view(20, 22), 0);
    open();
    expect((await wide).map((f) => f.properties?.["name"])).toEqual([
      "Street 0",
      "Street 1",
      "Street 2",
      "Street 3",
      "Street 4",
    ]);
    expect(net.loadedCount).toBeLessThanOrEqual(2);
  });
});

describe("bboxOf", () => {
  it("bounds the points and pads by metres", () => {
    const box = bboxOf([[-71.1, 42.38], [-71.05, 42.4]], 0);
    expect(box.west).toBeCloseTo(-71.1);
    expect(box.east).toBeCloseTo(-71.05);
    expect(box.south).toBeCloseTo(42.38);
    expect(box.north).toBeCloseTo(42.4);
    const padded = bboxOf([[-71.1, 42.38]], 1000);
    expect(padded.west).toBeLessThan(-71.1);
    expect(padded.north).toBeGreaterThan(42.38);
  });
});

// ── the corridor walk ───────────────────────────────────────────────────────
// ensureCorridor decides which slice of the graph a route can see. Too narrow
// and the router silently returns a worse route (a narrowed corridor once took
// a Wellesley->Revere trip from 50% protected to 34%); too wide and a phone
// pulls megabytes it doesn't need. Tested through the public surface, by
// recording which tiles get asked for.

describe("ensureCorridor", () => {
  /** A 6x6 world of 1-degree tiles from (0,0), and a loader that records asks. */
  function store(): { s: TileStore; asked: string[] } {
    const asked: string[] = [];
    const tiles: string[] = [];
    for (let c = 0; c < 6; c++) for (let r = 0; r < 6; r++) tiles.push(`${c}_${r}`);
    const s = new TileStore(async <T,>(name: string): Promise<T> => {
      if (name.endsWith("manifest.json")) {
        return {
          originLon: 0, originLat: 0, tileDeg: 1,
          classes: ["quiet_street"], tiles,
        } as T;
      }
      asked.push(name);
      return { nodes: [], nodeIds: [], edges: [], names: [], geoms: [] } as T;
    });
    return { s, asked };
  }

  const key = (name: string): string => name.replace("tiles/", "").replace(".json", "");

  it("covers every cell the line passes through, not just its ends", async () => {
    const { s, asked } = store();
    await s.loadManifest();
    await s.ensureCorridor(
      [
        [0.5, 0.5],
        [4.5, 0.5],
      ],
      0,
    );
    const keys = asked.map(key);
    // the ends
    expect(keys).toContain("0_0");
    expect(keys).toContain("4_0");
    // and the cells between them, which a naive endpoints-only walk would skip
    expect(keys).toContain("1_0");
    expect(keys).toContain("2_0");
    expect(keys).toContain("3_0");
  });

  it("widens by whole cells with the margin", async () => {
    const tight = store();
    await tight.s.loadManifest();
    await tight.s.ensureCorridor([[2.5, 2.5]], 0);
    expect(tight.asked).toHaveLength(1);

    const wide = store();
    await wide.s.loadManifest();
    await wide.s.ensureCorridor([[2.5, 2.5]], 1);
    expect(wide.asked).toHaveLength(9); // one ring of neighbours
  });

  it("never asks for a tile the manifest doesn't list", async () => {
    const { s, asked } = store();
    await s.loadManifest();
    // out at sea, far outside the published 6x6
    await s.ensureCorridor([[40, 40]], 2);
    expect(asked).toEqual([]);
  });

  it("reports whether anything new arrived", async () => {
    const { s } = store();
    await s.loadManifest();
    expect(await s.ensureCorridor([[2.5, 2.5]], 0)).toBe(true);
    // asking again for the same cell loads nothing new
    expect(await s.ensureCorridor([[2.5, 2.5]], 0)).toBe(false);
  });

  it("handles an empty route without asking for anything", async () => {
    const { s, asked } = store();
    await s.loadManifest();
    expect(await s.ensureCorridor([], 1)).toBe(false);
    expect(asked).toEqual([]);
  });
});
