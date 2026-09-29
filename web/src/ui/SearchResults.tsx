// The search results: places a rider might go, each with the grade of the
// safest way there. Drawn from the search's state (app.ts searchView): the
// rows, which one the arrow keys are on, and each row's grade as it arrives.
// It was built element by element, and the grading and the arrow keys then
// reached back into those elements, so a list rebuilt under them (the
// geocoder answering, the next keystroke) left them writing to rows that
// were gone. The markup, classes and roles are the ones the page, its styles
// and its tests have always had.
import type { SafetyGrade } from "../types.js";
import { fmtDist } from "../units.js";

export interface SearchRowView {
  /** Identity, so a selection and a grade survive the list being redrawn. */
  key: string;
  name: string;
  /** The full name and its context, for the tooltip. */
  title: string;
  /** What the place is and how far, until a grade replaces it. */
  where: string;
  lngLat: [number, number];
}

export type GradeView =
  /** being worked out, or about to be */
  | { state: "pending" }
  /** never going to be: no start to route from, unroutable, or not a
   * destination list. Hidden rather than removed: grading resolves while the
   * list is being tapped, and removing things re-flowed the rows under the
   * finger reaching for one. */
  | { state: "hidden" }
  | { state: "graded"; grade: SafetyGrade; meters: number; minutes: number };

export interface SearchResultsProps {
  rows: SearchRowView[];
  /** Which field the list fills. A grade on the start-picker list would be the
   * route from the current start to a candidate start, a journey nobody takes. */
  target: "start" | "end";
  active: string | null;
  grades: ReadonlyMap<string, GradeView>;
  /** Said instead of a list: "no results in this area", "search unavailable". */
  message: string | null;
  gradeColors: Record<string, string>;
  gradeText: Record<string, string>;
  onChoose(row: SearchRowView): void;
  onSave(row: SearchRowView): void;
}

export function SearchResults(p: SearchResultsProps) {
  if (p.rows.length === 0) return p.message === null ? null : <>{p.message}</>;
  return (
    <>
      {p.rows.map((row) => (
        <Row
          key={row.key}
          row={row}
          active={row.key === p.active}
          grade={p.grades.get(row.key) ?? { state: "hidden" }}
          target={p.target}
          gradeColors={p.gradeColors}
          gradeText={p.gradeText}
          onChoose={() => p.onChoose(row)}
          onSave={() => p.onSave(row)}
        />
      ))}
    </>
  );
}

interface RowProps {
  row: SearchRowView;
  active: boolean;
  grade: GradeView;
  target: "start" | "end";
  gradeColors: Record<string, string>;
  gradeText: Record<string, string>;
  onChoose(): void;
  onSave(): void;
}

function Row({ row, active, grade, target, gradeColors, gradeText, onChoose, onSave }: RowProps) {
  const graded = grade.state === "graded" ? grade : null;
  const sub =
    graded !== null
      ? `${fmtDist(graded.meters)} · ${graded.minutes} min by the safest way`
      : grade.state === "pending"
        ? row.where === ""
          ? "checking the safest way…"
          : row.where
        : row.where;
  // A row that can't be graded still says what the place is and how far; only
  // with nothing to say is the line hidden. The letter is withdrawn from
  // assistive technology too, not just from view.
  const subHidden = grade.state === "hidden" && row.where === "";
  return (
    <div class={"search-row" + (active ? " active" : "")} data-key={row.key}>
      {/* the whole row picks the field searched from: no aiming at a tiny
          button, which matters on a phone */}
      <span class="search-text" style={{ cursor: "pointer" }} onClick={onChoose}>
        <span title={row.title}>{row.name}</span>
        <small
          class="search-sub"
          data-where={row.where}
          style={subHidden ? { visibility: "hidden" } : undefined}
        >
          {sub}
        </small>
      </span>
      <span
        class="search-grade"
        style={
          graded !== null
            ? { background: gradeColors[graded.grade] ?? "", color: gradeText[graded.grade] ?? "" }
            : grade.state === "hidden"
              ? { visibility: "hidden" }
              : undefined
        }
        title={graded !== null ? `Safest route here grades ${graded.grade}` : undefined}
        aria-label={graded !== null ? `safest route grades ${graded.grade}` : undefined}
      >
        {graded !== null ? graded.grade : "·"}
      </span>
      <button onClick={onChoose}>{target === "start" ? "start" : "go"}</button>
      <button title="save as a place (Home, Work, …)" onClick={onSave}>
        ☆
      </button>
    </div>
  );
}
