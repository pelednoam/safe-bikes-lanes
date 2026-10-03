// The long-lived objects the rest of the app shares: the routing worker, the
// basemap's layers, the trip, and the lanes that keep an old answer from landing
// late.

import { wrap } from "../rpc.js";
import { type RoutingApi } from "../routing.js";
import { createBasemap } from "../basemap.js";
import { map } from "./map.js";
import { Trip } from "../trip.js";
import { Lane } from "../planner.js";
import { initDataSource } from "../data.js";

/** Routing runs in a worker (routing.ts): the tiles, the graph and every
 * search, off this thread, so the map and the buttons keep working while a
 * route is found. The page asks and awaits. */
export const routing = wrap<RoutingApi>(new Worker(new URL("../routing.worker.ts", import.meta.url)));

/** The basemap's layers, injected under everything this app draws. A theme's
 * layers are added the first time that theme is shown — see applyBasemap. */
export const basemap = createBasemap(map, () => map.getStyle().layers.find((l) => l.id !== "ground")?.id);

/** The route options on screen and the chosen one (trip.ts): a plan's answer
 * is published with the ticket it was planned under, and refused if stale. */
export const trip = new Trip();

/** Who owns each output while planning waits (see planner.ts): the route
 * options (a trip, a round trip, a what-if), the reach map, and the letters on
 * the search list. Every await in their code is followed by a staleness check. */
export const routeLane = new Lane();

export const shedLane = new Lane();
export const gradeLane = new Lane();

/** Resolves once the data source is chosen (the site's own copy, or a newer one
 * from the network): everything that reads data waits for this. */
export const dataReady: Promise<void> = initDataSource();
