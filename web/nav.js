// Turn-by-turn navigation logic: maneuver generation from a route's geometry
// and GPS-to-route snapping. Pure functions — the UI wiring lives in app.ts.
const M_PER_DEG_LAT = 110540;
function mPerDegLon(lat) {
    return 111320 * Math.cos((lat * Math.PI) / 180);
}
export function distM(a, b) {
    const dx = (b[0] - a[0]) * mPerDegLon((a[1] + b[1]) / 2);
    const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    return Math.hypot(dx, dy);
}
export function bearingDeg(a, b) {
    const dx = (b[0] - a[0]) * mPerDegLon((a[1] + b[1]) / 2);
    const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    return (Math.atan2(dx, dy) * 180) / Math.PI; // 0 = north, clockwise
}
/** Signed turn angle from bearing a to b, in (-180, 180]. */
export function turnAngle(a, b) {
    let d = (b - a) % 360;
    if (d > 180)
        d -= 360;
    if (d <= -180)
        d += 360;
    return d;
}
export function buildTrack(payload) {
    const coords = [];
    for (const f of payload.geojson.features) {
        for (const c of f.geometry.coordinates) {
            const last = coords[coords.length - 1];
            if (last && last[0] === c[0] && last[1] === c[1])
                continue;
            coords.push(c);
        }
    }
    const cumM = [0];
    for (let i = 1; i < coords.length; i++) {
        cumM.push(cumM[i - 1] + distM(coords[i - 1], coords[i]));
    }
    return { coords, cumM, totalM: cumM[cumM.length - 1] ?? 0 };
}
function classifyTurn(delta) {
    const abs = Math.abs(delta);
    if (abs < 25)
        return null;
    const side = delta < 0 ? "left" : "right";
    const arrow = delta < 0 ? { slight: "↖", turn: "⬅", sharp: "⤺" } : { slight: "↗", turn: "➡", sharp: "⤻" };
    if (abs < 60)
        return { icon: arrow.slight, word: `slight ${side}` };
    if (abs < 135)
        return { icon: arrow.turn, word: `turn ${side}` };
    return { icon: arrow.sharp, word: `sharp ${side}` };
}
/** Generate maneuvers at feature boundaries: turns and street-name changes. */
export function buildManeuvers(payload) {
    const feats = payload.geojson.features;
    const maneuvers = [];
    let cum = 0;
    const featLen = (i) => {
        const cs = feats[i]?.geometry.coordinates ?? [];
        let m = 0;
        for (let j = 1; j < cs.length; j++) {
            m += distM(cs[j - 1], cs[j]);
        }
        return m;
    };
    for (let i = 0; i < feats.length - 1; i++) {
        cum += featLen(i);
        const cur = feats[i];
        const nxt = feats[i + 1];
        if (!cur || !nxt)
            continue;
        const curCs = cur.geometry.coordinates;
        const nxtCs = nxt.geometry.coordinates;
        if (curCs.length < 2 || nxtCs.length < 2)
            continue;
        const inBrg = bearingDeg(curCs[curCs.length - 2], curCs[curCs.length - 1]);
        const outBrg = bearingDeg(nxtCs[0], nxtCs[1]);
        const turn = classifyTurn(turnAngle(inBrg, outBrg));
        const curName = cur.properties.name ?? "";
        const nxtName = nxt.properties.name ?? "";
        const nameChanged = nxtName !== "" && nxtName !== curName;
        if (turn === null && !nameChanged)
            continue;
        // suppress boundary noise: same name and only a gentle bend
        if (turn === null && !nameChanged)
            continue;
        const at = nxtCs[0];
        const target = nxtName || "the path";
        if (turn === null) {
            maneuvers.push({
                atM: cum,
                text: target,
                voice: `continue onto ${target}`,
                icon: "⬆",
                lon: at[0],
                lat: at[1],
            });
        }
        else {
            maneuvers.push({
                atM: cum,
                text: target,
                voice: `${turn.word} onto ${target}`,
                icon: turn.icon,
                lon: at[0],
                lat: at[1],
            });
        }
    }
    cum += featLen(feats.length - 1);
    const lastFeat = feats[feats.length - 1];
    const lastCs = lastFeat?.geometry.coordinates ?? [];
    const dest = lastCs[lastCs.length - 1];
    maneuvers.push({
        atM: cum,
        text: "destination",
        voice: "you have arrived",
        icon: "🏁",
        lon: dest?.[0] ?? 0,
        lat: dest?.[1] ?? 0,
    });
    // merge maneuvers closer than 15 m apart (double-announcing feels broken)
    const merged = [];
    for (const m of maneuvers) {
        const prev = merged[merged.length - 1];
        if (prev && m.atM - prev.atM < 15 && m.text !== "destination") {
            prev.text = m.text;
            prev.voice = `${prev.voice}, then ${m.voice}`;
        }
        else {
            merged.push(m);
        }
    }
    return merged;
}
/** Snap a GPS point to the track. `hintIdx` limits the search to a window
 * around the previous position (handles self-crossing loops correctly);
 * pass -1 for a full search. */
export function snapToTrack(track, lon, lat, hintIdx = -1) {
    const { coords, cumM } = track;
    const kx = mPerDegLon(lat);
    const search = (lo, hi) => {
        let best = { idx: Math.max(lo, 0), offM: Infinity, alongM: 0 };
        for (let i = Math.max(lo, 0); i < Math.min(hi, coords.length - 1); i++) {
            const a = coords[i];
            const b = coords[i + 1];
            const ax = (lon - a[0]) * kx;
            const ay = (lat - a[1]) * M_PER_DEG_LAT;
            const bx = (b[0] - a[0]) * kx;
            const by = (b[1] - a[1]) * M_PER_DEG_LAT;
            const len2 = bx * bx + by * by;
            const t = len2 > 0 ? Math.max(0, Math.min(1, (ax * bx + ay * by) / len2)) : 0;
            const dx = ax - t * bx;
            const dy = ay - t * by;
            const off = Math.hypot(dx, dy);
            if (off < best.offM) {
                const segLen = Math.sqrt(len2);
                best = { idx: i, offM: off, alongM: cumM[i] + t * segLen };
            }
        }
        return best;
    };
    if (hintIdx >= 0) {
        const windowed = search(hintIdx - 30, hintIdx + 300);
        if (windowed.offM < 50)
            return windowed;
    }
    return search(0, coords.length - 1);
}
/** Bearing of the track at a segment index (for the follow camera). */
export function trackBearing(track, idx) {
    const a = track.coords[Math.max(0, Math.min(idx, track.coords.length - 2))];
    const b = track.coords[Math.max(1, Math.min(idx + 1, track.coords.length - 1))];
    if (!a || !b)
        return 0;
    return (bearingDeg(a, b) + 360) % 360;
}
