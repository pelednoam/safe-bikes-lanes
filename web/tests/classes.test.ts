// The line styles for the safety classes: the marks that tell them apart without
// colour, as the map, the legend and the ride's class key draw them.
import { describe, expect, it } from "vitest";

import { CLASS_MARKS, classSwatch, classWidth, isTick, NETWORK_MARK_LAYERS } from "../src/app/classes.js";
import type { ProtectionClass } from "../src/types.js";
import { CLASS_COLORS } from "../src/weights.gen.js";

const CLASSES = Object.keys(CLASS_COLORS) as ProtectionClass[];

describe("a class's swatch", () => {
  it("is its colour, and nothing over it when the class has no mark", () => {
    for (const cls of ["path", "separated", "buffered", "quiet_street", "service"] as const) {
      const svg = classSwatch(cls);
      expect(svg, cls).toContain(`stroke="${CLASS_COLORS[cls]}"`);
      expect(svg.match(/<line /g), `${cls} has a mark it shouldn't`).toHaveLength(1);
    }
  });

  it("carries its mark over the line: dashes, dots, or ticks", () => {
    for (const mark of CLASS_MARKS) {
      const svg = classSwatch(mark.cls);
      expect(svg.match(/<line /g), mark.cls).toHaveLength(2);
      expect(svg, mark.cls).toContain("stroke-dasharray=");
      // round caps are what turn a zero-length dash into a dot: on the mark's own
      // line (the second), and only where the table asks for them
      const markLine = svg.match(/<line [^>]*>/g)?.[1] ?? "";
      expect(markLine.includes('stroke-linecap="round"'), `${mark.cls}: caps`).toBe(mark.round);
    }
  });

  it("takes a tick's ink from the theme, and the others' fixed", () => {
    for (const mark of CLASS_MARKS) {
      const svg = classSwatch(mark.cls);
      if (isTick(mark)) expect(svg, mark.cls).toContain("var(--tick-ink)");
      else expect(svg, mark.cls).not.toContain("var(--tick-ink)");
    }
  });

  it("is the size asked for", () => {
    expect(classSwatch("lane", 50, 20)).toContain('width="50" height="20" viewBox="0 0 50 20"');
  });
});

describe("the marks", () => {
  it("are on the two classes a child should not be on as ticks, and nowhere else", () => {
    expect(CLASS_MARKS.filter(isTick).map((m) => m.cls).sort()).toEqual(["busy_street", "moderate_street"]);
  });

  it("each have a layer of their own", () => {
    expect(NETWORK_MARK_LAYERS).toEqual(CLASS_MARKS.map((m) => `network-mark-${m.id}`));
    expect(new Set(NETWORK_MARK_LAYERS).size).toBe(CLASS_MARKS.length);
  });
});

describe("the line width", () => {
  it("grows from zoom 12 to 16 and has a width for every class", () => {
    const expr = classWidth(2, 6) as unknown as unknown[];
    expect(expr.slice(0, 3)).toEqual(["interpolate", ["linear"], ["zoom"]]);
    expect(expr[3]).toBe(12);
    expect(expr[5]).toBe(16);
    const text = JSON.stringify(expr);
    for (const cls of CLASSES) expect(text, cls).toContain(`"${cls}"`);
  });

  it("scales with the factor given", () => {
    const at = (scale: number): number => ((classWidth(2, 6, scale) as unknown as [string, unknown, unknown, number, [string, number]])[4])[1];
    expect(at(2)).toBe(2 * at(1));
  });
});
