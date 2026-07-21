// Shared payload types. The FastAPI server in server/app.py mirrors the
// summary shape for local development.

export type ProtectionClass =
  | "path"
  | "separated"
  | "buffered"
  | "quiet_street"
  | "service"
  | "lane"
  | "sharrow"
  | "moderate_street"
  | "busy_street";

/** Rider profiles: all weighting is client-side, computed from raw edge data. */
export type ProfileId = "young_kids" | "older_kids" | "solo";

export interface RiderProfile {
  id: ProfileId;
  label: string;
  /** Average riding pace used for time estimates. */
  paceKmh: number;
  mult: Record<ProtectionClass, number>;
  /** Overrides when a painted/buffered lane runs on a busy road. */
  busyLane: number;
  busyBuffered: number;
  /** Scale on busy-crossing penalties. */
  penScale: number;
}

export interface Caution {
  name: string;
  cls: ProtectionClass;
  meters: number;
  /** Location of the start of the stretch (for map/Street View preview). */
  lon?: number;
  lat?: number;
}

/** One segment of the linear route ribbon. */
export interface RibbonSeg {
  m: number;
  cls: ProtectionClass;
  /** Elevation at segment start/end, meters. */
  e0: number;
  e1: number;
  /** True where the segment starts at a penalized busy crossing. */
  crossing: boolean;
  /** True where the rider dismounts and walks the bike. */
  walk?: boolean;
}

export interface RouteSummary {
  meters: number;
  minutes: number;
  pct_protected: number;
  pct_quiet: number;
  by_class_m: Partial<Record<ProtectionClass, number>>;
  cautions: Caution[];
  shortest_meters?: number;
  detour_pct?: number;
  /** Total elevation gain along the route, meters. */
  climb_m?: number;
  /** Meters walked (bike pushed) along the route. */
  walk_m?: number;
  /** Human-readable reasons why this route was chosen (browser router only). */
  explanation?: string[];
}

export interface RouteFeatureProps {
  cls: ProtectionClass;
  color: string;
  name: string | null;
  /** True where the rider walks the bike. */
  walk?: boolean;
}

export interface LineFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: RouteFeatureProps;
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: LineFeature[];
}

export interface RoutePayload {
  geojson: FeatureCollection;
  summary: RouteSummary;
  ribbon?: RibbonSeg[];
}

export interface RouteResponse {
  safest: RoutePayload;
  shortest: RoutePayload;
}

/** Safety grade for a whole route: average kid-level stress per meter. */
export type SafetyGrade = "A" | "B" | "C" | "D" | "F";

export interface RouteOption {
  id: "safest" | "balanced" | "direct" | "loop";
  label: string;
  grade: SafetyGrade;
  /** One-line justification of the grade. */
  gradeReason: string;
  payload: RoutePayload;
}

/** Result of a safe-shed (reachability) query. */
export interface ShedResult {
  geojson: FeatureCollection;
  /** Fraction (0-100) of the network length reachable within the budget. */
  pctReachable: number;
  reachableKm: number;
}

export interface PoiFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { kind: string; name: string };
}

export interface CueEntry {
  km: number;
  text: string;
}
