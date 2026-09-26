// The trip in the URL: #s=lon,lat&e=lon,lat&m=profile&f=1&wk=500&x=…&o=…&l=km,kind
//
// A link is how a route is shared, so what it says is read by someone else:
//
// - A trip from "Your location" is written as s=here, not as the sender's
//   coordinates. Written out, the recipient got a route from the sender's
//   front door, pinned there, instead of one from where they are.
// - Coordinates are written to four decimals, about 11 m. Six put the
//   sender's home in every link they shared to within 10 cm, which is more
//   than a route needs and more than anyone meant to publish.

import type { ProfileId, RouteOption } from "./types.js";

/** Decimal places written for a coordinate: 1e-4 degrees is ~11 m. */
export const LINK_DECIMALS = 4;

export type LinkOption = Extract<RouteOption["id"], "safest" | "balanced" | "direct">;

export interface PlanLink {
  /** "here" is the recipient's own location, whoever opens the link. */
  start: [number, number] | "here" | null;
  end: [number, number] | null;
  loop: { km: number; kind: string } | null;
  /** Null when the link does not say, which leaves the rider's own setting. */
  profile: ProfileId | null;
  flat: boolean;
  walkM: number | null;
  avoid: string[] | null;
  option: LinkOption | null;
}

function coord(p: [number, number]): string {
  return `${p[0].toFixed(LINK_DECIMALS)},${p[1].toFixed(LINK_DECIMALS)}`;
}

/** The hash for a plan, without the leading "#". Null when there is nothing
 * worth linking to yet: no start, or neither a destination nor a round trip. */
export function encodePlan(p: PlanLink): string | null {
  if (p.start === null) return null;
  if (p.loop === null && p.end === null) return null;
  const base =
    `s=${p.start === "here" ? "here" : coord(p.start)}` +
    (p.profile !== null ? `&m=${p.profile}` : "") +
    (p.flat ? "&f=1" : "") +
    (p.walkM !== null && p.walkM > 0 ? `&wk=${p.walkM}` : "") +
    (p.avoid !== null && p.avoid.length > 0 ? `&x=${p.avoid.join(",")}` : "");
  if (p.loop !== null) return `${base}&l=${p.loop.km},${p.loop.kind}`;
  if (p.end === null) return null;
  return `${base}&e=${coord(p.end)}` + (p.option !== null ? `&o=${p.option}` : "");
}

function parseCoord(v: string | null): [number, number] | null {
  if (v === null) return null;
  const parts = v.split(",").map(Number);
  const [lng, lat] = parts;
  if (parts.length !== 2 || lng === undefined || lat === undefined) return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  return [lng, lat];
}

const LEGACY_PROFILES: Record<string, ProfileId> = { kids: "young_kids", solo: "solo" };
const PROFILES: readonly ProfileId[] = ["young_kids", "older_kids", "solo"];

/** Read a hash (with or without its "#"). Anything malformed is dropped rather
 * than guessed at. */
export function decodePlan(hash: string): PlanLink {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const m = params.get("m");
  const mapped = m !== null ? (LEGACY_PROFILES[m] ?? m) : null;
  const profile = PROFILES.find((id) => id === mapped) ?? null;
  const wk = params.get("wk");
  const walkM =
    wk === null ? null : wk === "1" ? 500 : Math.max(0, Math.min(2000, Number(wk) || 0));
  const x = params.get("x");
  const o = params.get("o");
  const option: LinkOption | null =
    o === "safest" || o === "balanced" || o === "direct" ? o : null;
  const s = params.get("s");
  const start = s === "here" ? "here" : parseCoord(s);
  let loop: PlanLink["loop"] = null;
  const l = params.get("l");
  if (l !== null) {
    const [kmRaw, kind] = l.split(",");
    const km = Number(kmRaw);
    if (Number.isFinite(km) && km > 0 && kind) loop = { km, kind };
  }
  return {
    start,
    end: parseCoord(params.get("e")),
    loop,
    profile,
    flat: params.get("f") === "1",
    walkM,
    avoid: x === null ? null : x.split(",").filter((t) => t !== ""),
    option,
  };
}
