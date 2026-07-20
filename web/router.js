// In-browser safest-route computation over the exported graph
// (web/data/graph.json, written by pipeline/export_web.py).
const CLASS_COLORS = {
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
const CAUTION_CLASSES = new Set([
    "sharrow",
    "moderate_street",
    "busy_street",
]);
const MAX_SNAP_METERS = 500;
const KID_PACE_KMH = 10;
const PROTECTED = new Set(["path", "separated"]);
const HOTSPOT_CRASH_FACTOR = 1.25;
function fmt(m) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
// ---------------------------------------------------------------------------
// binary min-heap of (priority, value)
// ---------------------------------------------------------------------------
class MinHeap {
    constructor() {
        this.prio = [];
        this.val = [];
    }
    get size() {
        return this.prio.length;
    }
    push(priority, value) {
        const { prio, val } = this;
        let i = prio.length;
        prio.push(priority);
        val.push(value);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            const pp = prio[parent];
            if (pp <= priority)
                break;
            prio[i] = pp;
            val[i] = val[parent];
            i = parent;
        }
        prio[i] = priority;
        val[i] = value;
    }
    pop() {
        const { prio, val } = this;
        const n = prio.length;
        if (n === 0)
            return null;
        const topP = prio[0];
        const topV = val[0];
        const lastP = prio.pop();
        const lastV = val.pop();
        if (n > 1) {
            let i = 0;
            const m = prio.length;
            for (;;) {
                let child = 2 * i + 1;
                if (child >= m)
                    break;
                const right = child + 1;
                if (right < m && prio[right] < prio[child])
                    child = right;
                if (prio[child] >= lastP)
                    break;
                prio[i] = prio[child];
                val[i] = val[child];
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
    constructor(data) {
        this.g = data;
        this.adj = data.nodes.map(() => []);
        data.edges.forEach((e, i) => {
            const nodeEdges = this.adj[e[0]];
            if (nodeEdges)
                nodeEdges.push(i);
        });
    }
    static async load(url) {
        const resp = await fetch(url);
        if (!resp.ok)
            throw new Error(`failed to load graph (${resp.status})`);
        return new Router((await resp.json()));
    }
    nearestNode(lon, lat) {
        const scaleX = Math.cos((lat * Math.PI) / 180) * 111320;
        const scaleY = 110540;
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
    shortestPath(from, to, w) {
        const n = this.g.nodes.length;
        const dist = new Float64Array(n).fill(Infinity);
        const prevEdge = new Int32Array(n).fill(-1);
        const done = new Uint8Array(n);
        dist[from] = 0;
        const heap = new MinHeap();
        heap.push(0, from);
        while (heap.size > 0) {
            const popped = heap.pop();
            if (popped === null)
                break;
            const [d, u] = popped;
            if (done[u])
                continue;
            done[u] = 1;
            if (u === to)
                break;
            const edges = this.adj[u];
            if (!edges)
                continue;
            for (const ei of edges) {
                const e = this.g.edges[ei];
                if (!e)
                    continue;
                const v = e[1];
                if (done[v])
                    continue;
                const nd = d + e[w];
                if (nd < dist[v]) {
                    dist[v] = nd;
                    prevEdge[v] = ei;
                    heap.push(nd, v);
                }
            }
        }
        if (dist[to] === Infinity)
            return null;
        const path = [];
        let cur = to;
        while (cur !== from) {
            const ei = prevEdge[cur];
            if (ei < 0)
                return null;
            path.push(ei);
            const e = this.g.edges[ei];
            if (!e)
                return null;
            cur = e[0];
        }
        path.reverse();
        return path;
    }
    edgeCoords(ei) {
        const e = this.g.edges[ei];
        if (!e)
            return [];
        const geomIdx = e[7];
        const geom = geomIdx >= 0 ? this.g.geoms[geomIdx] : undefined;
        if (geom !== undefined) {
            const coords = [];
            for (let i = 0; i + 1 < geom.length; i += 2) {
                coords.push([geom[i], geom[i + 1]]);
            }
            return coords;
        }
        const a = this.g.nodes[e[0]];
        const b = this.g.nodes[e[1]];
        return a && b ? [a, b] : [];
    }
    payload(edgePath) {
        const features = [];
        const byClass = new Map();
        const cautions = [];
        let total = 0;
        for (const ei of edgePath) {
            const e = this.g.edges[ei];
            if (!e)
                continue;
            const cls = this.g.classes[e[5]] ?? "quiet_street";
            const name = this.g.names[e[6]] ?? "";
            const length = e[2];
            total += length;
            byClass.set(cls, (byClass.get(cls) ?? 0) + length);
            if (CAUTION_CLASSES.has(cls)) {
                const prev = cautions[cautions.length - 1];
                const label = name || "unnamed";
                if (prev && prev.name === label && prev.cls === cls)
                    prev.meters += length;
                else
                    cautions.push({ name: label, cls, meters: length });
            }
            features.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: this.edgeCoords(ei) },
                properties: { cls, color: CLASS_COLORS[cls], name: name || null },
            });
        }
        const sum = (classes) => classes.reduce((acc, c) => acc + (byClass.get(c) ?? 0), 0);
        const geojson = { type: "FeatureCollection", features };
        return {
            geojson,
            summary: {
                meters: Math.round(total),
                minutes: Math.round((total / 1000 / KID_PACE_KMH) * 60),
                pct_protected: total > 0 ? Math.round((100 * sum(["path", "separated", "buffered"])) / total) : 0,
                pct_quiet: total > 0 ? Math.round((100 * sum(["quiet_street", "service"])) / total) : 0,
                by_class_m: Object.fromEntries([...byClass.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([c, m]) => [c, Math.round(m)])),
                cautions: cautions
                    .filter((c) => c.meters >= 15)
                    .map((c) => ({ ...c, meters: Math.round(c.meters) })),
            },
        };
    }
    /** Total meters ridden on high-stress classes (busy/moderate/sharrow). */
    stressMeters(edgePath) {
        let m = 0;
        for (const ei of edgePath) {
            const e = this.g.edges[ei];
            if (!e)
                continue;
            const cls = this.g.classes[e[5]];
            if (cls !== undefined && CAUTION_CLASSES.has(cls))
                m += e[2];
        }
        return m;
    }
    /** Meters ridden along bike-crash hotspot segments. */
    hotspotMeters(edgePath) {
        let m = 0;
        for (const ei of edgePath) {
            const e = this.g.edges[ei];
            if (e && e[8] >= HOTSPOT_CRASH_FACTOR)
                m += e[2];
        }
        return m;
    }
    /** Consecutive protected (path/separated) stretches, labeled by their
     * dominant street/path name, longest first. */
    protectedRuns(edgePath) {
        const runs = [];
        let meters = 0;
        let byName = new Map();
        const flush = () => {
            if (meters < 1)
                return;
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
            if (!e)
                continue;
            const cls = this.g.classes[e[5]];
            if (cls !== undefined && PROTECTED.has(cls)) {
                meters += e[2];
                const name = this.g.names[e[6]] ?? "";
                byName.set(name, (byName.get(name) ?? 0) + e[2]);
            }
            else {
                flush();
            }
        }
        flush();
        return runs.sort((a, b) => b.meters - a.meters);
    }
    explain(safestPath, shortestPath, safest, shortest, mode) {
        const reasons = [];
        const s = safest.summary;
        const detour = s.detour_pct ?? 0;
        const safeStress = this.stressMeters(safestPath);
        const shortStress = this.stressMeters(shortestPath);
        const costFactor = mode === "kids" ? 25 : 6;
        const modeLabel = mode === "kids" ? "riding-with-kids" : "solo";
        if (detour >= 3) {
            reasons.push(`In ${modeLabel} weighting an unprotected busy street "costs" ${costFactor}× its ` +
                `length, so this route accepts +${detour}% distance ` +
                `(${fmt(s.meters)} vs ${fmt(s.shortest_meters ?? 0)} direct) to cut ` +
                `high-stress riding from ${fmt(shortStress)} down to ${fmt(safeStress)}.`);
        }
        else {
            reasons.push("The direct route is already the lowest-stress option here — no detour was needed.");
        }
        if (shortStress - safeStress > 100) {
            const worst = [...shortest.summary.cautions].sort((a, b) => b.meters - a.meters)[0];
            if (worst) {
                reasons.push(`The direct route would spend ${fmt(shortStress)} on busy or moderate streets — ` +
                    `worst stretch: ${fmt(worst.meters)} along ${worst.name}. This route ` +
                    (safeStress < 30 ? "avoids all of it." : `keeps that to ${fmt(safeStress)}.`));
            }
        }
        const runs = this.protectedRuns(safestPath).filter((r) => r.meters >= 300);
        if (runs.length > 0) {
            const named = runs
                .slice(0, 3)
                .map((r) => `${r.name} (${fmt(r.meters)})`)
                .join(", ");
            reasons.push(`Backbone: ${named} — off-street paths or physically separated lanes ` +
                `(${s.pct_protected}% of the ride is protected).`);
        }
        if (s.pct_quiet >= 25) {
            reasons.push(`Connections between protected stretches run on quiet residential streets ` +
                `(${s.pct_quiet}% of the ride).`);
        }
        const hotspotDiff = this.hotspotMeters(shortestPath) - this.hotspotMeters(safestPath);
        if (hotspotDiff > 150) {
            reasons.push(`It also steers around ~${fmt(hotspotDiff)} of bike-crash hotspots on the direct ` +
                `route (MassDOT crash records, 2021–2026).`);
        }
        for (const c of s.cautions) {
            reasons.push(`Unavoidable compromise: ${fmt(c.meters)} of ${c.cls.replace("_", " ")} along ` +
                `${c.name} — no lower-stress connection exists there.`);
        }
        return reasons;
    }
    route(start, end, mode) {
        const a = this.nearestNode(start[0], start[1]);
        const b = this.nearestNode(end[0], end[1]);
        if (a === b)
            throw new Error("start and end snap to the same intersection");
        const wCol = mode === "kids" ? 3 : 4;
        const safestPath = this.shortestPath(a, b, wCol);
        const shortestPath = this.shortestPath(a, b, 2);
        if (safestPath === null || shortestPath === null)
            throw new Error("no path found");
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
}
