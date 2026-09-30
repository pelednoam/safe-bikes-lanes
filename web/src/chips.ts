// The option badges on the map: one per alternative route, grade and time,
// Google-style but led by the safety grade rather than the ETA. What each badge
// says and where it sits, worked out from the trip. app.ts keeps one MapLibre
// marker per option and updates it from this, rather than throwing the badges
// away and building new ones on every repaint, which lost the keyboard's place
// on them.
import type { RouteOption } from "./types.js";

export interface ChipView {
  id: RouteOption["id"];
  /** Where on its own line the badge sits. */
  at: [number, number];
  text: string;
  title: string;
  ariaLabel: string;
  selected: boolean;
  color: string;
  ink: string;
}

/** Badges for a choice of routes; none for one route, which is no choice. Each
 * sits a different way along its line (35%, 55%, 75%…), so where lines share
 * a stretch their badges don't land on top of each other. */
export function chipViews(
  options: readonly RouteOption[],
  selectedId: RouteOption["id"] | null,
  colors: Record<string, string>,
  ink: Record<string, string>,
): ChipView[] {
  if (options.length < 2) return [];
  const views: ChipView[] = [];
  options.forEach((o, i) => {
    const coords = o.payload.geojson.features.flatMap((f) => f.geometry.coordinates);
    const frac = Math.min(0.9, 0.35 + i * 0.2);
    const pt = coords[Math.floor(coords.length * frac)] ?? coords[coords.length - 1];
    if (pt === undefined) return;
    const minutes = o.payload.summary.minutes;
    views.push({
      id: o.id,
      at: [pt[0] ?? 0, pt[1] ?? 0],
      text: `${o.grade} · ${minutes} min`,
      title: `${o.label}: ${o.gradeReason}`,
      ariaLabel: `${o.label}: grade ${o.grade}, ${minutes} minutes`,
      selected: o.id === selectedId,
      color: colors[o.grade] ?? "",
      ink: ink[o.grade] ?? "",
    });
  });
  return views;
}

/** Write a badge's view onto its element. Classes are toggled, not assigned:
 * MapLibre keeps its own on the marker's element. */
export function paintChip(el: HTMLElement, v: ChipView): void {
  el.classList.add("opt-chip");
  el.classList.toggle("sel", v.selected);
  el.style.setProperty("--g", v.color);
  el.style.setProperty("--gt", v.ink);
  if (el.textContent !== v.text) el.textContent = v.text;
  el.title = v.title;
  el.setAttribute("aria-label", v.ariaLabel);
  el.setAttribute("aria-pressed", String(v.selected));
}
