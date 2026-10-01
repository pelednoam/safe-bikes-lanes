// The chosen route's summary: how it divides into kinds of street, the ribbon
// along it, what on it to watch for, and why it was chosen. Drawn from the route (showSummary in
// app.ts), with the markup and classes the page and its tests have always had.
import type { Caution, ProtectionClass, RibbonSeg } from "../types.js";
import { fmtDist } from "../units.js";

export interface ClassPart {
  cls: ProtectionClass;
  meters: number;
}

export interface ClassBreakdownProps {
  parts: ClassPart[];
  colors: Record<string, string>;
  labels: Record<string, string>;
}

/** The bar: one segment per kind of street, in proportion. */
export function ClassBar({ parts, colors, labels }: ClassBreakdownProps) {
  return (
    <>
      {parts.map(({ cls, meters }) => (
        <i
          // one segment per kind, so the kind is its identity
          key={cls}
          // the class's mark as a pattern, so the bar reads without its colours
          class={`pat-${cls}`}
          style={{ flex: meters, backgroundColor: colors[cls] ?? "#999" }}
          title={`${labels[cls] ?? cls}: ${fmtDist(meters)}`}
        />
      ))}
    </>
  );
}

/** The key under it, in words: a title attribute is nothing on a phone or to
 * a keyboard. Kinds under 1% are in the bar but not named. */
export function ClassKey({
  parts,
  labels,
  swatch,
}: ClassBreakdownProps & { swatch: (cls: ProtectionClass) => string }) {
  const total = parts.reduce((a, p) => a + p.meters, 0);
  return (
    <>
      {parts.map(({ cls, meters }) => {
        const pct = total > 0 ? Math.round((100 * meters) / total) : 0;
        if (pct < 1) return null;
        return (
          <span key={cls}>
            {/* the swatch is this app's own SVG, drawn from its class table */}
            <span dangerouslySetInnerHTML={{ __html: swatch(cls) }} />{" "}
            {`${labels[cls] ?? cls} ${pct}%`}
          </span>
        );
      })}
    </>
  );
}

export interface CautionsProps {
  cautions: Caution[];
  labels: Record<string, string>;
  /** Whether street-level photos can be looked up (a Mapillary token). */
  photos: boolean;
  onPhoto(lon: number, lat: number): void;
}

/** The stretches to watch for, each with a way to see it first. */
export function Cautions({ cautions, labels, photos, onPhoto }: CautionsProps) {
  if (cautions.length === 0) return <div class="all-clear">✓ no stressful segments</div>;
  return (
    <>
      {cautions.map((c, i) => (
        <div class="caution" key={`${i}|${c.name}|${c.cls}`}>
          {`⚠ ${c.name}: ${fmtDist(c.meters)} of ${labels[c.cls] ?? c.cls} `}
          {c.lon !== undefined && c.lat !== undefined && (
            <>
              <a
                href={`https://maps.google.com/maps?q=&layer=c&cbll=${c.lat},${c.lon}`}
                target="_blank"
                rel="noopener"
              >
                street view
              </a>
              {photos && (
                <>
                  {" · "}
                  <a
                    href="#"
                    title="recent street-level photo (Mapillary)"
                    onClick={(ev) => {
                      ev.preventDefault();
                      onPhoto(c.lon as number, c.lat as number);
                    }}
                  >
                    📷 photo
                  </a>
                </>
              )}
            </>
          )}
        </div>
      ))}
    </>
  );
}

/** Why this route: the router's own reasons, one per line. */
export function WhyList({ reasons }: { reasons: string[] }) {
  return (
    <>
      {reasons.map((r, i) => (
        <li key={`${i}|${r}`}>{r}</li>
      ))}
    </>
  );
}

export interface RibbonProps {
  segs: RibbonSeg[];
  colors: Record<string, string>;
  labels: Record<string, string>;
  /** The kinds that carry a mark on the map, drawn over their colour here too. */
  marked: ReadonlySet<string>;
  /** The marks as SVG patterns (a <defs>, this app's own markup), ids rp-<kind>. */
  patterns: string;
  climb(meters: number): string;
}

/** The ribbon's width, in px: the route from start to end, left to right. */
export const RIBBON_W = 280;
const WALK_FILL = "#8aa4b8";

/** The route as a strip: the kind of street along it, the busy crossings, and
 * the climb, with the highest and lowest points named. */
export function Ribbon({ segs, colors, labels, marked, patterns, climb }: RibbonProps) {
  const total = segs.reduce((a, r) => a + r.m, 0);
  if (segs.length === 0 || total <= 0) return null;
  const elevs = segs.flatMap((r) => [r.e0, r.e1]);
  const eMin = Math.min(...elevs);
  const eMax = Math.max(...elevs, eMin + 5);
  const ey = (v: number): string => (62 - ((v - eMin) / (eMax - eMin)) * 24).toFixed(1);
  const strip = [];
  const crossings = [];
  const line: string[] = [];
  let x = 0;
  for (const [i, seg] of segs.entries()) {
    const wpx = (seg.m / total) * RIBBON_W;
    const at = x.toFixed(2);
    const width = Math.max(wpx, 0.4).toFixed(2);
    const walk = seg.walk === true;
    strip.push(
      <rect key={`c${i}`} x={at} y="0" width={width} height="12" fill={walk ? WALK_FILL : colors[seg.cls]}>
        <title>{`${walk ? "walk the bike" : labels[seg.cls]}: ${fmtDist(seg.m)}`}</title>
      </rect>,
    );
    // the kind's map mark over its colour
    if (!walk && marked.has(seg.cls)) {
      strip.push(
        <rect
          key={`m${i}`}
          x={at}
          y="0"
          width={width}
          height="12"
          fill={`url(#rp-${seg.cls})`}
          pointer-events="none"
        />,
      );
    }
    if (seg.crossing) {
      crossings.push(
        <text key={`x${i}`} x={at} y="23" font-size="11" fill="#a33">
          ▲<title>busy crossing</title>
        </text>,
      );
    }
    line.push(`${at},${ey(seg.e0)}`);
    x += wpx;
    line.push(`${x.toFixed(2)},${ey(seg.e1)}`);
  }
  return (
    <svg width={RIBBON_W} height="70" xmlns="http://www.w3.org/2000/svg">
      <g dangerouslySetInnerHTML={{ __html: patterns }} />
      {strip}
      {crossings}
      <polyline points={line.join(" ")} fill="none" stroke="#666" stroke-width="1.4" />
      <text x="0" y="41" font-size="11" fill="currentColor" opacity=".7">
        {climb(eMax)}
      </text>
      <text x="0" y="69" font-size="11" fill="currentColor" opacity=".7">
        {climb(eMin)}
      </text>
    </svg>
  );
}
