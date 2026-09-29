// The chosen route's summary: how it divides into kinds of street, what on it
// to watch for, and why it was chosen. Drawn from the route (showSummary in
// app.ts), with the markup and classes the page and its tests have always had.
import type { Caution, ProtectionClass } from "../types.js";
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
          <span>
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
      {cautions.map((c) => (
        <div class="caution">
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
      {reasons.map((r) => (
        <li>{r}</li>
      ))}
    </>
  );
}
