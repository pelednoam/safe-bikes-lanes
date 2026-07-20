// In-browser safest-route computation over the exported graph
// (web/data/graph.json, written by pipeline/export_web.py).

import type {
  Caution,
  FeatureCollection,
  LineFeature,
  ProtectionClass,
  RideMode,
  RouteOption,
  RoutePayload,
  RouteResponse,
  SafetyGrade,
} from "./types.js";

/** Raw shape of graph.json. */
interface GraphData {
  nodes: [number, number][];
  names: string[];
  classes: ProtectionClass[];
  /** [u, v, len_m, w_kids, w_solo, clsIdx, nameIdx, geomIdx, crashFactor, climb_m] */
  edges: [
    number, number, number, number, number, number, number, number, number, number,
  ][];
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
const PROTECTED: ReadonlySet<ProtectionClass> = new Set(["path", "separated"]);
const HOTSPOT_CRASH_FACTOR = 1.25;
// Flat preference: each meter of climb costs this many meters-equivalent,
// doubled on grades steeper than 4% (hard with kids' bikes).
const HILL_EQUIV_M = 12;
const STEEP_GRADE = 0.04;

function fmt(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

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
  /** per-edge meters-equivalent penalty applied when "prefer flat" is on */
  private readonly hillPen: Float64Array;

  constructor(data: GraphData) {
    this.g = data;
    this.adj = data.nodes.map(() => []);
    this.hillPen = new Float64Array(data.edges.length);
    data.edges.forEach((e, i) => {
      const nodeEdges = this.adj[e[0]];
      if (nodeEdges) nodeEdges.push(i);
      const climb = e[9] ?? 0;
      const grade = e[2] > 0 ? climb / e[2] : 0;
      this.hillPen[i] = climb * HILL_EQUIV_M * (grade > STEEP_GRADE ? 2 : 1);
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
  private shortestPath(
    from: number,
    to: number,
    w: WeightColumn,
    hills = false,
  ): number[] | null {
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
        const nd = d + e[w] + (hills ? (this.hillPen[ei] as number) : 0);
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
    let climb = 0;
    for (const ei of edgePath) {
      const e = this.g.edges[ei];
      if (!e) continue;
      const cls = this.g.classes[e[5]] ?? "quiet_street";
      const name = this.g.names[e[6]] ?? "";
      const length = e[2];
      total += length;
      climb += e[9] ?? 0;
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
        climb_m: Math.round(climb),
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

  /** Total meters ridden on high-stress classes (busy/moderate/sharrow). */
  private stressMeters(edgePath: number[]): number {
    let m = 0;
    for (const ei of edgePath) {
      const e = this.g.edges[ei];
      if (!e) continue;
      const cls = this.g.classes[e[5]];
      if (cls !== undefined && CAUTION_CLASSES.has(cls)) m += e[2];
    }
    return m;
  }

  /** Meters ridden along bike-crash hotspot segments. */
  private hotspotMeters(edgePath: number[]): number {
    let m = 0;
    for (const ei of edgePath) {
      const e = this.g.edges[ei];
      if (e && e[8] >= HOTSPOT_CRASH_FACTOR) m += e[2];
    }
    return m;
  }

  /** Consecutive protected (path/separated) stretches, labeled by their
   * dominant street/path name, longest first. */
  private protectedRuns(edgePath: number[]): { name: string; meters: number }[] {
    const runs: { name: string; meters: number }[] = [];
    let meters = 0;
    let byName = new Map<string, number>();
    const flush = (): void => {
      if (meters < 1) return;
      let label = "off-street path";
      let best = 0;
      for (const [n, m] of byName) {
        if (n !== "" && m > best) {
          best = m;
          label = n;
        }
      }
      runs.push({ name: label, meters });
      meters = 0;
      byName = new Map();
    };
    for (const ei of edgePath) {
      const e = this.g.edges[ei];
      if (!e) continue;
      const cls = this.g.classes[e[5]];
      if (cls !== undefined && PROTECTED.has(cls)) {
        meters += e[2];
        const name = this.g.names[e[6]] ?? "";
        byName.set(name, (byName.get(name) ?? 0) + e[2]);
      } else {
        flush();
      }
    }
    flush();
    return runs.sort((a, b) => b.meters - a.meters);
  }

  /** Grade a route by its average kid-level stress cost per meter (crash
   * factors and crossing penalties included), regardless of riding mode —
   * safety is rated on the same scale for every option. */
  private gradeRoute(edgePath: number[]): { grade: SafetyGrade; reason: string } {
    let len = 0;
    let kidsCost = 0;
    let protectedM = 0;
    for (const ei of edgePath) {
      const e = this.g.edges[ei];
      if (!e) continue;
      len += e[2];
      kidsCost += e[3];
      const cls = this.g.classes[e[5]];
      if (cls !== undefined && (PROTECTED.has(cls) || cls === "buffered")) protectedM += e[2];
    }
    const avg = len > 0 ? kidsCost / len : 1;
    const stress = this.stressMeters(edgePath);
    const grade: SafetyGrade =
      avg <= 1.6 ? "A" : avg <= 2.4 ? "B" : avg <= 4 ? "C" : avg <= 8 ? "D" : "F";
    const pctProt = len > 0 ? Math.round((100 * protectedM) / len) : 0;
    const reason =
      `avg kid-stress ${avg.toFixed(1)}× per meter — ${pctProt}% protected, ` +
      (stress < 30 ? "no busy/moderate streets" : `${fmt(stress)} on busy/moderate streets`);
    return { grade, reason };
  }

  private explain(
    safestPath: number[],
    shortestPath: number[],
    safest: RoutePayload,
    shortest: RoutePayload,
    mode: RideMode,
    isDirect = false,
    preferFlat = false,
  ): string[] {
    const s = safest.summary;
    if (isDirect) {
      const reasons = [
        "This is the shortest possible route — it minimizes distance, not stress.",
      ];
      const hotspot = this.hotspotMeters(safestPath);
      if (hotspot > 150) {
        reasons.push(
          `It passes ~${fmt(hotspot)} of bike-crash hotspots ` +
            `(MassDOT crash records, 2021–2026).`,
        );
      }
      for (const c of s.cautions) {
        reasons.push(
          `${fmt(c.meters)} of ${c.cls.replace("_", " ")} along ${c.name}.`,
        );
      }
      return reasons;
    }
    const reasons: string[] = [];
    const detour = s.detour_pct ?? 0;
    const safeStress = this.stressMeters(safestPath);
    const shortStress = this.stressMeters(shortestPath);
    const costFactor = mode === "kids" ? 25 : 6;
    const modeLabel = mode === "kids" ? "riding-with-kids" : "solo";

    if (detour >= 3) {
      reasons.push(
        `In ${modeLabel} weighting an unprotected busy street "costs" ${costFactor}× its ` +
          `length, so this route accepts +${detour}% distance ` +
          `(${fmt(s.meters)} vs ${fmt(s.shortest_meters ?? 0)} direct) to cut ` +
          `high-stress riding from ${fmt(shortStress)} down to ${fmt(safeStress)}.`,
      );
    } else {
      reasons.push(
        "The direct route is already the lowest-stress option here — no detour was needed.",
      );
    }

    if (shortStress - safeStress > 100) {
      const worst = [...shortest.summary.cautions].sort((a, b) => b.meters - a.meters)[0];
      if (worst) {
        reasons.push(
          `The direct route would spend ${fmt(shortStress)} on busy or moderate streets — ` +
            `worst stretch: ${fmt(worst.meters)} along ${worst.name}. This route ` +
            (safeStress < 30 ? "avoids all of it." : `keeps that to ${fmt(safeStress)}.`),
        );
      }
    }

    const runs = this.protectedRuns(safestPath).filter((r) => r.meters >= 300);
    if (runs.length > 0) {
      const named = runs
        .slice(0, 3)
        .map((r) => `${r.name} (${fmt(r.meters)})`)
        .join(", ");
      reasons.push(
        `Backbone: ${named} — off-street paths or physically separated lanes ` +
          `(${s.pct_protected}% of the ride is protected).`,
      );
    }

    if (s.pct_quiet >= 25) {
      reasons.push(
        `Connections between protected stretches run on quiet residential streets ` +
          `(${s.pct_quiet}% of the ride).`,
      );
    }

    if (preferFlat) {
      const climb = s.climb_m ?? 0;
      const directClimb = shortest.summary.climb_m ?? 0;
      if (directClimb - climb >= 5) {
        reasons.push(
          `Flat preference: this route climbs ${climb} m total, saving ` +
            `${directClimb - climb} m of climbing vs the direct route.`,
        );
      } else {
        reasons.push(
          `Flat preference is on — this route climbs ${climb} m total ` +
            `(the direct route climbs ${directClimb} m; no flatter option exists).`,
        );
      }
    }

    const hotspotDiff = this.hotspotMeters(shortestPath) - this.hotspotMeters(safestPath);
    if (hotspotDiff > 150) {
      reasons.push(
        `It also steers around ~${fmt(hotspotDiff)} of bike-crash hotspots on the direct ` +
          `route (MassDOT crash records, 2021–2026).`,
      );
    }

    for (const c of s.cautions) {
      reasons.push(
        `Unavoidable compromise: ${fmt(c.meters)} of ${c.cls.replace("_", " ")} along ` +
          `${c.name} — no lower-stress connection exists there.`,
      );
    }
    return reasons;
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
    safest.summary.explanation = this.explain(safestPath, shortestPath, safest, shortest, mode);
    return { safest, shortest };
  }

  /** Up to three distinct options (safest / balanced / direct), each graded
   * for safety on the same kid-stress scale and individually explained.
   * Identical paths are deduped, so fewer options appear when the safest
   * route already is the direct one. */
  routeOptions(
    start: [number, number],
    end: [number, number],
    preferFlat = false,
  ): RouteOption[] {
    const a = this.nearestNode(start[0], start[1]);
    const b = this.nearestNode(end[0], end[1]);
    if (a === b) throw new Error("start and end snap to the same intersection");
    const candidates: { id: RouteOption["id"]; label: string; col: WeightColumn; mode: RideMode }[] = [
      { id: "safest", label: "Safest", col: 3, mode: "kids" },
      { id: "balanced", label: "Balanced", col: 4, mode: "solo" },
      { id: "direct", label: "Direct", col: 2, mode: "solo" },
    ];
    const paths = new Map<RouteOption["id"], number[]>();
    for (const c of candidates) {
      // "direct" stays the pure shortest path — it is the reference route
      const p = this.shortestPath(a, b, c.col, preferFlat && c.id !== "direct");
      if (p === null) throw new Error("no path found");
      paths.set(c.id, p);
    }
    const directPath = paths.get("direct") as number[];
    const directPayload = this.payload(directPath);

    const options: RouteOption[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      const path = paths.get(c.id) as number[];
      const key = path.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      const payload = c.id === "direct" ? directPayload : this.payload(path);
      payload.summary.shortest_meters = directPayload.summary.meters;
      payload.summary.detour_pct =
        directPayload.summary.meters > 0
          ? Math.round(100 * (payload.summary.meters / directPayload.summary.meters - 1))
          : 0;
      payload.summary.explanation = this.explain(
        path,
        directPath,
        payload,
        directPayload,
        c.mode,
        c.id === "direct",
        preferFlat,
      );
      const { grade, reason } = this.gradeRoute(path);
      options.push({ id: c.id, label: c.label, grade, gradeReason: reason, payload });
    }
    return options;
  }
}
