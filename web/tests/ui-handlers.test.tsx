// What the cards do when they are touched: the handlers the string renders never call.
// A render hands the handlers to Preact, so the tests take them from the elements as they
// are made (options.vnode) and call them as a click, a key or a hover would.
import { options, type VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RouteOption } from "../src/types.js";
import { OptionCards, type OptionCardsProps } from "../src/ui/OptionCards.js";
import { Cautions } from "../src/ui/RouteSummary.js";
import { SearchResults, type SearchResultsProps, type SearchRowView } from "../src/ui/SearchResults.js";

type Handler = (ev: unknown) => void;
const handlerOf = (v: VNode, name: string): Handler => (v.props as Record<string, Handler>)[name] as Handler;

/** Every element made while `draw` runs. */
function made(draw: () => void): VNode[] {
  const seen: VNode[] = [];
  const before = options.vnode;
  options.vnode = (v) => {
    seen.push(v);
    before?.(v);
  };
  try {
    draw();
  } finally {
    if (before) options.vnode = before;
    else delete options.vnode;
  }
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const option = (id: RouteOption["id"], grade: string): RouteOption =>
  ({
    id,
    label: id,
    grade,
    gradeReason: "",
    payload: { summary: { meters: 4000, minutes: 20, pct_protected: 80, climb_m: 5 } },
  }) as unknown as RouteOption;

describe("the option cards, touched", () => {
  const props = (over: Partial<OptionCardsProps> = {}): OptionCardsProps => ({
    options: [option("safest", "A"), option("balanced", "B"), option("direct", "F")],
    selectedId: "safest",
    focusId: null,
    gradeColors: {},
    gradeText: {},
    onSelect: vi.fn(),
    onPreview: vi.fn(),
    ...over,
  });
  const cards = (p: OptionCardsProps): VNode[] =>
    made(() => renderToString(<OptionCards {...p} />)).filter((v) => (v.props as { role?: string }).role === "radio");

  it("choose a card with a tap, without taking the focus", () => {
    const p = props();
    handlerOf(cards(p)[1] as VNode, "onClick")({});
    expect(p.onSelect).toHaveBeenCalledWith("balanced", false);
  });

  it("move the choice with the arrow keys, round the ends, keeping the focus", () => {
    const p = props();
    const [first, , last] = cards(p) as [VNode, VNode, VNode];
    const key = (card: VNode, k: string): { prevented: boolean } => {
      const ev = { key: k, prevented: false, preventDefault: () => (ev.prevented = true) };
      handlerOf(card, "onKeyDown")(ev);
      return ev;
    };
    expect(key(first, "ArrowDown").prevented).toBe(true);
    expect(p.onSelect).toHaveBeenLastCalledWith("balanced", true);
    key(first, "ArrowUp"); // before the first is the last
    expect(p.onSelect).toHaveBeenLastCalledWith("direct", true);
    key(last, "ArrowRight"); // after the last is the first
    expect(p.onSelect).toHaveBeenLastCalledWith("safest", true);
    key(first, "ArrowLeft");
    expect(p.onSelect).toHaveBeenLastCalledWith("direct", true);
  });

  it("choose the card in hand with Enter or space", () => {
    const p = props();
    const second = cards(p)[1] as VNode;
    for (const k of ["Enter", " "]) {
      const ev = { key: k, preventDefault: vi.fn() };
      handlerOf(second, "onKeyDown")(ev);
      expect(ev.preventDefault, k).toHaveBeenCalled();
      expect(p.onSelect).toHaveBeenLastCalledWith("balanced", true);
    }
  });

  it("leave every other key alone", () => {
    const p = props();
    const ev = { key: "a", preventDefault: vi.fn() };
    handlerOf(cards(p)[0] as VNode, "onKeyDown")(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it("preview a route while the pointer is on its card, and put the choice back after", () => {
    const p = props();
    const second = cards(p)[1] as VNode;
    handlerOf(second, "onMouseEnter")({});
    expect(p.onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ id: "balanced" }));
    handlerOf(second, "onMouseLeave")({});
    expect(p.onPreview).toHaveBeenLastCalledWith(null);
  });
});

describe("the search results, touched", () => {
  const rows: SearchRowView[] = [
    { key: "a", name: "Davis Square", title: "Davis Square, Somerville", where: "park · 1 mi", lngLat: [-71.12, 42.396] },
    { key: "b", name: "Harvard", title: "Harvard, Cambridge", where: "", lngLat: [-71.11, 42.373] },
  ];
  const props = (): SearchResultsProps => ({
    rows,
    target: "end",
    active: null,
    grades: new Map(),
    message: null,
    gradeColors: {},
    gradeText: {},
    onChoose: vi.fn(),
    onSave: vi.fn(),
  });

  it("hand a row to the page when it is chosen or saved", () => {
    const p = props();
    const rowEls = made(() => renderToString(<SearchResults {...p} />)).filter(
      (v) => (v.props as { row?: unknown }).row !== undefined,
    );
    expect(rowEls).toHaveLength(2);
    handlerOf(rowEls[1] as VNode, "onChoose")({});
    expect(p.onChoose).toHaveBeenCalledWith(rows[1]);
    handlerOf(rowEls[0] as VNode, "onSave")({});
    expect(p.onSave).toHaveBeenCalledWith(rows[0]);
  });
});

describe("the cautions, touched", () => {
  it("asks for the photo of the stretch, and does not follow the link", () => {
    const onPhoto = vi.fn();
    const caution = { name: "Mass Ave", cls: "busy_street", meters: 400, lon: -71.1, lat: 42.38 } as never;
    const links = made(() =>
      renderToString(<Cautions cautions={[caution]} labels={{ busy_street: "busy street" }} photos onPhoto={onPhoto} />),
    ).filter((v) => (v.props as { title?: string }).title?.startsWith("recent street-level photo"));
    expect(links).toHaveLength(1);
    const ev = { preventDefault: vi.fn() };
    handlerOf(links[0] as VNode, "onClick")(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(onPhoto).toHaveBeenCalledWith(-71.1, 42.38);
  });
});
