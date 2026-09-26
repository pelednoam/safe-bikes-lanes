// Ownership of the planner's outputs while a computation waits.
//
// Planning is a chain of waits — the rider's location, the tile manifest, the
// tiles along a corridor — and the rider does not stand still through them. They
// press Reset, pick a second destination, drag the reach slider, close the
// reach map. Each of those starts a newer computation for the same output, or
// withdraws the question altogether, and the one already waiting must not come
// back afterwards and write its answer over the newer state: that is how Reset
// resurrected a cleared trip, how an older destination's route replaced the one
// asked for last, and how a reach map closed mid-load crashed on its own
// missing centre.
//
// A Lane is one output (the route options, the reach map, the search grades).
// Starting work on it takes a Ticket; anything that supersedes the work —
// a newer start, or cancel() — makes every earlier ticket stale. Code checks
// the ticket after every await and gives up quietly when it is stale, leaving
// the output to whoever holds the current one.

import type { ProfileId, ProtectionClass, RouteOption } from "./types.js";

/** Proof of being the newest piece of work on a lane. */
export interface Ticket {
  /** True once newer work started on the lane, or the lane was cancelled. */
  stale(): boolean;
}

export class Lane {
  private gen = 0;

  /** Start work on this lane, superseding whatever was already running. */
  begin(): Ticket {
    const mine = ++this.gen;
    return { stale: (): boolean => mine !== this.gen };
  }

  /** Withdraw the question: every ticket issued so far goes stale. */
  cancel(): void {
    this.gen++;
  }
}

/** Every routing choice the rider has made. */
export interface RoutePrefs {
  profileId: ProfileId;
  preferFlat: boolean;
  avoid: ReadonlySet<ProtectionClass>;
  walkMaxM: number;
}

/** The part of a Router that plans A-to-B options. */
export interface OptionsRouter {
  routeOptions(
    start: [number, number],
    end: [number, number],
    profileId: ProfileId,
    preferFlat: boolean,
    bias: Map<number, number> | undefined,
    avoid: ReadonlySet<ProtectionClass>,
    walkMaxM: number,
  ): RouteOption[];
}

/** Route options with every preference the rider has set, always.
 *
 * routeOptions takes them positionally, most of them optional, and the reroute,
 * the detour and the resume each spelled the call out for themselves — and all
 * three left the walking limit off, so a rider who had said "no more than 500 m
 * pushing the bike" got a reroute with none of that mid-ride, when a new route
 * is hardest to question. Every call in the app goes through here instead
 * (a test holds app.ts to that), so a preference is passed everywhere or
 * nowhere. */
export function planOptions(
  router: OptionsRouter,
  from: [number, number],
  to: [number, number],
  prefs: RoutePrefs,
  bias?: Map<number, number>,
): RouteOption[] {
  return router.routeOptions(
    from,
    to,
    prefs.profileId,
    prefs.preferFlat,
    bias,
    prefs.avoid,
    prefs.walkMaxM,
  );
}

/** The part of a Router a what-if needs. */
export interface Upgradable {
  setUpgradedPoints(points: [number, number][]): number;
}

/** Run `fn` against a router that costs these points as if already built, and
 * put the router back as it was before returning — including when `fn` throws.
 *
 * A what-if is a question about a street that does not exist yet. Left applied,
 * it was the answer to every question after it: the next route, the search
 * grades and turn-by-turn guidance all treated a proposed lane as a built one,
 * which is a safety claim about a street a child would actually ride. Scoping it
 * to one synchronous call also means a router rebuilt while tiles load can never
 * silently drop half of a hypothetical — there is nothing left applied to drop.
 */
export function withUpgraded<T>(
  router: Upgradable,
  points: [number, number][],
  fn: (covered: number) => T,
): { covered: number; result: T } {
  const covered = router.setUpgradedPoints(points);
  try {
    return { covered, result: fn(covered) };
  } finally {
    router.setUpgradedPoints([]);
  }
}
