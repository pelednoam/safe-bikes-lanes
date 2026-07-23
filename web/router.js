// In-browser safest-route computation over the exported graph
// (web/data/graph.json v2, written by pipeline/export_web.py).
// All weighting happens here, from raw per-edge components — so rider
// profiles, flat preference, and personal "sketchy" marks apply instantly.
import { bearingDeg } from "./nav.js";
export const PROFILES = {
    young_kids: {
        id: "young_kids",
        label: "young kids",
        paceKmh: 8,
        mult: {
            path: 1.0, separated: 1.0, buffered: 2.0, lane: 3.0, quiet_street: 1.4,
            service: 2.0, sharrow: 6.0, moderate_street: 8.0, busy_street: 25.0,
        },
        busyLane: 10.0,
        busyBuffered: 6.0,
        penScale: 1.0,
    },
    older_kids: {
        id: "older_kids",
        label: "older kids",
        paceKmh: 11,
        mult: {
            path: 1.0, separated: 1.0, buffered: 1.5, lane: 2.0, quiet_street: 1.2,
            service: 1.6, sharrow: 3.5, moderate_street: 4.0, busy_street: 12.0,
        },
        busyLane: 5.0,
        busyBuffered: 3.0,
        penScale: 0.6,
    },
    solo: {
        id: "solo",
        label: "solo",
        paceKmh: 16,
        mult: {
            path: 1.0, separated: 1.0, buffered: 1.1, lane: 1.3, quiet_street: 1.1,
            service: 1.3, sharrow: 2.0, moderate_street: 2.5, busy_street: 6.0,
        },
        busyLane: 2.5,
        busyBuffered: 1.8,
        penScale: 0.3,
    },
};
/** Next-milder profile, used for the "Balanced" alternative. */
const MILDER = {
    young_kids: "older_kids",
    older_kids: "solo",
    solo: null,
};
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
const PROTECTED = new Set(["path", "separated"]);
const MAX_SNAP_METERS = 500;
const HOTSPOT_CRASH_FACTOR = 1.25;
// Flat preference: each meter of climb costs this many meters-equivalent,
// doubled on grades steeper than 4% (hard with kids' bikes).
const HILL_EQUIV_M = 12;
const STEEP_GRADE = 0.04;
/** Weight multiplier for edges the user marked as sketchy. */
const SKETCHY_MULT = 5.0;
const SKETCHY_SNAP_M = 30;
/** Weight multiplier for edges inside active construction zones. */
const CONSTRUCTION_MULT = 4.0;
const CONSTRUCTION_SNAP_M = 40;
/** Outbound-edge penalty when planning the return leg of a loop. */
const LOOP_REUSE_MULT = 4.0;
/** Multiplier floor for lane types the rider chose to avoid — the "as much
 * as possible" semantics: near-prohibitive, never a hard ban. */
const AVOID_TYPE_MULT = 30.0;
/** Walking the bike: slower than riding (ride-equivalent distance factor at a
 * kid's pace) but nearly stress-free; dismount/mount friction keeps the router
 * from flip-flopping over tiny stretches. */
const WALK_FACTOR = 2.4;
const DISMOUNT_COST_M = 90.0;
const MOUNT_COST_M = 40.0;
const WALK_PACE_KMH = 4.0;
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
        /** "u,v" -> edge indices, for reverse-edge lookups */
        this.uvIndex = new Map();
        this.sketchy = new Set();
        this.construction = new Set();
        this.g = data;
        this.adj = data.nodes.map(() => []);
        this.hillPen = new Float64Array(data.edges.length);
        this.midX = new Float64Array(data.edges.length);
        this.midY = new Float64Array(data.edges.length);
        let total = 0;
        data.edges.forEach((e, i) => {
            this.adj[e[0]]?.push(i);
            const climb = e[8];
            const grade = e[2] > 0 ? climb / e[2] : 0;
            this.hillPen[i] = climb * HILL_EQUIV_M * (grade > STEEP_GRADE ? 2 : 1);
            const key = `${e[0]},${e[1]}`;
            const list = this.uvIndex.get(key);
            if (list)
                list.push(i);
            else
                this.uvIndex.set(key, [i]);
            const a = data.nodes[e[0]];
            const b = data.nodes[e[1]];
            if (a && b) {
                this.midX[i] = (a[0] + b[0]) / 2;
                this.midY[i] = (a[1] + b[1]) / 2;
            }
            total += e[2];
        });
        this.totalLen = total;
    }
    static async load(url) {
        const resp = await fetch(url);
        if (!resp.ok)
            throw new Error(`failed to load graph (${resp.status})`);
        return new Router((await resp.json()));
    }
    // -- weights ---------------------------------------------------------------
    /** Per-edge weight for a profile (null = pure distance). */
    weights(profile, preferFlat, avoid) {
        const w = new Float64Array(this.g.edges.length);
        this.g.edges.forEach((e, i) => {
            if (profile === null) {
                w[i] = e[2];
                return;
            }
            const cls = this.g.classes[e[3]] ?? "quiet_street";
            let mult = profile.mult[cls];
            if (e[9] === 1 && cls === "lane")
                mult = profile.busyLane;
            if (e[9] === 1 && cls === "buffered")
                mult = profile.busyBuffered;
            if (avoid?.has(cls))
                mult = Math.max(mult, AVOID_TYPE_MULT);
            let wi = e[2] * mult * e[6] + e[7] * profile.penScale;
            if (preferFlat)
                wi += this.hillPen[i];
            if (this.sketchy.has(i))
                wi *= SKETCHY_MULT;
            if (this.construction.has(i))
                wi *= CONSTRUCTION_MULT;
            w[i] = wi;
        });
        return w;
    }
    /** Ride-equivalent cost of walking each edge (class-independent: pushing a
     * bike on the sidewalk is low-stress even beside a busy street). */
    walkWeights(factor) {
        const w = new Float64Array(this.g.edges.length);
        this.g.edges.forEach((e, i) => {
            w[i] = e[2] * factor;
        });
        return w;
    }
    // -- snapping --------------------------------------------------------------
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
            throw new Error("point is too far from the mapped bike network");
        }
        return best;
    }
    nearestEdge(lon, lat, maxM) {
        const scaleX = Math.cos((lat * Math.PI) / 180) * 111320;
        const scaleY = 110540;
        let best = -1;
        let bestD2 = Infinity;
        for (let i = 0; i < this.midX.length; i++) {
            const dx = (this.midX[i] - lon) * scaleX;
            const dy = (this.midY[i] - lat) * scaleY;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = i;
            }
        }
        return best >= 0 && bestD2 <= maxM ** 2 ? best : null;
    }
    pointsToEdgeSet(points, snapM) {
        const set = new Set();
        for (const [lon, lat] of points) {
            const ei = this.nearestEdge(lon, lat, snapM);
            if (ei === null)
                continue;
            set.add(ei);
            const e = this.g.edges[ei];
            if (!e)
                continue;
            for (const rev of this.uvIndex.get(`${e[1]},${e[0]}`) ?? [])
                set.add(rev);
        }
        return set;
    }
    /** Personal feedback: penalize edges near the given points (both directions). */
    setSketchyMarks(points) {
        this.sketchy = this.pointsToEdgeSet(points, SKETCHY_SNAP_M);
    }
    /** Active construction: penalize edges near work zones / street permits. */
    setConstructionPoints(points) {
        this.construction = this.pointsToEdgeSet(points, CONSTRUCTION_SNAP_M);
    }
    // -- shortest path & flood fill -------------------------------------------
    dijkstra(from, to, w, extra, budget = Infinity) {
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
            if (u === to || d > budget)
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
                const nd = d + w[ei] * (extra?.get(ei) ?? 1);
                if (nd < dist[v]) {
                    dist[v] = nd;
                    prevEdge[v] = ei;
                    heap.push(nd, v);
                }
            }
        }
        return { dist, prevEdge };
    }
    tracePath(prevEdge, from, to) {
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
    shortestPath(from, to, w, extra) {
        const { dist, prevEdge } = this.dijkstra(from, to, w, extra);
        if (dist[to] === Infinity)
            return null;
        return this.tracePath(prevEdge, from, to);
    }
    /** Two-layer search (riding + walking the bike). States 0..N-1 ride at the
     * node; N..2N-1 walk. Layer switches cost dismount/mount friction. */
    shortestPathWalk(from, to, w, walkFactor, extra) {
        const n = this.g.nodes.length;
        const walkW = this.walkWeights(walkFactor);
        const dist = new Float64Array(2 * n).fill(Infinity);
        const prevEdge = new Int32Array(2 * n).fill(-1);
        const prevState = new Int32Array(2 * n).fill(-1);
        const done = new Uint8Array(2 * n);
        dist[from] = 0;
        const heap = new MinHeap();
        heap.push(0, from);
        while (heap.size > 0) {
            const popped = heap.pop();
            if (popped === null)
                break;
            const [d, s] = popped;
            if (done[s])
                continue;
            done[s] = 1;
            if (s === to)
                break; // arriving riding is the goal
            const walking = s >= n;
            const node = walking ? s - n : s;
            // layer switch
            const t = walking ? node : node + n;
            const switchCost = walking ? MOUNT_COST_M : DISMOUNT_COST_M;
            if (!done[t] && d + switchCost < dist[t]) {
                dist[t] = d + switchCost;
                prevEdge[t] = -1;
                prevState[t] = s;
                heap.push(d + switchCost, t);
            }
            const edges = this.adj[node];
            if (!edges)
                continue;
            for (const ei of edges) {
                const e = this.g.edges[ei];
                if (!e)
                    continue;
                const v = walking ? e[1] + n : e[1];
                if (done[v])
                    continue;
                const cost = walking
                    ? walkW[ei]
                    : w[ei] * (extra?.get(ei) ?? 1);
                const nd = d + cost;
                if (nd < dist[v]) {
                    dist[v] = nd;
                    prevEdge[v] = ei;
                    prevState[v] = s;
                    heap.push(nd, v);
                }
            }
        }
        // arriving on foot is fine too (mount at the door costs nothing extra)
        const endState = dist[to] <= dist[to + n] + MOUNT_COST_M ? to : to + n;
        if (dist[endState] === Infinity)
            return null;
        const path = [];
        const walk = [];
        let cur = endState;
        while (cur !== from) {
            const ei = prevEdge[cur];
            const prev = prevState[cur];
            if (prev < 0)
                return null;
            if (ei >= 0) {
                path.push(ei);
                walk.push(cur >= n);
            }
            cur = prev;
        }
        path.reverse();
        walk.reverse();
        return { path, walk };
    }
    /** Everything reachable from a point within a perceived-distance budget. */
    safeShed(center, budgetM, profileId, preferFlat) {
        const from = this.nearestNode(center[0], center[1]);
        const w = this.weights(PROFILES[profileId], preferFlat);
        const { dist } = this.dijkstra(from, null, w, undefined, budgetM);
        const features = [];
        let reachLen = 0;
        this.g.edges.forEach((e, i) => {
            const du = dist[e[0]];
            if (du + w[i] > budgetM)
                return;
            reachLen += e[2];
            const cls = this.g.classes[e[3]] ?? "quiet_street";
            features.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: this.edgeCoords(i) },
                properties: { cls, color: CLASS_COLORS[cls], name: null },
            });
        });
        return {
            geojson: { type: "FeatureCollection", features },
            pctReachable: Math.round((100 * reachLen) / this.totalLen),
            reachableKm: Math.round(reachLen / 100) / 10,
        };
    }
    // -- payload ---------------------------------------------------------------
    edgeCoords(ei) {
        const e = this.g.edges[ei];
        if (!e)
            return [];
        const geom = e[5] >= 0 ? this.g.geoms[e[5]] : undefined;
        if (geom !== undefined) {
            const coords = [];
            for (let i = 0; i + 1 < geom.length; i += 2) {
                coords.push([geom[i], geom[i + 1]]);
            }
            return coords;
        }
        const a = this.g.nodes[e[0]];
        const b = this.g.nodes[e[1]];
        return a && b ? [[a[0], a[1]], [b[0], b[1]]] : [];
    }
    payload(edgePath, profile, walkFlags) {
        const features = [];
        const byClass = new Map();
        const cautions = [];
        const ribbon = [];
        let total = 0;
        let climb = 0;
        let walkM = 0;
        for (const [pi, ei] of edgePath.entries()) {
            const e = this.g.edges[ei];
            if (!e)
                continue;
            const walked = walkFlags?.[pi] === true;
            const cls = this.g.classes[e[3]] ?? "quiet_street";
            const name = this.g.names[e[4]] ?? "";
            const length = e[2];
            total += length;
            climb += e[8];
            if (walked)
                walkM += length;
            else
                byClass.set(cls, (byClass.get(cls) ?? 0) + length);
            const coords = this.edgeCoords(ei);
            const first = coords[0];
            // a walked stretch is the mitigation, not a caution
            if (!walked && CAUTION_CLASSES.has(cls)) {
                const prev = cautions[cautions.length - 1];
                const label = name || "unnamed";
                if (prev && prev.name === label && prev.cls === cls)
                    prev.meters += length;
                else {
                    cautions.push({
                        name: label,
                        cls,
                        meters: length,
                        ...(first ? { lon: first[0], lat: first[1] } : {}),
                    });
                }
            }
            const e0 = this.g.nodes[e[0]]?.[2] ?? 0;
            const e1 = this.g.nodes[e[1]]?.[2] ?? 0;
            ribbon.push({ m: length, cls, e0, e1, crossing: !walked && e[7] > 100, walk: walked });
            features.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: coords },
                properties: {
                    cls,
                    color: CLASS_COLORS[cls],
                    name: name || null,
                    ...(walked ? { walk: true } : {}),
                },
            });
        }
        const sum = (classes) => classes.reduce((acc, c) => acc + (byClass.get(c) ?? 0), 0);
        return {
            geojson: { type: "FeatureCollection", features },
            ribbon,
            summary: {
                meters: Math.round(total),
                minutes: Math.round(((total - walkM) / 1000 / profile.paceKmh + walkM / 1000 / WALK_PACE_KMH) * 60),
                ...(walkM > 0 ? { walk_m: Math.round(walkM) } : {}),
                climb_m: Math.round(climb),
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
    // -- analysis helpers ------------------------------------------------------
    stressMeters(edgePath, walkFlags) {
        let m = 0;
        for (const [pi, ei] of edgePath.entries()) {
            const e = this.g.edges[ei];
            if (!e || walkFlags?.[pi] === true)
                continue;
            const cls = this.g.classes[e[3]];
            if (cls !== undefined && CAUTION_CLASSES.has(cls))
                m += e[2];
        }
        return m;
    }
    /** Meters of the path ridden on the given classes. */
    metersOnClasses(edgePath, classes, walkFlags) {
        let m = 0;
        for (const [pi, ei] of edgePath.entries()) {
            const e = this.g.edges[ei];
            if (!e || walkFlags?.[pi] === true)
                continue;
            const cls = this.g.classes[e[3]];
            if (cls !== undefined && classes.has(cls))
                m += e[2];
        }
        return m;
    }
    hotspotMeters(edgePath) {
        let m = 0;
        for (const ei of edgePath) {
            const e = this.g.edges[ei];
            if (e && e[6] >= HOTSPOT_CRASH_FACTOR)
                m += e[2];
        }
        return m;
    }
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
            const cls = this.g.classes[e[3]];
            if (cls !== undefined && PROTECTED.has(cls)) {
                meters += e[2];
                const name = this.g.names[e[4]] ?? "";
                byName.set(name, (byName.get(name) ?? 0) + e[2]);
            }
            else {
                flush();
            }
        }
        flush();
        return runs.sort((a, b) => b.meters - a.meters);
    }
    /** Objective safety grade on the young-kids stress scale. */
    gradeRoute(edgePath, walkFlags) {
        const yk = PROFILES.young_kids;
        let len = 0;
        let cost = 0;
        let protectedM = 0;
        for (const [pi, ei] of edgePath.entries()) {
            const e = this.g.edges[ei];
            if (!e)
                continue;
            const cls = this.g.classes[e[3]] ?? "quiet_street";
            let mult = yk.mult[cls];
            if (e[9] === 1 && cls === "lane")
                mult = yk.busyLane;
            if (e[9] === 1 && cls === "buffered")
                mult = yk.busyBuffered;
            if (walkFlags?.[pi] === true)
                mult = 1.3; // pushing the bike is calm
            len += e[2];
            cost += e[2] * mult * e[6] + e[7];
            if (PROTECTED.has(cls) || cls === "buffered")
                protectedM += e[2];
        }
        const avg = len > 0 ? cost / len : 1;
        const stress = this.stressMeters(edgePath, walkFlags);
        const grade = avg <= 1.6 ? "A" : avg <= 2.4 ? "B" : avg <= 4 ? "C" : avg <= 8 ? "D" : "F";
        const pctProt = len > 0 ? Math.round((100 * protectedM) / len) : 0;
        const reason = `avg kid-stress ${avg.toFixed(1)}× per meter — ${pctProt}% protected, ` +
            (stress < 30 ? "no busy/moderate streets" : `${fmt(stress)} on busy/moderate streets`);
        return { grade, reason };
    }
    explain(path, directPath, payload, direct, profile, isDirect, preferFlat) {
        const s = payload.summary;
        if (isDirect) {
            const reasons = [
                "This is the shortest possible route — it minimizes distance, not stress.",
            ];
            const hotspot = this.hotspotMeters(path);
            if (hotspot > 150) {
                reasons.push(`It passes ~${fmt(hotspot)} of bike-crash hotspots ` +
                    `(MassDOT crash records, 2021–2026).`);
            }
            for (const c of s.cautions) {
                reasons.push(`${fmt(c.meters)} of ${c.cls.replace("_", " ")} along ${c.name}.`);
            }
            return reasons;
        }
        const reasons = [];
        const detour = s.detour_pct ?? 0;
        const safeStress = this.stressMeters(path);
        const shortStress = this.stressMeters(directPath);
        const costFactor = profile.mult.busy_street;
        if (detour >= 3) {
            reasons.push(`In ${profile.label} weighting an unprotected busy street "costs" ${costFactor}× ` +
                `its length, so this route accepts +${detour}% distance ` +
                `(${fmt(s.meters)} vs ${fmt(s.shortest_meters ?? 0)} direct) to cut ` +
                `high-stress riding from ${fmt(shortStress)} down to ${fmt(safeStress)}.`);
        }
        else {
            reasons.push("The direct route is already the lowest-stress option here — no detour was needed.");
        }
        if (shortStress - safeStress > 100) {
            const worst = [...direct.summary.cautions].sort((a, b) => b.meters - a.meters)[0];
            if (worst) {
                reasons.push(`The direct route would spend ${fmt(shortStress)} on busy or moderate streets — ` +
                    `worst stretch: ${fmt(worst.meters)} along ${worst.name}. This route ` +
                    (safeStress < 30 ? "avoids all of it." : `keeps that to ${fmt(safeStress)}.`));
            }
        }
        const runs = this.protectedRuns(path).filter((r) => r.meters >= 300);
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
        if (preferFlat) {
            const climb = s.climb_m ?? 0;
            const directClimb = direct.summary.climb_m ?? 0;
            if (directClimb - climb >= 5) {
                reasons.push(`Flat preference: this route climbs ${climb} m total, saving ` +
                    `${directClimb - climb} m of climbing vs the direct route.`);
            }
            else {
                reasons.push(`Flat preference is on — this route climbs ${climb} m total ` +
                    `(the direct route climbs ${directClimb} m; no flatter option exists).`);
            }
        }
        const hotspotDiff = this.hotspotMeters(directPath) - this.hotspotMeters(path);
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
    /** Walk-aware search honoring a total walking budget: if the best path
     * walks more than budgetM, walking is made progressively more expensive
     * until the result fits (worst case: an all-riding path). */
    shortestPathWalkBudgeted(from, to, w, budgetM, extra) {
        let factor = WALK_FACTOR;
        for (let tries = 0; tries < 6; tries++) {
            const r = this.shortestPathWalk(from, to, w, factor, extra);
            if (r === null)
                return null;
            let walked = 0;
            r.walk.forEach((flag, i) => {
                if (flag)
                    walked += this.g.edges[r.path[i] ?? -1]?.[2] ?? 0;
            });
            if (walked <= budgetM)
                return r;
            factor *= 2;
        }
        const plain = this.shortestPath(from, to, w, extra);
        return plain === null ? null : { path: plain, walk: plain.map(() => false) };
    }
    // -- public queries --------------------------------------------------------
    /** Up to three distinct options (safest / balanced / direct), graded and
     * explained. Fewer appear when the paths coincide. */
    routeOptions(start, end, profileId = "young_kids", preferFlat = false, bias, avoid, walkMaxM = 0) {
        const a = this.nearestNode(start[0], start[1]);
        const b = this.nearestNode(end[0], end[1]);
        if (a === b)
            throw new Error("start and end snap to the same intersection");
        const profile = PROFILES[profileId];
        const milderId = MILDER[profileId];
        const candidates = [
            {
                id: "safest",
                label: "Safest",
                profile,
                w: this.weights(profile, preferFlat, avoid),
                isDirect: false,
            },
        ];
        if (milderId !== null) {
            candidates.push({
                id: "balanced",
                label: "Balanced",
                profile: PROFILES[milderId],
                w: this.weights(PROFILES[milderId], preferFlat, avoid),
                isDirect: false,
            });
        }
        candidates.push({
            id: "direct",
            label: "Direct",
            profile,
            w: this.weights(null, false),
            isDirect: true,
        });
        const paths = new Map();
        const walks = new Map();
        for (const c of candidates) {
            // the heading bias shapes real guidance, not the direct reference
            if (walkMaxM > 0 && !c.isDirect) {
                const r = this.shortestPathWalkBudgeted(a, b, c.w, walkMaxM, bias);
                if (r === null)
                    throw new Error("no path found");
                paths.set(c.id, r.path);
                walks.set(c.id, r.walk.some(Boolean) ? r.walk : undefined);
            }
            else {
                const p = this.shortestPath(a, b, c.w, c.isDirect ? undefined : bias);
                if (p === null)
                    throw new Error("no path found");
                paths.set(c.id, p);
                walks.set(c.id, undefined);
            }
        }
        const directPath = paths.get("direct");
        const directPayload = this.payload(directPath, profile);
        const options = [];
        const seen = new Set();
        for (const c of candidates) {
            const path = paths.get(c.id);
            const walkFlags = walks.get(c.id);
            const key = path.join(",") + (walkFlags ? "|w" : "");
            if (seen.has(key))
                continue;
            seen.add(key);
            const payload = c.id === "direct" ? directPayload : this.payload(path, c.profile, walkFlags);
            payload.summary.shortest_meters = directPayload.summary.meters;
            payload.summary.detour_pct =
                directPayload.summary.meters > 0
                    ? Math.round(100 * (payload.summary.meters / directPayload.summary.meters - 1))
                    : 0;
            payload.summary.explanation = this.explain(path, directPath, payload, directPayload, c.profile, c.isDirect, preferFlat);
            const walkM = payload.summary.walk_m ?? 0;
            if (walkM > 0) {
                payload.summary.explanation?.push(`Includes ${fmt(walkM)} of walking the bike ` +
                    `(~${Math.round((walkM / 1000 / 4) * 60)} min, within your ${fmt(walkMaxM)} ` +
                    `walking budget) to bridge safe segments — shorter overall than riding ` +
                    `the long way around.`);
            }
            if (avoid !== undefined && avoid.size > 0 && !c.isDirect) {
                const onAvoided = this.metersOnClasses(path, avoid, walkFlags);
                const directOn = this.metersOnClasses(directPath, avoid);
                const names = [...avoid].map((t) => t.replace("_", " ")).join(", ");
                payload.summary.explanation.push(onAvoided < 1
                    ? `Avoiding ${names}: this route uses none at all ` +
                        `(the direct route rides ${fmt(directOn)} on them).`
                    : `Avoiding ${names}: kept to ${fmt(onAvoided)} ` +
                        `(vs ${fmt(directOn)} direct) — no better alternative exists there.`);
            }
            const { grade, reason } = this.gradeRoute(path, walks.get(c.id));
            options.push({ id: c.id, label: c.label, grade, gradeReason: reason, payload });
        }
        return options;
    }
    /** Protection class of the street nearest a point (for classifying where a
     * recorded ride actually went), or null when off the network. */
    edgeClassAt(lon, lat, maxM = 30) {
        const ei = this.nearestEdge(lon, lat, maxM);
        if (ei === null)
            return null;
        const e = this.g.edges[ei];
        return e ? this.g.classes[e[3]] ?? null : null;
    }
    /** Penalize edges at the start point that head backward relative to the
     * rider's travel direction — used by "go with my street choice" rerouting
     * so guidance continues forward instead of demanding a U-turn. */
    headingBias(from, headingDeg, penalty = 8) {
        const node = this.nearestNode(from[0], from[1]);
        const bias = new Map();
        for (const ei of this.adj[node] ?? []) {
            const coords = this.edgeCoords(ei);
            const a = coords[0];
            const b = coords[1];
            if (!a || !b)
                continue;
            const brg = (bearingDeg(a, b) + 360) % 360;
            let diff = Math.abs(brg - ((headingDeg + 360) % 360)) % 360;
            if (diff > 180)
                diff = 360 - diff;
            if (diff > 110)
                bias.set(ei, penalty);
        }
        return bias;
    }
    /** Index of the target closest by network distance (profile-weighted) from
     * a point, or null if none is reachable. Used for mid-ride "nearest kid
     * stop" detours. */
    nearestReachable(from, targets, profileId, preferFlat) {
        if (targets.length === 0)
            return null;
        const fromNode = this.nearestNode(from[0], from[1]);
        const w = this.weights(PROFILES[profileId], preferFlat);
        const { dist } = this.dijkstra(fromNode, null, w);
        let best = null;
        let bestD = Infinity;
        targets.forEach(([lon, lat], i) => {
            let node;
            try {
                node = this.nearestNode(lon, lat);
            }
            catch {
                return;
            }
            const d = dist[node];
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        });
        return bestD === Infinity ? null : best;
    }
    /** Plan a round trip of roughly targetM meters with a stop at a POI.
     * The return leg penalizes outbound edges so it comes back a different way. */
    loopRoute(start, targetM, pois, profileId, preferFlat) {
        const from = this.nearestNode(start[0], start[1]);
        const profile = PROFILES[profileId];
        const w = this.weights(profile, preferFlat);
        const scaleX = Math.cos((start[1] * Math.PI) / 180) * 111320;
        const ideal = targetM * 0.35;
        const candidates = pois
            .map((p) => {
            const [lon, lat] = p.geometry.coordinates;
            const beeline = Math.hypot((lon - start[0]) * scaleX, (lat - start[1]) * 110540);
            return { p, beeline };
        })
            .filter((c) => c.beeline > targetM * 0.08 && c.beeline < targetM * 0.55)
            .sort((x, y) => Math.abs(x.beeline - ideal) - Math.abs(y.beeline - ideal))
            .slice(0, 12);
        if (candidates.length === 0) {
            throw new Error("no suitable stop found for that loop length — try another distance");
        }
        let best = null;
        for (const c of candidates) {
            const [lon, lat] = c.p.geometry.coordinates;
            let poiNode;
            try {
                poiNode = this.nearestNode(lon, lat);
            }
            catch {
                continue;
            }
            if (poiNode === from)
                continue;
            const out = this.shortestPath(from, poiNode, w);
            if (out === null)
                continue;
            const reuse = new Map();
            for (const ei of out) {
                reuse.set(ei, LOOP_REUSE_MULT);
                const e = this.g.edges[ei];
                if (!e)
                    continue;
                for (const rev of this.uvIndex.get(`${e[1]},${e[0]}`) ?? []) {
                    reuse.set(rev, LOOP_REUSE_MULT);
                }
            }
            const back = this.shortestPath(poiNode, from, w, reuse);
            if (back === null)
                continue;
            const path = [...out, ...back];
            const total = path.reduce((acc, ei) => acc + (this.g.edges[ei]?.[2] ?? 0), 0);
            if (best === null || Math.abs(total - targetM) < Math.abs(best.total - targetM)) {
                best = { path, poi: c.p, total };
            }
        }
        if (best === null)
            throw new Error("could not build a loop — try another distance");
        const payload = this.payload(best.path, profile);
        const { grade, reason } = this.gradeRoute(best.path);
        const poiName = best.poi.properties.name || best.poi.properties.kind.replace("_", " ");
        const runs = this.protectedRuns(best.path).filter((r) => r.meters >= 300);
        const explanation = [
            `A ${fmt(best.total)} loop with a stop at ${poiName} roughly halfway, ` +
                `returning a different way than it goes out.`,
        ];
        if (runs.length > 0) {
            explanation.push(`Backbone: ${runs
                .slice(0, 3)
                .map((r) => `${r.name} (${fmt(r.meters)})`)
                .join(", ")}.`);
        }
        for (const c of payload.summary.cautions) {
            explanation.push(`Caution: ${fmt(c.meters)} of ${c.cls.replace("_", " ")} along ${c.name}.`);
        }
        payload.summary.explanation = explanation;
        return {
            option: {
                id: "loop",
                label: `Loop via ${poiName}`,
                grade,
                gradeReason: reason,
                payload,
            },
            poi: best.poi,
        };
    }
}
// ---------------------------------------------------------------------------
// export helpers (GPX + cue sheet)
// ---------------------------------------------------------------------------
export function toGPX(payload, name) {
    const pts = [];
    let last = null;
    for (const f of payload.geojson.features) {
        for (const [lon, lat] of f.geometry.coordinates) {
            if (last && last[0] === lon && last[1] === lat)
                continue;
            last = [lon, lat];
            pts.push(`      <trkpt lat="${lat}" lon="${lon}"/>`);
        }
    }
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="family-bike-router" xmlns="http://www.topografix.com/GPX/1/1">',
        "  <trk>",
        `    <name>${name.replace(/[<>&]/g, "")}</name>`,
        "    <trkseg>",
        ...pts,
        "    </trkseg>",
        "  </trk>",
        "</gpx>",
    ].join("\n");
}
export function buildCues(payload) {
    const cues = [];
    let dist = 0;
    let lastName = null;
    const feats = payload.geojson.features;
    const ribbon = payload.ribbon ?? [];
    let lastWalk = false;
    feats.forEach((f, i) => {
        const name = f.properties.name ?? "(unnamed path)";
        const walking = f.properties.walk === true;
        if (name !== lastName || walking !== lastWalk) {
            cues.push({
                km: Math.round(dist / 100) / 10,
                text: walking
                    ? `🚶 walk the bike — ${name}`
                    : `${name} — ${f.properties.cls.replace("_", " ")}`,
            });
            lastName = name;
            lastWalk = walking;
        }
        dist += ribbon[i]?.m ?? 0;
    });
    cues.push({ km: Math.round(dist / 100) / 10, text: "arrive" });
    return cues;
}
