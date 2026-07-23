// On-demand routing-graph tiles. The browser loads only the tiles covering a
// route's corridor (see pipeline/export_web.py export_tiles) instead of the
// whole 23 MB graph, so coverage can grow toward all of MA without an
// unbounded download. Loaded tiles are merged into one GraphData subset that
// the existing Router consumes unchanged — a tile is a self-contained
// sub-graph, and boundary nodes carry a stable GLOBAL id so tiles stitch
// together seamlessly when adjacent ones are loaded.

import type { GraphData } from "./router.js";
import type { ProtectionClass } from "./types.js";

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface Manifest {
  originLon: number;
  originLat: number;
  tileDeg: number;
  classes: ProtectionClass[];
  tiles: string[];
}

/** One tile's self-contained sub-graph (pipeline/export_web._build_tile).
 * edge = [u, v, len, clsIdx(global), nameIdx(local), geomIdx(local), crash,
 * pen, climb, busy]; nodeIds[i] is node i's global index for cross-tile merge. */
interface RawTile {
  nodes: [number, number, number][];
  nodeIds: number[];
  names: string[];
  edges: [
    number, number, number, number, number, number, number, number, number, number,
  ][];
  geoms: number[][];
}

export class TileStore {
  private manifest: Manifest | null = null;
  private existing = new Set<string>();
  private readonly loaded = new Map<string, RawTile>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly fetchJson: <T>(name: string) => Promise<T>) {}

  async loadManifest(): Promise<void> {
    const m = await this.fetchJson<Manifest>("tiles/manifest.json");
    this.manifest = m;
    this.existing = new Set(m.tiles);
  }

  get classes(): ProtectionClass[] {
    return this.manifest?.classes ?? [];
  }

  /** Number of tiles held in memory — the Router only needs rebuilding when
   * this grows. */
  get loadedCount(): number {
    return this.loaded.size;
  }

  private keyAt(lon: number, lat: number): [number, number] {
    const m = this.manifest;
    if (!m) throw new Error("tile manifest not loaded");
    return [
      Math.floor((lon - m.originLon) / m.tileDeg),
      Math.floor((lat - m.originLat) / m.tileDeg),
    ];
  }

  /** Existing tile keys covering the bbox, grown by `margin` tiles on each side
   * (safe routes often detour outside the straight A–B box). */
  keysForBBox(box: BBox, margin = 1): string[] {
    if (!this.manifest) throw new Error("tile manifest not loaded");
    const [c0, r0] = this.keyAt(box.west, box.south);
    const [c1, r1] = this.keyAt(box.east, box.north);
    const keys: string[] = [];
    for (let c = c0 - margin; c <= c1 + margin; c++) {
      for (let r = r0 - margin; r <= r1 + margin; r++) {
        const key = `${c}_${r}`;
        if (this.existing.has(key)) keys.push(key);
      }
    }
    return keys;
  }

  /** Fetch every not-yet-loaded tile covering the bbox. Returns true when at
   * least one new tile arrived (so the caller should rebuild its Router). */
  async ensure(box: BBox, margin = 1): Promise<boolean> {
    const keys = this.keysForBBox(box, margin);
    const before = this.loaded.size;
    await Promise.all(keys.map((k) => this.fetchTile(k)));
    return this.loaded.size > before;
  }

  private async fetchTile(key: string): Promise<void> {
    if (this.loaded.has(key)) return;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.fetchJson<RawTile>(`tiles/${key}.json`)
      .then((tile) => {
        this.loaded.set(key, tile);
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  /** Merge every loaded tile into one GraphData the Router can consume.
   * Boundary nodes (shared global id) collapse to one; names and geoms are
   * re-tabled; class indices are already global (shared table). */
  assemble(): GraphData {
    const classes = this.classes;
    const nodes: [number, number, number][] = [];
    const nodeOf = new Map<number, number>(); // global node id -> merged index
    const names: string[] = [];
    const nameOf = new Map<string, number>();
    const geoms: number[][] = [];
    const edges: GraphData["edges"] = [];

    const localName = (s: string): number => {
      let i = nameOf.get(s);
      if (i === undefined) {
        i = names.length;
        names.push(s);
        nameOf.set(s, i);
      }
      return i;
    };

    for (const tile of this.loaded.values()) {
      const nodeMap = tile.nodeIds.map((gid, li) => {
        let mi = nodeOf.get(gid);
        if (mi === undefined) {
          mi = nodes.length;
          nodes.push(tile.nodes[li] as [number, number, number]);
          nodeOf.set(gid, mi);
        }
        return mi;
      });
      for (const e of tile.edges) {
        let geomIdx = -1;
        if (e[5] >= 0) {
          geomIdx = geoms.length;
          geoms.push(tile.geoms[e[5]] as number[]);
        }
        edges.push([
          nodeMap[e[0]] as number,
          nodeMap[e[1]] as number,
          e[2],
          e[3],
          localName(tile.names[e[4]] ?? ""),
          geomIdx,
          e[6],
          e[7],
          e[8],
          e[9],
        ]);
      }
    }
    return { nodes, names, classes, edges, geoms };
  }
}

/** Bounding box of a set of points, padded by `padM` metres. */
export function bboxOf(points: [number, number][], padM = 0): BBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const lat = (south + north) / 2;
  const dLat = padM / 110_540;
  const dLon = padM / (Math.cos((lat * Math.PI) / 180) * 111_320);
  return { west: west - dLon, south: south - dLat, east: east + dLon, north: north + dLat };
}
