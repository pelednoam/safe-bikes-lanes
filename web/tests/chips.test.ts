// The option badges on the map: what each says, where it sits, and how it is
// written onto a marker's element without disturbing MapLibre's own classes.
import { describe, expect, it } from "vitest";

import { chipViews, paintChip } from "../src/chips.js";
import type { RouteOption } from "../src/types.js";

const colors = { A: "#1a9850", C: "#fee08b" };
const ink = { A: "#fff", C: "#222" };

function option(id: RouteOption["id"], grade: "A" | "C", minutes: number, n = 10): RouteOption {
  const coords = Array.from({ length: n }, (_, i) => [-71.1 + i / 1000, 42.38]);
  return {
    id,
    label: id === "safest" ? "Safest" : "Direct",
    grade,
    gradeReason: grade === "A" ? "almost all protected" : "some busy streets",
    payload: {
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }],
      },
      summary: { minutes },
    },
  } as unknown as RouteOption;
}

describe("the badges", () => {
  it("say each option's grade and time, and which is chosen", () => {
    const views = chipViews([option("safest", "A", 24), option("direct", "C", 19)], "safest", colors, ink);
    expect(views.map((v) => [v.id, v.text, v.selected])).toEqual([
      ["safest", "A · 24 min", true],
      ["direct", "C · 19 min", false],
    ]);
    expect(views[1]).toMatchObject({
      title: "Direct: some busy streets",
      ariaLabel: "Direct: grade C, 19 minutes",
      color: "#fee08b",
      ink: "#222",
    });
  });

  it("sit a different way along each line, so shared stretches don't stack them", () => {
    const views = chipViews([option("safest", "A", 24), option("direct", "C", 19)], null, colors, ink);
    // 35% and 55% of ten points
    expect(views.map((v) => v.at[0])).toEqual([-71.1 + 3 / 1000, -71.1 + 5 / 1000]);
  });

  it("are none for a single route: there is no choice to make", () => {
    expect(chipViews([option("safest", "A", 24)], "safest", colors, ink)).toEqual([]);
  });

  it("skip an option with no line to sit on", () => {
    const views = chipViews([option("safest", "A", 24, 0), option("direct", "C", 19)], null, colors, ink);
    expect(views.map((v) => v.id)).toEqual(["direct"]);
  });
});

/** Enough of an element for paintChip, recording what it was given. */
function fakeElement(classes: string[]) {
  const set = new Set(classes);
  const attrs = new Map<string, string>();
  const vars = new Map<string, string>();
  let writes = 0;
  let text = "";
  const el = {
    classList: {
      add: (c: string) => set.add(c),
      toggle: (c: string, on: boolean) => (on ? set.add(c) : set.delete(c)),
    },
    style: { setProperty: (k: string, v: string) => vars.set(k, v) },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    title: "",
    get textContent(): string {
      return text;
    },
    set textContent(v: string) {
      writes++;
      text = v;
    },
  };
  return { el, set, attrs, vars, writes: () => writes };
}

describe("painting a badge", () => {
  it("keeps MapLibre's classes on the marker, and marks the chosen one", () => {
    const f = fakeElement(["maplibregl-marker", "maplibregl-marker-anchor-center"]);
    const [v] = chipViews([option("safest", "A", 24), option("direct", "C", 19)], "safest", colors, ink);
    if (v === undefined) throw new Error("no view");
    paintChip(f.el as unknown as HTMLElement, v);
    expect([...f.set].sort()).toEqual(["maplibregl-marker", "maplibregl-marker-anchor-center", "opt-chip", "sel"]);
    expect(f.attrs.get("aria-pressed")).toBe("true");
    expect(f.vars.get("--g")).toBe("#1a9850");

    paintChip(f.el as unknown as HTMLElement, { ...v, selected: false });
    expect(f.set.has("sel")).toBe(false);
    expect(f.set.has("maplibregl-marker")).toBe(true);
    expect(f.attrs.get("aria-pressed")).toBe("false");
  });

  it("doesn't rewrite text that hasn't changed", () => {
    const f = fakeElement([]);
    const [v] = chipViews([option("safest", "A", 24), option("direct", "C", 19)], null, colors, ink);
    if (v === undefined) throw new Error("no view");
    paintChip(f.el as unknown as HTMLElement, v);
    paintChip(f.el as unknown as HTMLElement, v);
    expect(f.writes()).toBe(1);
    expect(f.el.textContent).toBe("A · 24 min");
  });
});
