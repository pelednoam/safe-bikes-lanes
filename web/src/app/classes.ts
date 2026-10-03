import type { ExpressionSpecification } from "maplibre-gl";

import type { ProtectionClass } from "../types.js";
import { CLASS_COLORS } from "../weights.gen.js";

// ---------------------------------------------------------------------------
// Safety classes told apart by more than hue
//
// The palette runs green to red, which is the axis colour-blind riders lose:
// simulated for deuteranopia a quiet street and a painted lane differ by a ΔE
// of 1.3 (the same colour), and a buffered lane and a sharrow by 6.2; for
// protanopia an off-street path and a moderate street by 4.1. The hues stay
// (the owner's call); each class also gets a width and a mark, the same on the
// map, on the route, in the legend and in the ride's class bar:
//
//   protected (path, separated, buffered)  plain, and the widest lines
//   quiet street / alley                   plain and thin
//   unpaved path                           short dark dashes: a path, but rough
//   painted lane                           a dark dash down the middle
//   sharrow                                a row of dark dots
//   moderate street                        dark ticks across it, spaced
//   busy street                            dark ticks across it, close — hatched
//
// Ticks for the two classes a child should not be on make "warning" something
// you can see without red. Plain means safe; marked means read the mark.
// ---------------------------------------------------------------------------

/** Line width relative to an ordinary street. */
const CLASS_WIDTH: Record<ProtectionClass, number> = {
  path: 1.7,
  separated: 1.5,
  buffered: 1.3,
  quiet_street: 0.9,
  service: 0.9,
  // off-street like a path, but slow on small wheels: between the two in weight
  unpaved: 1.3,
  lane: 1.3,
  sharrow: 1.3,
  moderate_street: 1.1,
  busy_street: 1.25,
};

interface ClassMark {
  id: string;
  cls: ProtectionClass;
  /** Mark width, as a multiple of the line it sits on. */
  scale: number;
  /** MapLibre dash pattern, in multiples of the mark's own width. */
  dash: [number, number];
  /** Round caps turn zero-length dashes into dots. */
  round: boolean;
}

export const CLASS_MARKS: ClassMark[] = [
  // Short and stubby where a lane's are long, so the two never read alike; the
  // class arrived with the pipeline's surface fix after this table was drawn.
  { id: "unpaved", cls: "unpaved", scale: 0.45, dash: [0.9, 1.8], round: false },
  { id: "lane", cls: "lane", scale: 0.3, dash: [3.2, 2.2], round: false },
  { id: "sharrow", cls: "sharrow", scale: 0.5, dash: [0, 2.4], round: true },
  { id: "moderate", cls: "moderate_street", scale: 2.1, dash: [0.28, 3.2], round: false },
  { id: "busy", cls: "busy_street", scale: 2.1, dash: [0.28, 1.15], round: false },
];
export const MARK_INK = "rgba(17,22,25,0.82)";
/** Ticks stand out past their line, so over the dark basemap they are drawn
 * light — dark ones there read as gaps, which is to say as dashes. */
export const TICK_INK_DARK = "rgba(236,240,244,0.85)";
export const isTick = (m: ClassMark): boolean => m.scale > 1;

/** A line width that grows with zoom from `lo` to `hi` and is scaled per class. */
export function classWidth(lo: number, hi: number, scale = 1): ExpressionSpecification {
  const byClass = (base: number): unknown => [
    "*",
    base * scale,
    [
      "match",
      ["get", "cls"],
      ...Object.entries(CLASS_WIDTH).flatMap(([cls, k]) => [cls, k]),
      1,
    ],
  ];
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    12,
    byClass(lo),
    16,
    byClass(hi),
  ] as ExpressionSpecification;
}

/** Every layer that draws a class mark over the network. */
export const NETWORK_MARK_LAYERS = CLASS_MARKS.map((m) => `network-mark-${m.id}`);

/** A small picture of a class's line — colour, width and mark — for the legend,
 * the about table and the ride's class key, so all three match the map. */
export function classSwatch(cls: ProtectionClass, w = 36, h = 14): string {
  const y = h / 2;
  const sw = 2.6 * CLASS_WIDTH[cls];
  const mark = CLASS_MARKS.find((m) => m.cls === cls);
  let over = "";
  if (mark !== undefined) {
    const mw = sw * mark.scale;
    const dash = `${(mark.dash[0] * mw).toFixed(2)} ${(mark.dash[1] * mw).toFixed(2)}`;
    // ticks take their ink from the theme (--tick-ink), as they do on the map
    const ink = isTick(mark) ? `style="stroke:var(--tick-ink)"` : `stroke="${MARK_INK}"`;
    over =
      `<line x1="2" y1="${y}" x2="${w - 2}" y2="${y}" ${ink} ` +
      `stroke-width="${mw.toFixed(2)}" stroke-dasharray="${dash}"` +
      `${mark.round ? ' stroke-linecap="round"' : ""}/>`;
  }
  return (
    `<svg class="swatch" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<line x1="2" y1="${y}" x2="${w - 2}" y2="${y}" stroke="${CLASS_COLORS[cls]}" ` +
    `stroke-width="${sw.toFixed(2)}" stroke-linecap="round"/>${over}</svg>`
  );
}

/** The construction marker: a black-and-white barricade. Nothing else on the
 * map is black and white, so it cannot be read as a safety colour (it was
 * orange, between the palette's amber and red) or as a place to visit (it was a
 * dot, like the kid stops), and ~170 of them no longer look like a route. */
export function constructionIcon(): { width: number; height: number; data: Uint8Array } | null {
  const W = 34;
  const H = 22;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (ctx === null) return null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(2, 3, W - 4, H - 6);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = "#111619";
  for (let x = -H; x < W + H; x += 9) {
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x + 4.5, H);
    ctx.lineTo(x + 4.5 + H, 0);
    ctx.lineTo(x + H, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#111619";
  ctx.strokeRect(2, 3, W - 4, H - 6);
  const img = ctx.getImageData(0, 0, W, H);
  return { width: W, height: H, data: new Uint8Array(img.data.buffer) };
}

/** The marks as SVG patterns, for the ride ribbon's 12 px class strip. */
export const RIBBON_PATTERNS =
  `<defs>` +
  `<pattern id="rp-unpaved" width="4" height="12" patternUnits="userSpaceOnUse">` +
  `<rect x="0" y="5" width="1.8" height="2" fill="${MARK_INK}"/></pattern>` +
  `<pattern id="rp-lane" width="9" height="12" patternUnits="userSpaceOnUse">` +
  `<rect x="0" y="5.2" width="5" height="1.6" fill="${MARK_INK}"/></pattern>` +
  `<pattern id="rp-sharrow" width="6" height="12" patternUnits="userSpaceOnUse">` +
  `<circle cx="3" cy="6" r="1.4" fill="${MARK_INK}"/></pattern>` +
  `<pattern id="rp-moderate_street" width="8" height="12" patternUnits="userSpaceOnUse">` +
  `<rect width="1.5" height="12" fill="${MARK_INK}"/></pattern>` +
  `<pattern id="rp-busy_street" width="4" height="12" patternUnits="userSpaceOnUse">` +
  `<rect width="1.5" height="12" fill="${MARK_INK}"/></pattern>` +
  `</defs>`;

/** The legend's picture of construction, to match the map. */
export const CONSTRUCTION_SWATCH =
  `<svg class="swatch" width="36" height="14" viewBox="0 0 36 14" aria-hidden="true">` +
  `<defs><pattern id="constr-stripes" width="6" height="12" patternUnits="userSpaceOnUse" ` +
  `patternTransform="rotate(45)"><rect width="3" height="12" fill="#111619"/></pattern></defs>` +
  `<rect x="9" y="2" width="18" height="10" fill="#fff" stroke="#111619" stroke-width="1.5"/>` +
  `<rect x="9" y="2" width="18" height="10" fill="url(#constr-stripes)"/></svg>`;

export const POI_META: Record<string, { emoji: string; label: string; color: string }> = {
  playground: { emoji: "🛝", label: "playground", color: "#e67e22" },
  ice_cream: { emoji: "🍦", label: "ice cream", color: "#e84393" },
  library: { emoji: "📚", label: "library", color: "#8e44ad" },
  water: { emoji: "🚰", label: "water fountain", color: "#2980b9" },
  restroom: { emoji: "🚻", label: "restroom", color: "#7f8c8d" },
};
