// "Where to build" — the city-facing view of pipeline/priorities.py. Its data: the
// projects as the pipeline ranked them, what the reader has selected, and a
// what-if in progress.
//
// Everything shown here was measured offline; the panel only filters, re-sorts
// and explains. The weight sliders change the ordering, never the numbers, so a
// city can disagree with our weighting without needing the pipeline.

import { type TripSnapshot } from "../trip.js";

export interface ProjectProps {
  pid: string;
  name: string;
  kind: string;
  towns: string;
  cls: string;
  length_m: number;
  score: number;
  join_m: number;
  crashes: number | null;
  dest_unlocked: number | null;
  pop_gaining: number | null;
  cost_proxy: number;
  group: string;
  group_size: number;
  summary: string;
  c_severance: number;
  c_access: number;
  c_crash: number;
  c_coverage: number;
}

export interface PriorityMeta {
  built?: string;
  candidates?: number;
  mapped?: number;
  destinations?: number;
  population?: { total?: number; is_headcount?: boolean; source?: string };
  access?: { stranded_pct?: number; budget_m?: number; budget_note?: string };
  model?: {
    weights?: { severance?: number; access?: number; crash?: number; coverage?: number };
  };
  limits?: string[];
}

export const WEIGHT_KEYS = ["severance", "access", "crash", "coverage"] as const;

export type WeightKey = (typeof WEIGHT_KEYS)[number];

/** Extent per project, kept from the panel's own load.
 *
 * Read from the map source instead, selecting a row did nothing at all unless
 * the overlay toggle happened to be on already — the source is only filled when
 * the layer loads. The panel has the geometry in hand; it should use it. */
export const projectBounds = new Map<string, [[number, number], [number, number]]>();

export interface Build {
  projects: ProjectProps[];
  /** The loaded layer, kept so re-weighting can repaint it. */
  projectFC: GeoJSON.FeatureCollection | null;
  priorityMeta: PriorityMeta | null;
  selectedProject: string | null;
  /** The project whose what-if is on screen. */
  whatIfPid: string | null;
  /** The trip as really planned, kept while the what-if's version of it is on
   * screen. The hypothetical is computed against a street that does not exist, so
   * it lives only in the what-if view: undo, a new plan and starting a ride all
   * leave it, and none of them ever see a router with the project applied (see
   * withUpgraded). */
  whatIfReal: TripSnapshot | null;
}

export const build: Build = {
  projects: [],
  projectFC: null,
  priorityMeta: null,
  selectedProject: null,
  whatIfPid: null,
  whatIfReal: null,
};
