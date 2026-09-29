// The route option cards, rendered: what a rider and a screen reader get.
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";

import type { RouteOption } from "../src/types.js";
import { OptionCards, type OptionCardsProps } from "../src/ui/OptionCards.js";

const option = (id: RouteOption["id"], label: string, grade: string, meters: number): RouteOption =>
  ({
    id,
    label,
    grade,
    gradeReason: `${label} reasons`,
    payload: { summary: { meters, minutes: 20, pct_protected: 80, climb_m: 12 } },
  }) as unknown as RouteOption;

const props = (over: Partial<OptionCardsProps> = {}): OptionCardsProps => ({
  options: [option("safest", "Safest", "A", 5000), option("direct", "Direct", "F", 3200)],
  selectedId: "safest",
  focusId: null,
  gradeColors: { A: "#1a9850", F: "#d73027" },
  gradeText: { A: "#fff", F: "#fff" },
  onSelect: () => undefined,
  onPreview: () => undefined,
  ...over,
});

describe("the option cards", () => {
  it("are nothing at all with no options", () => {
    expect(renderToString(<OptionCards {...props({ options: [] })} />)).toBe("");
  });

  it("say how many there are, and draw one card each", () => {
    const html = renderToString(<OptionCards {...props()} />);
    expect(html).toContain('<div class="options-head">2 route options</div>');
    expect(html.match(/class="option-card/g)).toHaveLength(2);
  });

  it("don't count a single option", () => {
    const html = renderToString(<OptionCards {...props({ options: [option("safest", "Safest", "A", 5000)] })} />);
    expect(html).not.toContain("route options");
  });

  it("are a radio group: the chosen one checked and the one tab stop", () => {
    const html = renderToString(<OptionCards {...props()} />);
    const cards = html.split('class="option-card').slice(1);
    expect(cards[0]).toMatch(/^ selected"/);
    expect(cards[0]).toContain('role="radio"');
    expect(cards[0]).toContain('aria-checked="true"');
    expect(cards[0]).toContain('tabindex="0"');
    // unchecked says so, rather than leaving the attribute out
    expect(cards[1]).toContain('aria-checked="false"');
    expect(cards[1]).toContain('tabindex="-1"');
  });

  it("put the grade in its colour, and the reason in the tooltip", () => {
    const html = renderToString(<OptionCards {...props()} />);
    expect(html).toMatch(/<b class="grade" style="background:#1a9850;color:#fff;?">A<\/b>/);
    expect(html).toContain('title="Safest reasons"');
  });

  it("give the chosen card the headline and the others the climb too", () => {
    const html = renderToString(<OptionCards {...props()} />);
    const [chosen, other] = html.split('class="option-card').slice(1);
    expect(chosen).toContain("20 min · 80% protected</span>");
    expect(chosen).not.toContain("↗");
    expect(other).toContain("↗");
  });
});
