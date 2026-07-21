// Turn-by-turn navigation logic: maneuver generation from a route's geometry
// and GPS-to-route snapping. Pure functions — the UI wiring lives in app.ts.

import type { RoutePayload } from "./types.js";

export interface Maneuver {
  /** Cumulative distance along the route where the maneuver happens. */
  atM: number;
  /** Short banner text, e.g. "Elm Street". */
  text: string;
  /** Spoken instruction, e.g. "turn left onto Elm Street". */
  voice: string;
  icon: string;
  lon: number;
  lat: number;
}

export interface Track {
  coords: [number, number][];
  /** Cumulative meters at each coordinate. */
  cumM: number[];
  totalM: number;
}

export interface Snap {
  /** Segment index (coords[idx] -> coords[idx+1]). */
  idx: number;
  /** Meters from the GPS point to the route. */
  offM: number;
  /** Meters traveled along the route. */
  alongM: number;
}

const M_PER_DEG_LAT = 110_540;

function mPerDegLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

export function distM(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * mPerDegLon((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

export function bearingDeg(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * mPerDegLon((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return (Math.atan2(dx, dy) * 180) / Math.PI; // 0 = north, clockwise
}

/** Signed turn angle from bearing a to b, in (-180, 180]. */
export function turnAngle(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function buildTrack(payload: RoutePayload): Track {
  const coords: [number, number][] = [];
  for (const f of payload.geojson.features) {
    for (const c of f.geometry.coordinates) {
      const last = coords[coords.length - 1];
      if (last && last[0] === c[0] && last[1] === c[1]) continue;
      coords.push(c);
    }
  }
  const cumM: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cumM.push(
      (cumM[i - 1] as number) + distM(coords[i - 1] as [number, number], coords[i] as [number, number]),
    );
  }
  return { coords, cumM, totalM: cumM[cumM.length - 1] ?? 0 };
}

interface TurnKind {
  icon: string;
  word: string;
}

function classifyTurn(delta: number): TurnKind | null {
  const abs = Math.abs(delta);
  if (abs < 25) return null;
  const side = delta < 0 ? "left" : "right";
  const arrow = delta < 0 ? { slight: "↖", turn: "⬅", sharp: "⤺" } : { slight: "↗", turn: "➡", sharp: "⤻" };
  if (abs < 60) return { icon: arrow.slight, word: `slight ${side}` };
  if (abs < 135) return { icon: arrow.turn, word: `turn ${side}` };
  return { icon: arrow.sharp, word: `sharp ${side}` };
}

/** Generate maneuvers at feature boundaries: turns and street-name changes. */
export function buildManeuvers(payload: RoutePayload): Maneuver[] {
  const feats = payload.geojson.features;
  const maneuvers: Maneuver[] = [];
  let cum = 0;
  const featLen = (i: number): number => {
    const cs = feats[i]?.geometry.coordinates ?? [];
    let m = 0;
    for (let j = 1; j < cs.length; j++) {
      m += distM(cs[j - 1] as [number, number], cs[j] as [number, number]);
    }
    return m;
  };
  for (let i = 0; i < feats.length - 1; i++) {
    cum += featLen(i);
    const cur = feats[i];
    const nxt = feats[i + 1];
    if (!cur || !nxt) continue;
    const curCs = cur.geometry.coordinates;
    const nxtCs = nxt.geometry.coordinates;
    if (curCs.length < 2 || nxtCs.length < 2) continue;
    const inBrg = bearingDeg(
      curCs[curCs.length - 2] as [number, number],
      curCs[curCs.length - 1] as [number, number],
    );
    const outBrg = bearingDeg(nxtCs[0] as [number, number], nxtCs[1] as [number, number]);
    const turn = classifyTurn(turnAngle(inBrg, outBrg));
    const curName = cur.properties.name ?? "";
    const nxtName = nxt.properties.name ?? "";
    const nameChanged = nxtName !== "" && nxtName !== curName;
    if (turn === null && !nameChanged) continue;
    // suppress boundary noise: same name and only a gentle bend
    if (turn === null && !nameChanged) continue;
    const at = nxtCs[0] as [number, number];
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
    } else {
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
  const dest = lastCs[lastCs.length - 1] as [number, number] | undefined;
  maneuvers.push({
    atM: cum,
    text: "destination",
    voice: "you have arrived",
    icon: "🏁",
    lon: dest?.[0] ?? 0,
    lat: dest?.[1] ?? 0,
  });
  // merge maneuvers closer than 15 m apart (double-announcing feels broken)
  const merged: Maneuver[] = [];
  for (const m of maneuvers) {
    const prev = merged[merged.length - 1];
    if (prev && m.atM - prev.atM < 15 && m.text !== "destination") {
      prev.text = m.text;
      prev.voice = `${prev.voice}, then ${m.voice}`;
    } else {
      merged.push(m);
    }
  }
  return merged;
}

/** Snap a GPS point to the track. `hintIdx` limits the search to a window
 * around the previous position (handles self-crossing loops correctly);
 * pass -1 for a full search. */
export function snapToTrack(track: Track, lon: number, lat: number, hintIdx = -1): Snap {
  const { coords, cumM } = track;
  const kx = mPerDegLon(lat);
  const search = (lo: number, hi: number): Snap => {
    let best: Snap = { idx: Math.max(lo, 0), offM: Infinity, alongM: 0 };
    for (let i = Math.max(lo, 0); i < Math.min(hi, coords.length - 1); i++) {
      const a = coords[i] as [number, number];
      const b = coords[i + 1] as [number, number];
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
        best = { idx: i, offM: off, alongM: (cumM[i] as number) + t * segLen };
      }
    }
    return best;
  };
  if (hintIdx >= 0) {
    const windowed = search(hintIdx - 30, hintIdx + 300);
    if (windowed.offM < 50) return windowed;
  }
  return search(0, coords.length - 1);
}

// ---------------------------------------------------------------------------
// ride alerts: hazards ahead (busy crossings, stressful stretches)
// ---------------------------------------------------------------------------

export interface RideAlert {
  atM: number;
  voice: string;
}

const ALERT_CLASS_LABEL: Partial<Record<string, string>> = {
  sharrow: "a shared lane",
  moderate_street: "a moderate street",
  busy_street: "a busy street",
};

/** Voice-only warnings generated from the route ribbon: unsignalized busy
 * crossings and caution-class stretches of 30 m or more. */
export function buildAlerts(payload: RoutePayload): RideAlert[] {
  const ribbon = payload.ribbon ?? [];
  const alerts: RideAlert[] = [];
  let cum = 0;
  let runStart = -1;
  let runLen = 0;
  let runCls = "";
  const flushRun = (): void => {
    if (runStart >= 0 && runLen >= 30) {
      const label = ALERT_CLASS_LABEL[runCls] ?? "a stressful street";
      alerts.push({
        atM: runStart,
        voice: `entering ${label} for ${Math.round(runLen / 10) * 10} meters. ride carefully.`,
      });
    }
    runStart = -1;
    runLen = 0;
    runCls = "";
  };
  let walkRun = -1.0;
  let walkLen = 0.0;
  for (const seg of ribbon) {
    if (seg.walk === true) {
      if (walkRun < 0) {
        walkRun = cum;
        walkLen = 0;
      }
      walkLen += seg.m;
    } else if (walkRun >= 0) {
      alerts.push({
        atM: walkRun,
        voice: `hop off and walk the bike for about ${Math.round(walkLen / 10) * 10} meters.`,
      });
      alerts.push({ atM: cum, voice: "you can ride again." });
      walkRun = -1;
    }
    if (seg.crossing) {
      alerts.push({ atM: cum, voice: "busy street crossing. gather up." });
    }
    if (ALERT_CLASS_LABEL[seg.cls] !== undefined) {
      if (runStart < 0 || runCls !== seg.cls) {
        flushRun();
        runStart = cum;
        runCls = seg.cls;
      }
      runLen += seg.m;
    } else {
      flushRun();
    }
    cum += seg.m;
  }
  flushRun();
  if (walkRun >= 0) {
    alerts.push({
      atM: walkRun,
      voice: `hop off and walk the bike for about ${Math.round(walkLen / 10) * 10} meters.`,
    });
  }
  alerts.sort((a, b) => a.atM - b.atM);
  // drop alerts within 30 m of the previous one — voice pile-ups are worse
  // than a missed secondary warning
  const merged: RideAlert[] = [];
  for (const a of alerts) {
    const prev = merged[merged.length - 1];
    if (prev && a.atM - prev.atM < 30) continue;
    merged.push(a);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// sunset (NOAA solar position approximation, good to a few minutes)
// ---------------------------------------------------------------------------

export function sunsetTime(date: Date, lat: number, lon: number): Date {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const doy = Math.floor((date.getTime() - start) / 86_400_000);
  const rad = Math.PI / 180;
  const gamma = ((2 * Math.PI) / 365) * (doy - 1);
  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const cosHa =
    Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) -
    Math.tan(lat * rad) * Math.tan(decl);
  const haDeg = Math.acos(Math.max(-1, Math.min(1, cosHa))) / rad;
  const sunsetMinUtc = 720 - 4 * (lon - haDeg) - eqtime;
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return new Date(day + sunsetMinUtc * 60_000);
}

/** Bearing of the track at a segment index (for the follow camera). */
export function trackBearing(track: Track, idx: number): number {
  const a = track.coords[Math.max(0, Math.min(idx, track.coords.length - 2))];
  const b = track.coords[Math.max(1, Math.min(idx + 1, track.coords.length - 1))];
  if (!a || !b) return 0;
  return (bearingDeg(a, b) + 360) % 360;
}
