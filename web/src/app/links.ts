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
  /** Read the hazards stored on the device (and a restored backup's), tell the router,
   * and redraw them. */
  refreshHazards: hook<[], Promise<void>>("refreshHazards"),
  /** Plan a round trip from what is in the loop fields. Set by initPlanLoop. */
  requestLoop: hook<[], Promise<void>>("requestLoop"),
  /** Plan the route for the two ends as they stand. */
  requestRoute: hook<[], Promise<void>>("requestRoute"),
  /** Grade the search rows on screen again, after something that changes the grade.
   * Set by initSearchGrade, early in app.ts. */
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
  /** Put the sheet back after a search took it over. Set by initPhoneSearch. The search
   * results need the hook (importing phone-search would make a cycle) and call it when
   * a row is chosen, by a tap or by Enter in a search box; the search box itself
   * imports the function. */
  leaveSearchMode: hook<[chose: boolean], void>("leaveSearchMode"),
  /** Frame a route on the map, for the part of the screen the sheet leaves free. */
  frameRoute: hook<[option: RouteOption], void>("frameRoute"),
  /** Rebuild the ride's track from the selected option (false if there is none). */
  rebuildNavFromSelected: hook<[], boolean>("rebuildNavFromSelected"),
  /** Plan again from where the rider is, mid-ride. */
  replanRide: hook<[], Promise<void>>("replanRide"),
  /** Write the trip into the address bar. Set by initPermalink; the planners call it
   * when an option is chosen, which is after a plan has arrived. */
  updateHash: hook<[], void>("updateHash"),
  /** Clear the trip (and, unless told not to, the link). Set by initPlanControls; the
   * permalink calls it when the address changes under a trip, which is an event. */
  resetPlan: hook<[clearLink?: boolean], void>("resetPlan"),
  /** Take down the hazard-classification prompt. Set in app.ts's early block. */
  hideClassify: hook<[], void>("hideClassify"),
  /** Show the ride's arrival. Set by initNavSession; the ride calls it when the rider
   * arrives, which is after start-up. */
  showArrival: hook<[atStop: boolean, totalM: number], void>("showArrival"),
  /** Close the card that follows the pointer over the map. */
  dropHoverCard: hook<[], void>("dropHoverCard"),
  /** Open the hazard report dialog at a place. */
  openHazardDialog: hook<[lon: number, lat: number], void>("openHazardDialog"),
};
