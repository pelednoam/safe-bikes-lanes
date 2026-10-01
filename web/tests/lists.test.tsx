// The marked spots and the rides, rendered.
import type { VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";

import type { RideSummary } from "../src/rides.js";
import { RideList, RideTotalsLine, SketchyList } from "../src/ui/Lists.js";

const noop = (): void => {};

/** Every element in a component's output, depth first (no DOM in these tests,
 * so a button is pressed by calling the handler it was given). */
function elements(node: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const vnode = node as VNode<Record<string, unknown>>;
  return [vnode, ...elements(vnode.props["children"])];
}

function handlers(tree: unknown, event: string): ((e?: unknown) => void)[] {
  return elements(tree)
    .map((v) => v.props[event])
    .filter((f): f is (e?: unknown) => void => typeof f === "function");
}

const ride = (over: Partial<RideSummary> = {}): RideSummary => ({
  id: "r1",
  startedAt: "2026-09-12T15:04:00Z",
  meters: 5200,
  durationS: 1500,
  movingS: 1200,
  byClass: {},
  pctProtected: 71,
  pctQuiet: 20,
  profile: "young_kids",
  polyline: [],
  ...over,
});

describe("the marked spots", () => {
  const marks: [number, number][] = [
    [-71.1, 42.38],
    [-71.2, 42.4],
  ];

  it("numbers each spot as the rider sees them, with a way to remove it", () => {
    const html = renderToString(<SketchyList marks={marks} onFly={noop} onRemove={noop} />);
    expect(html.match(/class="sketchy-row"/g)).toHaveLength(2);
    expect(html).toContain('<span style="cursor:pointer;" title="fly to">⚠ marked spot 1</span>');
    expect(html).toContain("⚠ marked spot 2");
    expect(html).toContain('<button title="remove">✕</button>');
  });

  it("flies to the spot, and removes it by its place in the list", () => {
    const onFly = vi.fn();
    const onRemove = vi.fn();
    const [fly0, remove0, fly1, remove1] = handlers(SketchyList({ marks, onFly, onRemove }), "onClick");
    fly1?.();
    remove0?.();
    fly0?.();
    remove1?.();
    expect(onFly.mock.calls).toEqual([[marks[1]], [marks[0]]]);
    expect(onRemove.mock.calls).toEqual([[0], [1]]);
  });
});

describe("the ride totals", () => {
  it("say how to start when there are none", () => {
    expect(renderToString(<RideTotalsLine totals={null} />)).toBe(
      "No rides yet — rides are saved automatically when you Navigate, or use ● Record.",
    );
  });

  it("read as they always did", () => {
    const totals = { count: 3, km: 12.5, movingHours: 1.2, longestKm: 6, thisMonthKm: 4, avgProtectedPct: 64 };
    const html = renderToString(<RideTotalsLine totals={totals} />);
    const text = html.replace(/<\/?b>/g, "");
    expect(text).toMatch(
      /^3 rides · \S+ \w+ total · 1\.2 h moving · longest \S+ \w+ · this month \S+ \w+ · avg 64% protected$/,
    );
    expect(html).toContain("<b>3</b> rides");
    // and one is not "1 rides"
    const one = renderToString(<RideTotalsLine totals={{ ...totals, count: 1 }} />);
    expect(one).toContain("<b>1</b> ride ·");
    expect(one).not.toContain("rides");
    expect(html).toContain("<b>64%</b> protected");
  });
});

describe("the rides", () => {
  it("are a table of date, distance, time, speed and protection, one row each", () => {
    const html = renderToString(
      <RideList rides={[ride(), ride({ id: "r2", movingS: 0 })]} onMap={noop} onSharePrepare={noop} onShare={noop} onDelete={noop} />,
    );
    expect(html.startsWith("<tbody><tr><th>date</th>")).toBe(true);
    expect(html.match(/<tr>/g)).toHaveLength(3);
    expect(html).toContain("<td>20 min</td>");
    expect(html).toContain("<td>71% + 20% quiet</td>");
    // a ride that never moved has no speed, rather than a division by zero
    expect(html).toContain("<td>–</td>");
    expect(html).toContain('<button title="share this ride (stats card + text)">📤</button>');
  });

  it("are nothing at all when there are none, not a header over nothing", () => {
    expect(
      renderToString(<RideList rides={[]} onMap={noop} onSharePrepare={noop} onShare={noop} onDelete={noop} />),
    ).toBe("");
  });

  it("each go to the map, get a card drawn when a finger lands, share, or go", () => {
    const r = ride();
    const onMap = vi.fn();
    const onSharePrepare = vi.fn();
    const onShare = vi.fn();
    const onDelete = vi.fn();
    const tree = RideList({ rides: [r], onMap, onSharePrepare, onShare, onDelete });
    const [map, share, del] = handlers(tree, "onClick");
    map?.();
    const button = { id: "the-button" };
    share?.({ currentTarget: button });
    del?.();
    for (const down of handlers(tree, "onPointerDown")) down();
    expect(onMap).toHaveBeenCalledWith(r);
    expect(onShare).toHaveBeenCalledWith(r, button);
    expect(onDelete).toHaveBeenCalledWith(r);
    expect(onSharePrepare).toHaveBeenCalledWith(r);
  });
});
