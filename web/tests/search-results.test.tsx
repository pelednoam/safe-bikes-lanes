// The search list, rendered: rows, the one the arrow keys are on, and each
// row's grade as it stands.
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";

import { type GradeView, SearchResults, type SearchResultsProps, type SearchRowView } from "../src/ui/SearchResults.js";

const row = (name: string, where = ""): SearchRowView => ({
  key: `${name}|-71.10000,42.38000`,
  name,
  title: `${name} — Somerville`,
  where,
  lngLat: [-71.1, 42.38],
});

const render = (over: Partial<SearchResultsProps>, grade?: GradeView): string => {
  const rows = over.rows ?? [row("Danehy Park", "park · 1.2 mi")];
  const grades = new Map(rows.map((r) => [r.key, grade ?? { state: "pending" as const }]));
  return renderToString(
    <SearchResults
      rows={rows}
      target="end"
      active={null}
      grades={grades}
      message={null}
      gradeColors={{ A: "#1a9850" }}
      gradeText={{ A: "#fff" }}
      onChoose={() => undefined}
      onSave={() => undefined}
      {...over}
    />,
  );
};

describe("the search list", () => {
  it("says so, rather than showing nothing, when there are no results", () => {
    expect(render({ rows: [], message: "no results in this area" })).toBe("no results in this area");
    expect(render({ rows: [], message: null })).toBe("");
  });

  it("keys each row, and marks the one the arrow keys are on", () => {
    const r = row("Danehy Park");
    const html = render({ rows: [r, row("Davis Square")], active: r.key });
    expect(html).toContain(`<div class="search-row active" data-key="${r.key}">`);
    expect(html.match(/class="search-row"/g)).toHaveLength(1); // the other, not active
  });

  it("says what the place is and how far while it is being graded", () => {
    const html = render({}, { state: "pending" });
    expect(html).toContain("park · 1.2 mi");
    expect(html).toContain('<span class="search-grade">·</span>');
  });

  it("says it is checking when there is nothing else to say yet", () => {
    expect(render({ rows: [row("Somewhere")] }, { state: "pending" })).toContain("checking the safest way…");
  });

  it("shows the grade, in its colour, named for a screen reader, with the way's length", () => {
    const html = render({}, { state: "graded", grade: "A", meters: 1609, minutes: 9 });
    expect(html).toMatch(/<span class="search-grade" style="background:#1a9850;color:#fff;?" title="Safest route here grades A" aria-label="safest route grades A">A<\/span>/);
    expect(html).toContain("9 min by the safest way");
  });

  it("hides a grade that won't come, but keeps what the place is", () => {
    const html = render({}, { state: "hidden" });
    expect(html).toMatch(/<span class="search-grade" style="visibility:hidden;?">·<\/span>/);
    expect(html).toContain("park · 1.2 mi");
    expect(html).not.toContain("aria-label");
  });

  it("hides the line under the name only when there is nothing to put on it", () => {
    const html = render({ rows: [row("Somewhere")] }, { state: "hidden" });
    expect(html).toMatch(/<small class="search-sub" data-where(="")? style="visibility:hidden;?">/);
  });

  it("offers 'start' on the start-picker list, and 'go' on the destination's", () => {
    expect(render({ target: "start" })).toContain("<button>start</button>");
    expect(render({ target: "end" })).toContain("<button>go</button>");
  });

  it("writes names as text: a place name from the geocoder can't become markup", () => {
    const html = render({ rows: [row('<img src=x onerror="alert(1)">')] });
    expect(html).not.toContain("<img");
  });
});
