// The functions one part of the app needs from another that imports it (see
// src/hooks.ts). Each is set once. app.ts sets them in one block right after its
// imports, before anything at start-up can call one, for as long as the function
// is still in app.ts; once it moves out, its module's init sets it, and says in the
// doc below when it can first be called.
import { hook } from "../hooks.js";
import type { Ticket } from "../planner.js";
import type { RouteOption } from "../types.js";
import type { SearchRowView } from "../ui/SearchResults.js";

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
  /** Take a row of the search list. Set by initSearchResults; only a tap on a row
   * calls it. */
  chooseSearchRow: hook<[row: SearchRowView], void>("chooseSearchRow"),
  /** Save a row of the search list as a place and clear the list. Set by
   * initSearchResults; only a tap on its save button calls it. */
  saveSearchRow: hook<[row: SearchRowView], void>("saveSearchRow"),
  /** Put the sheet back after a search took it over. Set by initPhoneSearch: callable
   * once start-up has reached it, and only a tap on a search row does. */
  leaveSearchMode: hook<[chose: boolean], void>("leaveSearchMode"),
  /** Close the card that follows the pointer over the map. */
  dropHoverCard: hook<[], void>("dropHoverCard"),
  /** Open the hazard report dialog at a place. */
  openHazardDialog: hook<[lon: number, lat: number], void>("openHazardDialog"),
};
