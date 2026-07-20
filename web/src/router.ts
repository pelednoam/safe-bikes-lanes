// In-browser safest-route computation over the exported graph
// (web/data/graph.json, written by pipeline/export_web.py).

import type {
  Caution,
  FeatureCollection,
  LineFeature,
  ProtectionClass,
  RideMode,
  RoutePayload,
  RouteResponse,
} from "./types.js";

/** Raw shape of graph.json. */
interface GraphData {
  nodes: [number, number][];
  names: string[];
  classes: ProtectionClass[];
  /** [u, v, len_m, w_kids, w_solo, clsIdx, nameIdx, geomIdx] */
  edges: [number, number, number, number, number, number, number, number][];
  geoms: number[][];
}

const CLASS_COLORS: Record<ProtectionClass, string> = {
  path: "#1a9850",
  separated: "#66bd63",
  buffered: "#a6d96a",
  quiet_street: "#d9ef8b",
  service: "#d9ef8b",
  lane: "#fee08b",
  sharrow: "#fdae61",
  moderate_street: "#f46d43",
  busy_street: "#d73027",
};

const CAUTION_CLASSES: ReadonlySet<ProtectionClass> = new Set([
  "sharrow",
  "moderate_street",
  "busy_street",
]);

const MAX_SNAP_METERS = 500;
const KID_PACE_KMH = 10;

type WeightColumn = 2 | 3 | 4; // len, kids, solo

// ---------------------------------------------------------------------------
// binary min-heap of (priority, value)
// ---------------------------------------------------------------------------

class MinHeap {
  private prio: number[] = [];
  private val: number[] = [];

  get size(): number {
    return this.prio.length;
  }

  push(priority: number, value: number): void {
    const { prio, val } = this;
    let i = prio.length;
    prio.push(priority);
    val.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pp = prio[parent] as number;
      if (pp <= priority) break;
      prio[i] = pp;
      val[i] = val[parent] as number;
      i = parent;
    }
    prio[i] = priority;
    val[i] = value;
  }

  pop(): [number, number] | null {
    const { prio, val } = this;
    const n = prio.length;
    if (n === 0) return null;
    const topP = prio[0] as number;
    const topV = val[0] as number;
    const lastP = prio.pop() as number;
    const lastV = val.pop() as number;
    if (n > 1) {
      let i = 0;
      const m = prio.length;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= m) break;
        const right = child + 1;
        if (right < m && (prio[right] as number) < (prio[child] as number)) child = right;
        if ((prio[child] as number) >= lastP) break;
        prio[i] = prio[child] as number;
        val[i] = val[child] as number;
        i = child;
      }
      prio[i] = lastP;
      val[i] = lastV;
    }
    return [topP, topV];
  }
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export class Router {
  private readonly g: GraphData;
  /** adjacency: per node, indices into g.edges */
  private readonly adj: number[][];

  constructor(data: GraphData) {
    this.g = data;
    this.adj = data.nodes.map(() => []);
    data.edges.forEach((e, i) => {
      const nodeEdges = this.adj[e[0]];
      if (nodeEdges) nodeEdges.push(i);
    });
  }

  static async load(url: string): Promise<Router> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`failed to load graph (${resp.status})`);
    return new Router((await resp.json()) as GraphData);
  }

  nearestNode(lon: number, lat: number): number {
    const scaleX = Math.cos((lat * Math.PI) / 180) * 111_320;
    const scaleY = 110_540;
    let best = -1;
    let bestD2 = Infinity;
    this.g.nodes.forEach(([nx, ny], i) => {
      const dx = (nx - lon) * scaleX;
      const dy = (ny - lat) * scaleY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    });
    if (best < 0 || bestD2 > MAX_SNAP_METERS ** 2) {
      throw new Error("point is too far from the Cambridge/Somerville network");
    }
    return best;
  }

  /** Dijkstra; returns the edge-index path, or null if unreachable. */
  private shortestPath(from: number, to: number, w: WeightColumn): number[] | null {
    const n = this.g.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prevEdge = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[from] = 0;
    const heap = new MinHeap();
    heap.push(0, from);
    while (heap.size > 0) {
      const popped = heap.pop();
      if (popped === null) break;
      const [d, u] = popped;
      if (done[u]) continue;
      done[u] = 1;
      if (u === to) break;
      const edges = this.adj[u];
      if (!edges) continue;
      for (const ei of edges) {
        const e = this.g.edges[ei];
        if (!e) continue;
        const v = e[1];
        if (done[v]) continue;
        const nd = d + e[w];
        if (nd < (dist[v] as number)) {
          dist[v] = nd;
          prevEdge[v] = ei;
          heap.push(nd, v);
        }
      }
    }
    if (dist[to] === Infinity) return null;
    const path: number[] = [];
    let cur = to;
    while (cur !== from) {
      const ei = prevEdge[cur] as number;
      if (ei < 0) return null;
      path.push(ei);
      const e = this.g.edges[ei];
      if (!e) return null;
      cur = e[0];
    }
    path.reverse();
    return path;
  }

  private edgeCoords(ei: number): [number, number][] {
    const e = this.g.edges[ei];
    if (!e) return [];
    const geomIdx = e[7];
    const geom = geomIdx >= 0 ? this.g.geoms[geomIdx] : undefined;
    if (geom !== undefined) {
      const coords: [number, number][] = [];
      for (let i = 0; i + 1 < geom.length; i += 2) {
        coords.push([geom[i] as number, geom[i + 1] as number]);
      }
      return coords;
    }
    const a = this.g.nodes[e[0]];
    const b = this.g.nodes[e[1]];
    return a && b ? [a, b] : [];
  }

  private payload(edgePath: number[]): RoutePayload {
    const features: LineFeature[] = [];
    const byClass = new Map<ProtectionClass, number>();
    const cautions: Caution[] = [];
    let total = 0;
    for (const ei of edgePath) {
      const e = this.g.edges[ei];
      if (!e) continue;
      const cls = this.g.classes[e[5]] ?? "quiet_street";
      const name = this.g.names[e[6]] ?? "";
      const length = e[2];
      total += length;
      byClass.set(cls, (byClass.get(cls) ?? 0) + length);
      if (CAUTION_CLASSES.has(cls)) {
        const prev = cautions[cautions.length - 1];
        const label = name || "unnamed";
        if (prev && prev.name === label && prev.cls === cls) prev.meters += length;
        else cautions.push({ name: label, cls, meters: length });
      }
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: this.edgeCoords(ei) },
        properties: { cls, color: CLASS_COLORS[cls], name: name || null },
      });
    }
    const sum = (classes: ProtectionClass[]): number =>
      classes.reduce((acc, c) => acc + (byClass.get(c) ?? 0), 0);
    const geojson: FeatureCollection = { type: "FeatureCollection", features };
    return {
      geojson,
      summary: {
        meters: Math.round(total),
        minutes: Math.round((total / 1000 / KID_PACE_KMH) * 60),
        pct_protected: total > 0 ? Math.round((100 * sum(["path", "separated", "buffered"])) / total) : 0,
        pct_quiet: total > 0 ? Math.round((100 * sum(["quiet_street", "service"])) / total) : 0,
        by_class_m: Object.fromEntries(
          [...byClass.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([c, m]) => [c, Math.round(m)]),
        ) as Partial<Record<ProtectionClass, number>>,
        cautions: cautions
          .filter((c) => c.meters >= 15)
          .map((c) => ({ ...c, meters: Math.round(c.meters) })),
      },
    };
  }

  route(
    start: [number, number],
    end: [number, number],
    mode: RideMode,
  ): RouteResponse {
    const a = this.nearestNode(start[0], start[1]);
    const b = this.nearestNode(end[0], end[1]);
    if (a === b) throw new Error("start and end snap to the same intersection");
    const wCol: WeightColumn = mode === "kids" ? 3 : 4;
    const safestPath = this.shortestPath(a, b, wCol);
    const shortestPath = this.shortestPath(a, b, 2);
    if (safestPath === null || shortestPath === null) throw new Error("no path found");
    const safest = this.payload(safestPath);
    const shortest = this.payload(shortestPath);
    safest.summary.shortest_meters = shortest.summary.meters;
    safest.summary.detour_pct =
      shortest.summary.meters > 0
        ? Math.round(100 * (safest.summary.meters / shortest.summary.meters - 1))
        : 0;
    return { safest, shortest };
  }
}
