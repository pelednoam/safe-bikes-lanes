// The functions one part of the app needs from another that imports it (see
// src/hooks.ts). Each is set once. app.ts sets them in one block right after its
// imports, before anything at start-up can call one, for as long as the function
// is still in app.ts; once it moves out, its module's init sets it, and says in the
// doc below when it can first be called.
import { hook } from "../hooks.js";
import type { Ticket } from "../planner.js";
import type { RouteOption } from "../types.js";

export const links = {
  /** Plan the route for the two ends as they stand. */
  requestRoute: hook<[], Promise<void>>("requestRoute"),
  /** Grade the search rows on screen again, after something that changes the grade. */
  regradeVisible: hook<[], void>("regradeVisible"),
  /** Plan between two points the rider picked from a list. */
  planBetween: hook<[start: [number, number], end: [number, number]], void>("planBetween"),
  /** Draw the marked spots' list again, after they were replaced (a restored
   * backup). Set by initSketchy: callable once start-up has reached it, and today
   * only a click on the backup button does. */
  renderSketchy: hook<[], void>("renderSketchy"),
  /** Start planning: the ticket the answer will be published under, after ending a
   * what-if that was on screen. */
  beginPlan: hook<[], Ticket>("beginPlan"),
  /** Make one of the planned options the drawn one. */
  selectOption: hook<[id: RouteOption["id"]], void>("selectOption"),
  /** Close the card that follows the pointer over the map. */
  dropHoverCard: hook<[], void>("dropHoverCard"),
  /** Open the hazard report dialog at a place. */
  openHazardDialog: hook<[lon: number, lat: number], void>("openHazardDialog"),
};
