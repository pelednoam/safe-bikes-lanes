// ---------------------------------------------------------------------------
// The trip on screen: the route options, and which one is chosen.
//
// Everything that plans (a trip, a round trip, a what-if, a mid-ride reroute,
// a detour, the way back from one) finishes after an await, by which time the
// rider may have asked for something else. Each of them used to check its own
// ticket before writing the options, and each one that forgot, or checked one
// await too early, put an abandoned plan's routes on screen: the planning-race
// and what-if bugs of the past months. Here a plan's answer can only be
// published with the ticket it was planned under, and a stale ticket's answer
// is refused. Reset and undo write directly: they own the screen.
// ---------------------------------------------------------------------------

import type { Ticket } from "./planner.js";
import type { RouteOption } from "./types.js";

export type OptionId = RouteOption["id"];

/** What was on screen, to put back (a what-if's undo). */
export interface TripSnapshot {
  options: RouteOption[];
  selected: OptionId | null;
}

export class Trip {
  private list: RouteOption[] = [];
  private chosen: OptionId | null = null;

  get options(): readonly RouteOption[] {
    return this.list;
  }

  get selectedId(): OptionId | null {
    return this.chosen;
  }

  /** The chosen option, if it is one of the options. */
  get selected(): RouteOption | undefined {
    return this.list.find((o) => o.id === this.chosen);
  }

  /** A plan's options, on screen if `ticket` is still the plan being waited
   * for. False, and nothing written, when it isn't. The selection is left to
   * the caller (selectOption), which draws it. */
  publish(ticket: Ticket, options: RouteOption[]): boolean {
    if (ticket.stale()) return false;
    this.list = options;
    if (this.chosen !== null && !options.some((o) => o.id === this.chosen)) this.chosen = null;
    return true;
  }

  /** Choose one of the options on screen. False when there is no such option:
   * a stale id (a card from before a re-plan) must not select nothing. */
  select(id: OptionId): boolean {
    if (!this.list.some((o) => o.id === id)) return false;
    this.chosen = id;
    return true;
  }

  /** Nothing planned: Reset, or a plan that ended in an error. */
  clear(): void {
    this.list = [];
    this.chosen = null;
  }

  snapshot(): TripSnapshot {
    return { options: [...this.list], selected: this.chosen };
  }

  /** Put a snapshot back as it was: undoing a what-if. */
  restore(s: TripSnapshot): void {
    this.list = [...s.options];
    this.chosen = s.selected !== null && s.options.some((o) => o.id === s.selected) ? s.selected : null;
  }
}
