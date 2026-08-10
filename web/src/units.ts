// Distances, in the units the rider thinks in.
//
// Everything inside the app is metres — the graph, the router, the cues — and
// nothing here changes that. This is the last step before a number is shown or
// spoken. The default is imperial because this is eastern Massachusetts and the
// people using it are American; the toggle exists because plenty of cyclists
// still think in kilometres, and being told your ride is 4.97 miles when you
// wanted 8 km is its own small annoyance.

export type Units = "imperial" | "metric";

const KEY = "units";
// exact: a mile is 1609.344 m and 5280 ft by definition, so derive feet from
// those rather than from a rounded constant — going metres -> feet -> miles
// with an approximation made one mile come out as 1.0000000058, which a
// trailing-zero trim then read as "1.0 miles"
const FT_PER_M = 5280 / 1609.344;
const M_PER_MI = 1609.344;

let current: Units = read();

function read(): Units {
  try {
    return localStorage.getItem(KEY) === "metric" ? "metric" : "imperial";
  } catch {
    return "imperial"; // private mode
  }
}

export function getUnits(): Units {
  return current;
}

export function setUnits(u: Units): void {
  current = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    /* private mode: the choice just won't be remembered */
  }
}

/** Metres from a number the rider typed, in whichever unit they're using. */
export function toMeters(value: number): number {
  return current === "imperial" ? value * M_PER_MI : value * 1000;
}

/** The rider's own unit, from metres — for pre-filling a field they'll edit. */
export function fromMeters(m: number): number {
  return current === "imperial" ? m / M_PER_MI : m / 1000;
}

/** "miles" / "km", for labelling a field. */
export function unitName(): string {
  return current === "imperial" ? "miles" : "km";
}

/** A distance to read: "590 ft", "1.2 mi", "800 m", "3.4 km".
 *
 * Feet up to 1000, then miles — the point where an American stops counting in
 * feet. A block of 180 m is "590 ft" to a rider and "0.1 mi" to nobody. */
const FT_SWITCH = 1000;

export function fmtDist(m: number): string {
  if (current === "imperial") {
    const ft = m * FT_PER_M;
    return ft < FT_SWITCH ? `${Math.round(ft)} ft` : `${(m / M_PER_MI).toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** The same, without a pointless decimal: "1 mi", not "1.0 mi". */
export function fmtDistTight(m: number): string {
  if (current === "imperial") {
    const ft = m * FT_PER_M;
    if (ft < FT_SWITCH) return `${Math.round(ft)} ft`;
    const mi = m / M_PER_MI;
    return `${Number.isInteger(mi) ? String(mi) : mi.toFixed(1)} mi`;
  }
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${Number.isInteger(km) ? String(km) : km.toFixed(1)} km`;
}

/** Rounded to a figure worth calling out, in the rider's own unit.
 *
 * Guidance is useless at false precision — "in 87 metres" is noise — and the
 * round numbers differ by system: feet go 50, 100, 500; metres go 10, 50, 100.
 * Returns metres still, so callers keep doing their arithmetic in metres.
 */
export function navRound(m: number): number {
  if (m < 15) return 0; // "now"
  if (current === "imperial") {
    const ft = m * FT_PER_M;
    if (ft < 300) return Math.round(ft / 50) * 50 / FT_PER_M;
    if (ft < 1000) return Math.round(ft / 100) * 100 / FT_PER_M;
    const mi = ft / 5280;
    return (mi < 1 ? Math.round(mi * 10) / 10 : Math.round(mi * 4) / 4) * M_PER_MI;
  }
  if (m < 100) return Math.round(m / 10) * 10;
  if (m < 500) return Math.round(m / 50) * 50;
  return Math.round(m / 100) * 100;
}

/** A distance as it should be spoken. */
export function distVoice(m: number): string {
  const r = navRound(m);
  if (r === 0) return "now";
  if (current === "imperial") {
    const ft = r * FT_PER_M;
    if (ft < 1000) return `${Math.round(ft / 10) * 10} feet`;
    // parseFloat drops trailing zeros without leaving a bare decimal point
    const said = String(parseFloat((r / M_PER_MI).toFixed(2)));
    return `${said} mile${said === "1" ? "" : "s"}`;
  }
  if (r < 1000) return `${Math.round(r)} meters`;
  const km = r / 1000;
  const said = Number.isInteger(km) ? String(km) : km.toFixed(1);
  return `${said} kilometer${said === "1" ? "" : "s"}`;
}

/** A climb: feet or metres. Always the small unit — nobody describes a hill in
 * miles, and "0.04 mi of climbing" is a sentence no one has ever wanted. */
export function fmtClimb(m: number): string {
  return current === "imperial" ? `${Math.round(m * FT_PER_M)} ft` : `${Math.round(m)} m`;
}

/** Riding speed: mph or km/h. */
export function fmtSpeed(metersPerSecond: number): string {
  return current === "imperial"
    ? `${(metersPerSecond * 2.236936).toFixed(1)} mph`
    : `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}
