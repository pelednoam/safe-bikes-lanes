// Ride recording + history. Rides are recorded only while the app is actively
// navigating or explicitly recording (web apps cannot track in the background);
// everything stays in localStorage on the device.
import { distM } from "./nav.js";
const STORE_KEY = "rideHistory";
const MIN_SAVE_M = 200;
const MIN_STEP_M = 3;
/** Distance is accumulated over spans of at least this far (or this often),
 * not per fix. Summing per-fix displacement made GPS wander *be* the distance:
 * at a young-kids pace of 8 km/h a 1 Hz fix moves 2.2 m, well under typical
 * 5-15 m bike-GPS wander, so a measured ride came out 18-60% long and the app
 * announced "8.6 kilometers" then "ride saved. 12.9 kilometers." */
/** Window by TIME, never by distance: triggering on the noisy displacement
 * itself preferentially counts the fixes where wander happened to push it up,
 * which is a bias that no threshold choice removes. Over 10 s a riding child
 * covers ~22 m, so wander is a small fraction of each span. */
const ANCHOR_MAX_MS = 10000;
/** Below this per window we were parked, not riding. */
const ANCHOR_MIN_M = 12;
/** A drop this large in along-route progress means the route was replaced. */
const ALONG_REBASE_M = 50;
const POLYLINE_STEP_M = 15;
const MOVING_SPEED_MS = 0.8;
const MAX_RIDES = 200;
const PROTECTED = new Set(["path", "separated", "buffered"]);
const QUIET = new Set(["quiet_street", "service"]);
export class RideRecorder {
    constructor() {
        this.startT = null;
        this.lastT = 0;
        this.last = null;
        this.anchor = null;
        this.anchorT = 0;
        this.alongBase = null;
        this.alongMax = 0;
        this.lastPoly = null;
        this.polyline = [];
        this.meters = 0;
        this.movingS = 0;
        this.byClass = new Map();
        /** Timestamp of the last sample that showed movement. */
        this.lastMovedAt = 0;
    }
    /** `alongM` is progress along the navigated route, when there is one. */
    addPoint(tMs, lon, lat, cls, alongM) {
        const cur = [lon, lat];
        if (this.startT === null || this.last === null) {
            this.startT = tMs;
            this.lastT = tMs;
            this.last = cur;
            this.lastPoly = cur;
            this.anchor = cur;
            this.anchorT = tMs;
            this.polyline.push(cur);
            this.lastMovedAt = tMs;
            return;
        }
        const dRaw = distM(this.last, cur);
        const dt = (tMs - this.lastT) / 1000;
        this.lastT = tMs;
        this.last = cur;
        if (dt > 0 && dRaw >= MIN_STEP_M && dRaw / dt > MOVING_SPEED_MS) {
            this.movingS += dt;
            this.lastMovedAt = tMs;
        }
        if (this.lastPoly === null || distM(this.lastPoly, cur) > POLYLINE_STEP_M) {
            this.polyline.push(cur);
            this.lastPoly = cur;
        }
        // Prefer along-route progress when navigating: perpendicular wander can't
        // advance it and longitudinal wander averages out, so it needs no filtering.
        if (alongM !== undefined) {
            // High-water mark, not a sum of steps: adding every positive step while
            // discarding the negative ones is a ratchet, and wander then compounds
            // (measured 22% long over 3 km). This way wander can overstate the ride
            // by at most one excursion in total.
            if (this.alongBase === null) {
                this.alongBase = alongM;
                this.alongMax = alongM;
            }
            else if (alongM < this.alongBase - ALONG_REBASE_M) {
                // a reroute rebased the track: bank what we rode and start again
                this.meters += this.alongMax - this.alongBase;
                this.alongBase = alongM;
                this.alongMax = alongM;
            }
            else if (alongM > this.alongMax) {
                const step = alongM - this.alongMax;
                this.alongMax = alongM;
                if (cls !== null)
                    this.byClass.set(cls, (this.byClass.get(cls) ?? 0) + step);
            }
            return;
        }
        // Free recording (no route): measure displacement over a time window.
        const anchor = this.anchor ?? cur;
        if (tMs - this.anchorT >= ANCHOR_MAX_MS) {
            const dAnchor = distM(anchor, cur);
            if (dAnchor >= ANCHOR_MIN_M) {
                this.meters += dAnchor;
                if (cls !== null)
                    this.byClass.set(cls, (this.byClass.get(cls) ?? 0) + dAnchor);
            }
            this.anchor = cur;
            this.anchorT = tMs;
        }
    }
    /** Banked distance plus the current along-route span. */
    get total() {
        return this.meters + (this.alongBase === null ? 0 : this.alongMax - this.alongBase);
    }
    get metersSoFar() {
        return this.total;
    }
    get durationSoFar() {
        return this.startT === null ? 0 : (this.lastT - this.startT) / 1000;
    }
    /** Returns null for rides too short to be worth keeping. */
    finish(profile) {
        if (this.startT === null || this.total < MIN_SAVE_M)
            return null;
        const classified = [...this.byClass.values()].reduce((a, b) => a + b, 0);
        const sumOf = (set) => [...this.byClass.entries()].reduce((a, [c, m]) => a + (set.has(c) ? m : 0), 0);
        return {
            id: `${this.startT}`,
            startedAt: new Date(this.startT).toISOString(),
            meters: Math.round(this.total),
            durationS: Math.round((this.lastT - this.startT) / 1000),
            movingS: Math.round(this.movingS),
            byClass: Object.fromEntries([...this.byClass.entries()].map(([c, m]) => [c, Math.round(m)])),
            pctProtected: classified > 0 ? Math.round((100 * sumOf(PROTECTED)) / classified) : 0,
            pctQuiet: classified > 0 ? Math.round((100 * sumOf(QUIET)) / classified) : 0,
            profile,
            polyline: this.polyline.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]),
        };
    }
}
/** Key holding the ride currently underway. finish() only reads accumulated
 * state, so it can be snapshotted repeatedly; a ride was previously only ever
 * written on arrival or an explicit exit, so a hardware Back, a reload or a
 * crash lost the whole thing. */
const IN_PROGRESS_KEY = "rideInProgress";
export function stashInProgress(ride) {
    if (ride === null)
        localStorage.removeItem(IN_PROGRESS_KEY);
    else
        localStorage.setItem(IN_PROGRESS_KEY, JSON.stringify(ride));
}
/** Recover a ride that was underway when the app went away, and clear it.
 * Returns null when there was nothing worth keeping. */
export function takeInProgress() {
    const raw = localStorage.getItem(IN_PROGRESS_KEY);
    localStorage.removeItem(IN_PROGRESS_KEY);
    if (raw === null)
        return null;
    try {
        const ride = JSON.parse(raw);
        return typeof ride?.id === "string" && typeof ride.meters === "number" ? ride : null;
    }
    catch {
        return null;
    }
}
export function loadRides() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        return raw === null ? [] : JSON.parse(raw);
    }
    catch {
        return [];
    }
}
export function saveRide(ride) {
    const rides = [ride, ...loadRides()].slice(0, MAX_RIDES);
    localStorage.setItem(STORE_KEY, JSON.stringify(rides));
    return rides;
}
export function deleteRide(id) {
    const rides = loadRides().filter((r) => r.id !== id);
    localStorage.setItem(STORE_KEY, JSON.stringify(rides));
    return rides;
}
export function clearRides() {
    localStorage.removeItem(STORE_KEY);
}
export function rideTotals(rides, now) {
    const month = now.toISOString().slice(0, 7);
    let m = 0;
    let movingS = 0;
    let longest = 0;
    let monthM = 0;
    let protWeighted = 0;
    for (const r of rides) {
        m += r.meters;
        movingS += r.movingS;
        longest = Math.max(longest, r.meters);
        if (r.startedAt.startsWith(month))
            monthM += r.meters;
        protWeighted += r.pctProtected * r.meters;
    }
    return {
        count: rides.length,
        km: Math.round(m / 100) / 10,
        movingHours: Math.round(movingS / 360) / 10,
        longestKm: Math.round(longest / 100) / 10,
        thisMonthKm: Math.round(monthM / 100) / 10,
        avgProtectedPct: m > 0 ? Math.round(protWeighted / m) : 0,
    };
}
