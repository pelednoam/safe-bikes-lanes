// "Where to build" in the planner: the ranked projects that would close the
// worst gaps in the safe network, drawn from the ranking as it stands (the
// reader's weights, the town filter) and from where the data is (loading,
// failed, there). The rows are keyed by project, so choosing one from the
// keyboard leaves the keyboard on it when the list is drawn again; it was
// rebuilt from nothing each time, and the focus went with the old row.
import { fmtDist } from "../units.js";

/** The fields of a ranked project the list shows. */
export interface BuildProject {
  pid: string;
  name: string;
  kind: string;
  towns: string;
  length_m: number;
  /** The pipeline's sentence: "N m of Street (Town); why; why". */
  summary: string;
  /** How many alternative ways across the same gap, this one included. */
  group_size: number;
}

export type BuildListStatus = "idle" | "loading" | "failed" | "ready";

export interface BuildListProps {
  status: BuildListStatus;
  /** Ranked best first. */
  ranked: BuildProject[];
  selected: string | null;
  /** Every project measured, for the "the CSV has all N" line. */
  measured: number | null;
  onPick(pid: string): void;
  /** A row hovered or focused (its pid), or left (null). */
  onPreview(pid: string | null): void;
}

/** Rows shown: the rest are in the CSV, which the list says. */
export const BUILD_ROWS = 20;

/** The heading's line: a length of street to protect, or one spot to fix. A
 * spot fix is one location; heading it "39 m of X" would bring back the
 * corridor framing the pipeline deliberately avoids. */
export function buildHeading(p: BuildProject): string {
  return `${fmtDist(p.length_m)} of ${p.name}${p.towns ? ` — ${p.towns}` : ""}`;
}

/** Why, in the pipeline's words, minus the opener the heading carries. */
export function buildWhy(p: BuildProject): string {
  const why = p.summary.split("; ").slice(1).join("; ");
  return p.kind === "spot_fix" ? `one location to treat — ${why}` : why;
}

export function BuildList(props: BuildListProps) {
  const { status, ranked, selected, measured, onPick, onPreview } = props;
  if (status === "loading") return <>loading projects…</>;
  if (status === "failed") {
    return <>couldn't load the projects — check your connection and reopen this section</>;
  }
  if (status === "idle") return null;
  if (ranked.length === 0) return <>no candidate projects here</>;
  return (
    <>
      {ranked.slice(0, BUILD_ROWS).map((p, i) => {
        const chosen = p.pid === selected;
        return (
          <div
            key={p.pid}
            class={"build-row" + (chosen ? " selected" : "")}
            tabIndex={0}
            role="button"
            aria-pressed={chosen ? "true" : "false"}
            data-pid={p.pid}
            onMouseEnter={() => onPreview(p.pid)}
            onMouseLeave={() => onPreview(null)}
            onFocus={() => onPreview(p.pid)}
            onBlur={() => onPreview(null)}
            onClick={() => onPick(p.pid)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick(p.pid);
              }
            }}
          >
            <div class="build-where">
              <span class="build-rank">{`${i + 1}.`}</span>
              {p.kind === "spot_fix" ? <span class="build-badge">spot fix</span> : null}
              {buildHeading(p)}
            </div>
            <div class="build-why">{buildWhy(p)}</div>
            {p.group_size > 1 ? (
              <div class="build-alt">
                {`${p.group_size - 1} other way${p.group_size > 2 ? "s" : ""} across the same gap`}
              </div>
            ) : null}
          </div>
        );
      })}
      {ranked.length > BUILD_ROWS ? (
        // never imply the list is the whole field
        <div class="hint">
          {`showing the top ${BUILD_ROWS} of ${ranked.length} mapped project` +
            `${ranked.length === 1 ? "" : "s"}; the CSV has all ${measured ?? ranked.length} that were measured`}
        </div>
      ) : null}
    </>
  );
}
