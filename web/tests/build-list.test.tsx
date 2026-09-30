// "Where to build" in the planner, rendered: every state of the data, and the
// rows as they have always read.
import type { VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";

import {
  BUILD_ROWS,
  BuildList,
  type BuildListProps,
  type BuildProject,
  buildWhy,
} from "../src/ui/BuildList.js";

const project = (over: Partial<BuildProject> = {}): BuildProject => ({
  pid: "p1",
  name: "Elm Street",
  kind: "corridor",
  towns: "Somerville",
  length_m: 420,
  summary: "420 m of Elm Street (Somerville); joins two protected paths; 12 crashes since 2021",
  group_size: 1,
  ...over,
});

const noop = (): void => {};
const props = (over: Partial<BuildListProps> = {}): BuildListProps => ({
  status: "ready",
  ranked: [project()],
  selected: null,
  measured: 900,
  onPick: noop,
  onPreview: noop,
  ...over,
});

describe("where the data is", () => {
  it("says it is loading, or that it failed and what to do", () => {
    expect(renderToString(<BuildList {...props({ status: "loading" })} />)).toBe("loading projects…");
    expect(renderToString(<BuildList {...props({ status: "failed" })} />)).toBe(
      "couldn't load the projects — check your connection and reopen this section",
    );
  });

  it("is nothing before the section is opened", () => {
    expect(renderToString(<BuildList {...props({ status: "idle" })} />)).toBe("");
  });

  it("says so when the filter leaves nothing", () => {
    expect(renderToString(<BuildList {...props({ ranked: [] })} />)).toBe("no candidate projects here");
  });
});

describe("the rows", () => {
  it("are numbered, headed by what to build and where, with the reasons after", () => {
    const html = renderToString(<BuildList {...props()} />);
    expect(html).toContain('class="build-row"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-pid="p1"');
    expect(html).toMatch(/<div class="build-where"><span class="build-rank">1\.<\/span>\S+ \w+ of Elm Street — Somerville<\/div>/);
    expect(html).toContain('<div class="build-why">joins two protected paths; 12 crashes since 2021</div>');
  });

  it("mark the chosen project", () => {
    const html = renderToString(<BuildList {...props({ selected: "p1" })} />);
    expect(html).toContain('class="build-row selected"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("call a spot fix one location, not a length of street", () => {
    const spot = project({ kind: "spot_fix", summary: "39 m of Elm Street; a dangerous crossing" });
    const html = renderToString(<BuildList {...props({ ranked: [spot] })} />);
    expect(html).toContain('<span class="build-badge">spot fix</span>');
    expect(buildWhy(spot)).toBe("one location to treat — a dangerous crossing");
  });

  it("say how many other ways cross the same gap", () => {
    const two = renderToString(<BuildList {...props({ ranked: [project({ group_size: 2 })] })} />);
    expect(two).toContain('<div class="build-alt">1 other way across the same gap</div>');
    const three = renderToString(<BuildList {...props({ ranked: [project({ group_size: 3 })] })} />);
    expect(three).toContain("2 other ways across the same gap");
  });

  it("stop at the top few, and never imply that is the whole field", () => {
    const many = Array.from({ length: 30 }, (_, i) => project({ pid: `p${i}` }));
    const html = renderToString(<BuildList {...props({ ranked: many })} />);
    expect(html.match(/class="build-row"/g)).toHaveLength(BUILD_ROWS);
    expect(html).toContain(`showing the top ${BUILD_ROWS} of 30 mapped projects; the CSV has all 900 that were measured`);
  });
});

/** Every element in a component's output (no DOM here, so events are the
 * handlers each element was given). */
function elements(node: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const vnode = node as VNode<Record<string, unknown>>;
  return [vnode, ...elements(vnode.props["children"])];
}

describe("a row", () => {
  it("is picked by a click, Enter or Space, and previews its project while hovered or focused", () => {
    const onPick = vi.fn();
    const onPreview = vi.fn();
    const tree = BuildList(props({ onPick, onPreview }));
    const row = elements(tree).find((v) => v.props["data-pid"] === "p1");
    if (row === undefined) throw new Error("no row");
    const call = (name: string, e?: unknown): void => (row.props[name] as (e?: unknown) => void)(e);
    call("onClick");
    const pressed = { key: "Enter", preventDefault: vi.fn() };
    call("onKeyDown", pressed);
    call("onKeyDown", { key: " ", preventDefault: vi.fn() });
    call("onKeyDown", { key: "a", preventDefault: vi.fn() });
    expect(onPick).toHaveBeenCalledTimes(3);
    expect(pressed.preventDefault).toHaveBeenCalled();
    call("onMouseEnter");
    call("onMouseLeave");
    call("onFocus");
    call("onBlur");
    expect(onPreview.mock.calls).toEqual([["p1"], [null], ["p1"], [null]]);
  });
});
