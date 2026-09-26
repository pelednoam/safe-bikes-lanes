// Getting a rider back onto a round trip.
//
// A loop ends where it starts, so "the destination" of a loop ride is the
// start. Rerouting an off-route rider to it — as every A-to-B reroute does —
// sent them straight home from wherever they strayed, abandoning the rest of the
// ride: a missed turn a mile into a ten-mile loop turned it into a two-mile one,
// and resuming after a stop for water did the same. The reroute has to aim for
// the loop instead: a little ahead of how far round it the rider had got, then
// the rest of the loop from there, as one route.
import { distM } from "./nav.js";
/** How far past the rider's progress to aim, so the way back joins the loop
 * going forwards rather than at the spot they are standing beside. */
export const REJOIN_AHEAD_M = 150;
function featureLength(f) {
    const cs = f.geometry.coordinates;
    let m = 0;
    for (let i = 1; i < cs.length; i++) {
        m += distM(cs[i - 1], cs[i]);
    }
    return m;
}
/** Length of a route, measured the way navigation measures its track. */
export function payloadLength(p) {
    return p.geojson.features.reduce((m, f) => m + featureLength(f), 0);
}
/** Where to rejoin a loop the rider has ridden `doneM` of: the start of the
 * first street segment at least `aheadM` further round. Null when less than
 * that is left — the way back is then simply to the finish. */
export function loopRejoinPoint(loop, doneM, aheadM = REJOIN_AHEAD_M) {
    const feats = loop.geojson.features;
    let startM = 0;
    for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        const first = f.geometry.coordinates[0];
        // never the first segment: rejoining there is the start, not the loop
        if (i > 0 && startM >= doneM + aheadM && first) {
            return { index: i, atM: startM, at: [first[0], first[1]] };
        }
        startM += featureLength(f);
    }
    return null;
}
const PROTECTED_SHARE = ["path", "separated", "buffered"];
const QUIET_SHARE = ["quiet_street", "service"];
/** `lead` (from the rider to the rejoin point) followed by the loop from
 * feature `index` on, as one payload navigation can follow. The summary is
 * recomputed for what will actually be ridden, so the panel afterwards does not
 * describe the loop as planned. */
export function spliceLoop(lead, loop, index) {
    const rest = loop.geojson.features.slice(index);
    const restRibbon = (loop.ribbon ?? []).slice(index);
    const ribbon = [...(lead.ribbon ?? []), ...restRibbon];
    const byClass = new Map();
    const add = (cls, m) => {
        byClass.set(cls, (byClass.get(cls) ?? 0) + m);
    };
    for (const [cls, m] of Object.entries(lead.summary.by_class_m)) {
        add(cls, m);
    }
    let restM = 0;
    let restClimb = 0;
    for (const [i, f] of rest.entries()) {
        const seg = restRibbon[i];
        const m = seg?.m ?? featureLength(f);
        restM += m;
        if (seg)
            restClimb += Math.max(0, seg.e1 - seg.e0);
        if (seg?.walk !== true)
            add(f.properties.cls, m);
    }
    const total = lead.summary.meters + restM;
    const share = (classes) => total > 0
        ? Math.round((100 * classes.reduce((a, c) => a + (byClass.get(c) ?? 0), 0)) / total)
        : 0;
    // the loop's cautions that lie on the part still to ride
    const restStarts = new Set(rest.map((f) => {
        const c = f.geometry.coordinates[0];
        return c ? `${c[0]},${c[1]}` : "";
    }));
    const restCautions = loop.summary.cautions.filter((c) => c.lon !== undefined && c.lat !== undefined && restStarts.has(`${c.lon},${c.lat}`));
    const loopM = loop.summary.meters;
    return {
        geojson: { type: "FeatureCollection", features: [...lead.geojson.features, ...rest] },
        ribbon,
        summary: {
            meters: Math.round(total),
            minutes: lead.summary.minutes + (loopM > 0 ? Math.round((loop.summary.minutes * restM) / loopM) : 0),
            climb_m: Math.round((lead.summary.climb_m ?? 0) + restClimb),
            pct_protected: share(PROTECTED_SHARE),
            pct_quiet: share(QUIET_SHARE),
            by_class_m: Object.fromEntries([...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([c, m]) => [c, Math.round(m)])),
            cautions: [...lead.summary.cautions, ...restCautions],
        },
    };
}
const worse = (a, b) => (a > b ? a : b);
/** A way back onto the loop, as an option the cards and navigation both take:
 * the loop's id, so the ride stays a round trip, and the poorer of the two
 * grades, since the rider is going to ride both parts. */
export function rejoinOption(lead, loop, index) {
    return {
        id: loop.id,
        label: `${lead.label}, back to the loop`,
        grade: worse(lead.grade, loop.grade),
        gradeReason: lead.gradeReason,
        payload: spliceLoop(lead.payload, loop.payload, index),
    };
}
