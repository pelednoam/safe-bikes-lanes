// What if this were protected? Re-plan the reader's own trip as if a project
// already existed, show it beside the real one, and put everything back.
//
// The ranked list asserts a project is worth building. This lets the reader check it
// against their own trip, which is the difference between a number and an argument.

import { links } from "./links.js";
import { Lane } from "../planner.js";
import { build } from "./build-state.js";
import { el } from "./dom.js";
import { routeLane, routing, trip } from "./services.js";
import { type TripSnapshot } from "../trip.js";
import { store } from "./store.js";
import { fmtDist, fmtDistTight } from "../units.js";
import { ensureRouter } from "./data-load.js";
import { type RouteOption } from "../types.js";
import { routePrefs } from "./avoid.js";

/** A what-if answered with reach (no trip planned): the newest question wins. */
export const whatIfLane = new Lane();

/** Leave the what-if view without touching what is drawn — for a new plan,
 * which is about to replace the drawn trip anyway. */
export function endWhatIf(): void {
  if (build.whatIfPid === null && build.whatIfReal === null) return;
  build.whatIfPid = null;
  build.whatIfReal = null;
  el<HTMLButtonElement>("whatif-clear").style.display = "none";
  el<HTMLDivElement>("whatif-result").textContent = "";
}

export function whatIfPoints(pid: string): [number, number][] {
  const feature = build.projectFC?.features.find(
    (f) => (f.properties as { pid?: string } | null)?.pid === pid,
  );
  if (!feature) return [];
  const parts: [number, number][] =
    feature.geometry.type === "MultiLineString"
      ? (feature.geometry.coordinates.flat() as [number, number][])
      : feature.geometry.type === "LineString"
        ? (feature.geometry.coordinates as [number, number][])
        : [];
  return parts;
}

/** Undo: the real trip back on screen, exactly as it was planned. */
export function clearWhatIf(): void {
  const real = build.whatIfReal;
  endWhatIf();
  if (real === null) return;
  // anything still working out a what-if is for a view that is gone
  routeLane.cancel();
  showRealTrip(real);
}

export function showRealTrip(real: TripSnapshot): void {
  trip.restore(real);
  const back = real.selected ?? real.options[0]?.id;
  if (back !== undefined) links.selectOption.call(back);
}

export async function runWhatIf(pid: string): Promise<void> {
  const out = el<HTMLDivElement>("whatif-result");
  const points = whatIfPoints(pid);
  if (points.length === 0) {
    out.textContent = "couldn't find that project's shape";
    return;
  }
  if (!store.start || !store.end) {
    // no trip planned: answer with reach instead, which needs only one point
    const from = store.start ?? store.end;
    if (!store.routerReady || !from) {
      out.textContent = "plan a trip, or set a start, and ask again";
      return;
    }
    const at = from.getLngLat();
    const budget = 2500;
    const ticket = whatIfLane.begin();
    const center: [number, number] = [at.lng, at.lat];
    const before = await routing.safeShed(center, budget, store.profileId, store.preferFlat);
    const { result: after } = await routing.safeShedWith(points, center, budget, store.profileId, store.preferFlat);
    if (ticket.stale()) return;
    build.whatIfPid = pid;
    el<HTMLButtonElement>("whatif-clear").style.display = "";
    const gain = Math.round((after.reachableKm - before.reachableKm) * 10) / 10;
    out.textContent =
      gain > 0
        ? `From your start, ${fmtDistTight(gain * 1000)} more of kid-safe street comes into ` +
          `reach (${fmtDistTight(before.reachableKm * 1000)} → ` +
          `${fmtDistTight(after.reachableKm * 1000)}).`
        : "From your start, this one doesn't change what's in reach.";
    return;
  }

  // measured against the real trip, even when another what-if is on screen —
  // which goes first, so a failure below leaves the real trip drawn
  clearWhatIf();
  const real = trip.snapshot();
  const chosen = real.options.find((o) => o.id === real.selected) ?? real.options[0];
  if (!chosen) {
    out.textContent = "plan a trip first, then ask";
    return;
  }
  const was = chosen.payload.summary;
  const s = store.start.getLngLat();
  const d = store.end.getLngLat();
  const a: [number, number] = [s.lng, s.lat];
  const b: [number, number] = [d.lng, d.lat];
  const ticket = links.beginPlan.call();
  whatIfLane.cancel();
  const mapped = await ensureRouter([a, b], 1200, 1);
  if (ticket.stale()) return;
  let hypothetical: RouteOption[] = [];
  let covered = 0;
  try {
    if (!mapped) throw new Error("unmapped");
    // applied for this one computation and taken off again before anything
    // else can route: the next trip, a search grade or a ride must never be
    // planned along a lane that has only been proposed (the worker runs it
    // start to finish before it answers anything else)
    ({ covered, result: hypothetical } = await routing.planWith(points, a, b, routePrefs()));
  } catch {
    hypothetical = [];
  }
  if (ticket.stale()) return;
  const shown = hypothetical.find((o) => o.id === chosen.id) ?? hypothetical[0];
  if (!shown) {
    out.textContent = "couldn't re-plan with that built";
    return;
  }
  if (!trip.publish(ticket, hypothetical)) return;
  build.whatIfReal = real;
  build.whatIfPid = pid;
  links.selectOption.call(shown.id);
  el<HTMLButtonElement>("whatif-clear").style.display = "";
  const now = shown.payload.summary;
  const dM = now.meters - was.meters;
  const dProt = now.pct_protected - was.pct_protected;
  const parts: string[] = [];
  if (dProt !== 0) parts.push(`${dProt > 0 ? "+" : ""}${dProt}% protected`);
  if (Math.abs(dM) >= 50) parts.push(`${dM > 0 ? "+" : "−"}${fmtDist(Math.abs(dM))}`);
  out.innerHTML = "";
  const line = document.createElement("b");
  line.textContent =
    parts.length > 0
      ? `Your trip: ${parts.join(", ")}.`
      : "Your trip doesn't change — this project isn't on your way.";
  out.appendChild(line);
  // never let the phrasing imply more was modelled than actually matched
  out.appendChild(
    document.createTextNode(
      ` Modelled as ${covered} rebuilt segment${covered === 1 ? "" : "s"}, separated,` +
        " with its crash history and crossing penalty removed — the same" +
        " assumption the ranking uses.",
    ),
  );
}
