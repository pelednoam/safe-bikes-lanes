// Scoring the projects with the reader's weights: the published weighting, the
// sliders' values, the ranked list, and repainting the map's layer.

import { type ProjectProps, WEIGHT_KEYS, type WeightKey, build } from "./build-state.js";
import { el } from "./dom.js";
import { map } from "./map.js";
import { type GeoJSONSource } from "maplibre-gl";

/** The slider positions matching the weighting the pipeline actually ranked with.
 *
 * Read from the data rather than repeated here. These used to be four literals
 * with a comment saying they were the pipeline's weighting — which was true only
 * as long as nobody changed PRIORITY_WEIGHTS, and if anyone had, this list and
 * the /build workspace would have disagreed with the exported score, and with
 * each other, about which project a city should do first.
 */
export function publishedWeightPositions(): Record<WeightKey, string> | null {
  const w = build.priorityMeta?.model?.weights;
  if (w === undefined) return null;
  const vals = WEIGHT_KEYS.map((k) => w[k]);
  if (!vals.every((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    return null;
  }
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const out = {} as Record<WeightKey, string>;
  WEIGHT_KEYS.forEach((k, i) => {
    out[k] = String(Math.round(((vals[i] as number) / total) * 100));
  });
  return out;
}

export function weightValues(): Record<WeightKey, number> {
  const raw = {} as Record<WeightKey, number>;
  let total = 0;
  for (const key of WEIGHT_KEYS) {
    const v = Number(el<HTMLInputElement>(`wt-${key}`).value);
    raw[key] = v;
    total += v;
  }
  if (total <= 0) return { severance: 1, access: 0, crash: 0, coverage: 0 };
  for (const key of WEIGHT_KEYS) raw[key] /= total;
  return raw;
}

/** Every project's score under the current weights, for painting the map. */
export function scoreAllProjects(): Map<string, number> {
  const w = weightValues();
  return new Map(
    build.projects.map((p) => [
      p.pid,
      Math.round(
        (w.severance * p.c_severance +
          w.access * p.c_access +
          w.crash * p.c_crash +
          w.coverage * p.c_coverage) *
          1000,
      ) / 1000,
    ]),
  );
}

/** Re-score with the panel's weights. The components are what the pipeline
 * measured; only their relative importance is the reader's to choose. */
export function rankedProjects(): ProjectProps[] {
  const w = weightValues();
  const town = el<HTMLSelectElement>("build-town").value;
  const seenGroups = new Set<string>();
  return build.projects
    .filter(
      (p) =>
        town === "" ||
        // exact, per name: a substring match put Lynnfield under Lynn, North
        // Reading under Reading, and North Andover under Andover
        p.towns
          .split(",")
          .map((t) => t.trim())
          .includes(town),
    )
    .map((p) => ({
      p,
      score:
        w.severance * p.c_severance +
        w.access * p.c_access +
        w.crash * p.c_crash +
        w.coverage * p.c_coverage,
    }))
    .sort((a, b) => b.score - a.score)
    .filter(({ p }) => {
      // one row per gap: alternatives across the same barrier are listed on the
      // row they belong to, not as separate near-identical entries
      if (seenGroups.has(p.group)) return false;
      seenGroups.add(p.group);
      return true;
    })
    .map(({ p, score }) => ({ ...p, score: Math.round(score * 1000) / 1000 }));
}

/** Repaint the map with the reader's weighting.
 *
 * The layer's colour and width are driven by the score property, so moving the
 * sliders re-sorted the list while the map kept painting our own weighting —
 * the two openly contradicted each other about which project was the big one.
 */
export function repaintProjects(scored: Map<string, number>): void {
  if (!build.projectFC || map.getSource("build") === undefined) return;
  for (const f of build.projectFC.features) {
    const pid = (f.properties as { pid?: string } | null)?.pid;
    if (pid === undefined || f.properties === null) continue;
    const score = scored.get(pid);
    if (score !== undefined) f.properties["score"] = score;
  }
  (map.getSource("build") as GeoJSONSource).setData(build.projectFC);
}
