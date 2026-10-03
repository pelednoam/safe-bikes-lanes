// The state that more than one part of the app reads or writes: the two ends of
// the trip and how they were chosen, the rider's routing choices, and what is
// loaded. Everything used by one part of the app only lives with that part.
import type { Marker } from "maplibre-gl";

import type { HazardReport } from "../hazards.js";
import { readJson } from "../storage.js";
import type { PoiFeature, ProfileId, ProtectionClass } from "../types.js";

export const SKETCHY_KEY = "sketchyMarks";

/** The classes a rider can ask the router to avoid, and what each is called. */
export const AVOIDABLE: [ProtectionClass, string][] = [
  ["lane", "painted lanes"],
  ["buffered", "buffered lanes"],
  ["sharrow", "sharrows"],
  ["moderate_street", "moderate streets"],
  ["busy_street", "busy streets"],
  ["unpaved", "unpaved paths"],
];

export function loadSketchy(): [number, number][] {
  try {
    const raw = localStorage.getItem(SKETCHY_KEY);
    if (raw === null) return [];
    return JSON.parse(raw) as [number, number][];
  } catch {
    return [];
  }
}

// Read at module level, so it must not throw: with site data blocked, the old
// unguarded read here stopped the whole app on load (see storage.ts).
const storedAvoid = readJson<unknown>("avoidTypes", []);

export interface ConstructionFC {
  features: {
    geometry: { type: string; coordinates: unknown };
    properties: { src: string; name: string; detail?: string; start: string; end: string };
  }[];
}

export interface Store {
  /** True once some tiles are loaded and the graph is built over them. */
  routerReady: boolean;
  start: Marker | null;
  end: Marker | null;
  /** Google-Maps-style flow: origin defaults to the current location; the next
   * map tap fills the destination unless the user is explicitly picking a start. */
  fromCurrent: boolean;
  activeField: "start" | "end";
  profileId: ProfileId;
  preferFlat: boolean;
  walkMaxM: number;
  avoidTypes: Set<ProtectionClass>;
  shedMode: boolean;
  /** Bumped whenever what the router must avoid changes, so a grade computed before
   * it is not taken for one that still holds. */
  avoidRevision: number;
  /** The marker for a point of interest the rider picked. */
  poiMarker: Marker | null;
  /** Where the reach map is centred, once the rider has tapped. */
  shedCenter: [number, number] | null;
  sketchyMarks: [number, number][];
  pois: PoiFeature[];
  hazards: HazardReport[];
  mapillaryToken: string;
  /** Turn-by-turn is running. */
  navActive: boolean;
  loopParams: { km: number; kind: string } | null;
  /** The construction zones, once loaded: what the router avoids and the map draws. */
  constructionFC: ConstructionFC | null;
}

export const store: Store = {
  routerReady: false,
  start: null,
  end: null,
  fromCurrent: true,
  activeField: "end",
  profileId: "young_kids",
  preferFlat: false,
  walkMaxM: 0,
  avoidTypes: new Set<ProtectionClass>(Array.isArray(storedAvoid) ? (storedAvoid as ProtectionClass[]) : []),
  shedMode: false,
  avoidRevision: 0,
  poiMarker: null,
  shedCenter: null,
  sketchyMarks: loadSketchy(),
  pois: [],
  hazards: [],
  mapillaryToken: "",
  navActive: false,
  loopParams: null,
  constructionFC: null,
};
