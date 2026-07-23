// Tests for on-demand routing tiles: the store must fetch only the tiles a
// bbox needs, merge boundary nodes (shared global id) so tiles stitch together,
// and produce a GraphData the Router can route across tile seams.
import { describe, expect, it } from "vitest";

import { Router } from "../src/router.js";
import { bboxOf, TileStore } from "../src/tiles.js";

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
