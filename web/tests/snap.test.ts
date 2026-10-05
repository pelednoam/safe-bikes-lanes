// Snapping a point to the graph: the nearest edge (for sketchy marks,
// construction zones, what-if builds, street names) and the nearest node (for
// the start and end of every route).
//
// Both used to scan everything. Construction snaps 55,956 zone vertices one at
// a time, so a router rebuild over the Davis-to-Kendall tiles spent 18.8 s
// there as a single long task — and rebuilt again whenever a search result
// pulled in a tile. They now go through a grid, and the tests here hold the
// grid to the answer the scan gave, point for point, ties included: the
// speed-up is only worth having if no route changes because of it.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { type GraphData, PointIndex, Router } from "../src/router.js";
import { TileStore } from "../src/tiles.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

/** Deterministic PRNG, so a failure names a case that can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The scan the index replaced, verbatim: same metric, first strict
 * improvement in index order wins, null beyond maxM. */
function bruteNearest(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  lon: number,
  lat: number,
  maxM: number,
): number | null {
  const scaleX = Math.cos((lat * Math.PI) / 180) * 111_320;
  const scaleY = 110_540;
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const dx = ((xs[i] as number) - lon) * scaleX;
    const dy = ((ys[i] as number) - lat) * scaleY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best >= 0 && bestD2 <= maxM ** 2 ? best : null;
}

function midpoints(g: GraphData): { xs: Float64Array; ys: Float64Array } {
  const xs = new Float64Array(g.edges.length);
  const ys = new Float64Array(g.edges.length);
  g.edges.forEach((e, i) => {
    const a = g.nodes[e[0]];
    const b = g.nodes[e[1]];
    if (a && b) {
      xs[i] = (a[0] + b[0]) / 2;
      ys[i] = (a[1] + b[1]) / 2;
    }
  });
  return { xs, ys };
}

describe("the nearest-point index, on synthetic points", () => {
  it("gives the brute-force answer, including ties, grid-line points and misses", () => {
    const rand = rng(7);
    const xs: number[] = [];
    const ys: number[] = [];
    // a dense town, a sparse suburb, and a far-off outlier
    for (let i = 0; i < 3000; i++) {
      xs.push(-71.12 + rand() * 0.02);
      ys.push(42.37 + rand() * 0.02);
    }
    for (let i = 0; i < 300; i++) {
      xs.push(-71.3 + rand() * 0.2);
      ys.push(42.2 + rand() * 0.2);
    }
    xs.push(-70.0);
    ys.push(41.5);
    // exact duplicates, later in the list than the original, so the tie has
    // to go to the lower index to match
    for (let i = 0; i < 200; i++) {
      const j = Math.floor(rand() * xs.length);
      xs.push(xs[j] as number);
      ys.push(ys[j] as number);
    }
    // points sitting exactly on cell boundaries (multiples of the grid step
    // from the first point, which is where the grid is anchored)
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    for (let i = 0; i < 200; i++) {
      xs.push(x0 + Math.floor(rand() * 300) * 0.001);
      ys.push(y0 + Math.floor(rand() * 300) * 0.001);
    }
    const index = new PointIndex(Float64Array.from(xs), Float64Array.from(ys));

    const queries: [number, number][] = [];
    for (let i = 0; i < 4000; i++) queries.push([-71.35 + rand() * 0.3, 42.15 + rand() * 0.3]);
    // on a point exactly, and exactly between two
    for (let i = 0; i < 300; i++) {
      const j = Math.floor(rand() * xs.length);
      const k = Math.floor(rand() * xs.length);
      queries.push([xs[j] as number, ys[j] as number]);
      queries.push([((xs[j] as number) + (xs[k] as number)) / 2, ((ys[j] as number) + (ys[k] as number)) / 2]);
    }
    // on grid lines, and nowhere near anything
    for (let i = 0; i < 200; i++) {
      queries.push([x0 + Math.floor(rand() * 400) * 0.001, y0 + Math.floor(rand() * 400) * 0.001]);
    }
    queries.push([-60, 30], [0, 0], [-71.11, 44]);

    let hits = 0;
    const wrong: string[] = [];
    for (const maxM of [0, 5, 30, 40, 500, 5_000, Infinity]) {
      for (const [lon, lat] of queries) {
        const want = bruteNearest(xs, ys, lon, lat, maxM);
        const got = index.nearest(lon, lat, maxM);
        if (got !== want) wrong.push(`(${lon}, ${lat}) within ${maxM} m: ${got} not ${want}`);
        if (want !== null) hits++;
      }
    }
    expect(wrong).toEqual([]);
    // not vacuous: plenty of queries find something, and plenty deliberately don't
    expect(hits).toBeGreaterThan(queries.length * 2);
    expect(hits).toBeLessThan(queries.length * 6);
  });

  it("hands an exact tie to the lower index even when it finds the higher one first", () => {
    // Two points exactly as far from the query, one north and one south, in
    // different cells. (Values chosen to be exact in binary, so the tie is a
    // real one.) The search reaches the southern cell first; the scan would
    // have kept point 0, so the index has to as well. Random data almost never
    // produces a tie across cells, which is why this case is spelled out.
    const xs = [-71.1, -71.1];
    const ys = [42.5 + 0.00390625, 42.5 - 0.00390625];
    const index = new PointIndex(xs, ys);
    expect(bruteNearest(xs, ys, -71.1, 42.5, 1000)).toBe(0);
    expect(index.nearest(-71.1, 42.5, 1000)).toBe(0);
  });

  it("answers an empty set, and a set with no finite point, with nothing", () => {
    expect(new PointIndex([], []).nearest(-71.1, 42.4, Infinity)).toBeNull();
    expect(new PointIndex([NaN], [42]).nearest(-71.1, 42.4, Infinity)).toBeNull();
  });

  it("never picks a point without coordinates, as the scan never did", () => {
    const xs = [NaN, -71.1, -71.1];
    const ys = [42.4, 42.4, 42.4];
    expect(new PointIndex(xs, ys).nearest(-71.1, 42.4, 10)).toBe(bruteNearest(xs, ys, -71.1, 42.4, 10));
    expect(new PointIndex(xs, ys).nearest(-71.1, 42.4, 10)).toBe(1);
  });
});

/** The first thing a rider does: Davis Square to Kendall, loaded exactly as
 * the app loads it (ensureRouter pads a trip by 1200 m, one margin cell). */
const DAVIS: [number, number] = [-71.1223, 42.3967];
const KENDALL: [number, number] = [-71.0862, 42.3625];

async function loadJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(DATA, name), "utf8")) as T;
}

interface ConstructionFC {
  features: { geometry: { type: string; coordinates: unknown } }[];
}

/** Every vertex of every zone, as app.ts's constructionAvoidPoints feeds them. */
function zoneVertices(fc: ConstructionFC): [number, number][] {
  const pts: [number, number][] = [];
  const push = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      pts.push([c[0], c[1]]);
    }
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === "Point") push(g.coordinates);
    else if (g.type === "LineString" && Array.isArray(g.coordinates)) {
      for (const c of g.coordinates) push(c);
    } else if (Array.isArray(g.coordinates)) {
      for (const part of g.coordinates) if (Array.isArray(part)) for (const c of part) push(c);
    }
  }
  return pts;
}

/** How long a fixed amount of plain arithmetic takes on this machine right now (ms, the fastest
 * of five runs): the unit the timing bounds below are written in. A slow or busy machine moves
 * the bound with it, where a bound in milliseconds fails a build that has not regressed. */
function machineUnit(): number {
  let best = Infinity;
  for (let run = 0; run < 5; run++) {
    const t0 = performance.now();
    let sum = 0;
    for (let i = 1; i < 3_000_000; i++) sum += Math.sqrt(i);
    best = Math.min(best, performance.now() - t0);
    if (sum < 0) throw new Error("unreachable: keeps the loop from being optimised away");
  }
  return best;
}

describe("snapping on the real map", () => {
  let graph: GraphData;
  let zones: [number, number][];

  beforeAll(async () => {
    const tiles = new TileStore(loadJson);
    await tiles.loadManifest();
    await tiles.ensureCorridor([DAVIS, KENDALL], 1 + Math.round(1200 / 2200));
    graph = tiles.assemble();
    zones = zoneVertices(await loadJson<ConstructionFC>("construction.geojson"));
  }, 60_000);

  it("is loading what the app loads", () => {
    expect(graph.edges.length).toBeGreaterThan(20_000);
    expect(zones.length).toBeGreaterThan(10_000);
  });

  it("snaps to the same edge and node the scan did, everywhere on the corridor", { timeout: 60_000 }, () => {
    const router = new Router(graph);
    const { xs, ys } = midpoints(graph);
    const nx = graph.nodes.map((n) => n[0]);
    const ny = graph.nodes.map((n) => n[1]);
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const [x, y] of graph.nodes) {
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    }
    const rand = rng(42);
    const queries: [number, number][] = [];
    // anywhere across the loaded area and a little beyond it
    for (let i = 0; i < 1500; i++) {
      queries.push([
        west - 0.01 + rand() * (east - west + 0.02),
        south - 0.01 + rand() * (north - south + 0.02),
      ]);
    }
    // real construction vertices, which is the load that was slow
    const nearby = zones.filter(([x, y]) => x >= west && x <= east && y >= south && y <= north);
    for (let i = 0; i < 1500; i++) {
      queries.push(nearby[Math.floor(rand() * nearby.length)] as [number, number]);
    }
    // exactly on nodes (where two-way edges share a midpoint: a tie every time)
    for (let i = 0; i < 300; i++) {
      const n = graph.nodes[Math.floor(rand() * graph.nodes.length)] as [number, number, number];
      queries.push([n[0], n[1]]);
    }
    const nodeOrNull = (lon: number, lat: number): number | null => {
      try {
        return router.nearestNode(lon, lat);
      } catch (err) {
        expect(String(err)).toMatch(/too far/);
        return null;
      }
    };
    let edgeHits = 0;
    let nodeMisses = 0;
    const wrong: string[] = [];
    for (const [lon, lat] of queries) {
      const want = bruteNearest(xs, ys, lon, lat, 40);
      const got = router.nearestEdge(lon, lat, 40);
      if (got !== want) wrong.push(`edge near (${lon}, ${lat}): ${got} not ${want}`);
      if (want !== null) edgeHits++;
      const wantNode = bruteNearest(nx, ny, lon, lat, 500);
      const gotNode = nodeOrNull(lon, lat);
      if (gotNode !== wantNode) wrong.push(`node near (${lon}, ${lat}): ${gotNode} not ${wantNode}`);
      if (wantNode === null) nodeMisses++;
    }
    expect(wrong).toEqual([]);
    expect(edgeHits).toBeGreaterThan(500);
    expect(nodeMisses).toBeGreaterThan(0);
  });

  it("marks the same construction edges the scan did", { timeout: 60_000 }, () => {
    // a sample, because the scan it is compared with is the slow thing: every
    // zone vertex beside the corridor and a few hundred from far away
    const rand = rng(3);
    const [bw, bs, be, bn] = [-71.13, 42.355, -71.08, 42.4];
    const near = zones.filter(([x, y]) => x >= bw && x <= be && y >= bs && y <= bn);
    const sample = [
      ...near.filter(() => rand() < 0.3),
      ...Array.from({ length: 300 }, () => zones[Math.floor(rand() * zones.length)] as [number, number]),
    ];
    const { xs, ys } = midpoints(graph);
    const reverse = new Map<string, number[]>();
    graph.edges.forEach((e, i) => {
      const key = `${e[0]},${e[1]}`;
      reverse.set(key, [...(reverse.get(key) ?? []), i]);
    });
    const want = new Set<number>();
    for (const [lon, lat] of sample) {
      const ei = bruteNearest(xs, ys, lon, lat, 40);
      if (ei === null) continue;
      want.add(ei);
      const e = graph.edges[ei];
      if (e) for (const rev of reverse.get(`${e[1]},${e[0]}`) ?? []) want.add(rev);
    }
    // Enough edges that agreeing with the scan means something. The zones are the permit feed
    // in the data snapshot CI fetches, and it shrinks as permits expire between snapshots (928
    // features in one, 734 in the next): a floor of 50 suited the first (68 edges) and failed
    // the build on the second (44).
    expect(want.size).toBeGreaterThan(20);

    // construction and what-if builds share one point-to-edge-set path, and
    // only the what-if reports its size
    expect(new Router(graph).setUpgradedPoints(sample, 40)).toBe(want.size);
  });

  it("snaps every construction vertex in well under a second, not eighteen", () => {
    const unit = machineUnit();
    // the fastest of three, as the unit is: a burst of load must not fail it
    let ms = Infinity;
    for (let run = 0; run < 3; run++) {
      const router = new Router(graph);
      const t0 = performance.now();
      router.setConstructionPoints(zones);
      ms = Math.min(ms, performance.now() - t0);
    }
    // About 2 units with the index (10-13 ms where one unit is 7 ms), and 340 times that
    // before it (18,850 ms against 55 on the machine this was written on). 100 units leaves
    // a loaded runner fifty times the room, and still fails a scan.
    expect(ms / unit).toBeLessThan(100);
  }, 60_000);
});

describe("rebuilding the router over a long session's tiles", () => {
  it("builds and makes its first snaps in a fraction of a second", { timeout: 60_000 }, () => {
    // Every time the loaded tiles grow, the app builds a new Router and snaps
    // construction, marks and the route ends to it. After an afternoon of
    // searching and riding that is hundreds of tiles; 800,000 edges here, a
    // street grid about 30 km on a side.
    const unit = machineUnit();
    const n = 450;
    const nodes: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) nodes.push([-71.3 + i * 0.0008, 42.2 + j * 0.0006, 10]);
    }
    const edges: GraphData["edges"] = [];
    const road = (u: number, v: number): void => {
      edges.push([u, v, 66, 0, 0, -1, 1, 0, 0, 0], [v, u, 66, 0, 0, -1, 1, 0, 0, 0]);
    };
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i + 1 < n) road(i * n + j, (i + 1) * n + j);
        if (j + 1 < n) road(i * n + j, i * n + j + 1);
      }
    }
    const graph: GraphData = { nodes, names: [""], classes: ["quiet_street"], edges, geoms: [] };
    // fastest of three, so a busy machine's worst moment is not the measure
    let fastest = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      const router = new Router(graph);
      router.setConstructionPoints([[-71.2, 42.3]]);
      router.nearestNode(-71.2, 42.3);
      fastest = Math.min(fastest, performance.now() - t0);
    }
    // 1,100-1,500 ms when reverse edges were looked up by "u,v" strings and
    // the grid was a hash map, 120-290 ms after, on the machine this was
    // written on: 17-27 units (one is 7 ms here) against ten times that. 100 units is
    // between them, and moves with the machine.
    expect(fastest / unit).toBeLessThan(100);
  });
});
