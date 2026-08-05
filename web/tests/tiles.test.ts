// Tests for on-demand routing tiles: the store must fetch only the tiles a
// bbox needs, merge boundary nodes (shared global id) so tiles stitch together,
// and produce a GraphData the Router can route across tile seams.
import { describe, expect, it } from "vitest";

import { Router } from "../src/router.js";
import { bboxOf, NetworkTiles, TileStore } from "../src/tiles.js";

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
  const feat = (lon: number): unknown => ({
    type: "Feature",
    properties: { cls: "path", color: "#000", name: null, source: "osm", crashes: 0 },
    geometry: { type: "LineString", coordinates: [[lon, 0.5], [lon + 0.05, 0.5]] },
  });
  const netFetch = (fetched: string[]): (<T>(name: string) => Promise<T>) => {
    const table: Record<string, unknown> = {
      "nettiles/manifest.json": NET_MANIFEST,
      "nettiles/0_0.json": { type: "FeatureCollection", features: [feat(0.2), feat(0.6)] },
      "nettiles/1_0.json": { type: "FeatureCollection", features: [feat(1.4)] },
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
    expect(feats.length).toBe(2); // both features of tile 0_0
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

  it("margin pulls in the neighbouring tile", async () => {
    const net = new NetworkTiles(netFetch([]));
    await net.loadManifest();
    const feats = await net.visibleFeatures({ west: 0.3, south: 0.4, east: 0.6, north: 0.6 }, 1);
    expect(feats.length).toBe(3); // 0_0 (2) + 1_0 (1)
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
