// Shared payload types (shape mirrors the FastAPI server in server/app.py,
// which remains available for local development).

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

export type RideMode = "kids" | "solo";

export interface Caution {
  name: string;
  cls: ProtectionClass;
  meters: number;
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
}

export interface RouteFeatureProps {
  cls: ProtectionClass;
  color: string;
  name: string | null;
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
}

export interface RouteResponse {
  safest: RoutePayload;
  shortest: RoutePayload;
}
