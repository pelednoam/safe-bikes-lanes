// Ride recording + history. Rides are recorded only while the app is actively
// navigating or explicitly recording (web apps cannot track in the background);
// everything stays in localStorage on the device.
import { distM } from "./nav.js";
const STORE_KEY = "rideHistory";
const MIN_SAVE_M = 200;
const MIN_STEP_M = 3;
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
        this.lastPoly = null;
        this.polyline = [];
        this.meters = 0;
        this.movingS = 0;
        this.byClass = new Map();
        /** Timestamp of the last sample that showed movement. */
        this.lastMovedAt = 0;
    }
    addPoint(tMs, lon, lat, cls) {
        const cur = [lon, lat];
        if (this.startT === null || this.last === null) {
            this.startT = tMs;
            this.lastT = tMs;
            this.last = cur;
            this.lastPoly = cur;
            this.polyline.push(cur);
            this.lastMovedAt = tMs;
            return;
        }
        const d = distM(this.last, cur);
        const dt = (tMs - this.lastT) / 1000;
        this.lastT = tMs;
        if (d < MIN_STEP_M)
            return; // GPS jitter while stopped
        this.meters += d;
        if (dt > 0 && d / dt > MOVING_SPEED_MS)
            this.movingS += dt;
        this.lastMovedAt = tMs;
        if (cls !== null)
            this.byClass.set(cls, (this.byClass.get(cls) ?? 0) + d);
        this.last = cur;
        if (this.lastPoly === null || distM(this.lastPoly, cur) > POLYLINE_STEP_M) {
            this.polyline.push(cur);
            this.lastPoly = cur;
        }
    }
    get metersSoFar() {
        return this.meters;
    }
    get durationSoFar() {
        return this.startT === null ? 0 : (this.lastT - this.startT) / 1000;
    }
    /** Returns null for rides too short to be worth keeping. */
    finish(profile) {
        if (this.startT === null || this.meters < MIN_SAVE_M)
            return null;
        const classified = [...this.byClass.values()].reduce((a, b) => a + b, 0);
        const sumOf = (set) => [...this.byClass.entries()].reduce((a, [c, m]) => a + (set.has(c) ? m : 0), 0);
        return {
            id: `${this.startT}`,
            startedAt: new Date(this.startT).toISOString(),
            meters: Math.round(this.meters),
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
