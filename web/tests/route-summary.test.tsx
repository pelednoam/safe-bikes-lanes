// The chosen route's summary, rendered.
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";

import type { Caution, RibbonSeg } from "../src/types.js";
import { Cautions, ClassBar, ClassKey, Ribbon, RIBBON_W, WhyList } from "../src/ui/RouteSummary.js";

const colors = { path: "#1a9850", busy_street: "#d73027" };
const labels = { path: "path", busy_street: "busy street" };
const parts = [
  { cls: "path" as const, meters: 900 },
  { cls: "busy_street" as const, meters: 100 },
  { cls: "sharrow" as const, meters: 4 }, // under 1%
];

describe("the class breakdown", () => {
  it("draws a patterned segment per kind, in proportion, named in its tooltip", () => {
    const html = renderToString(<ClassBar parts={parts} colors={colors} labels={labels} />);
    expect(html.match(/<i /g)).toHaveLength(3);
    expect(html).toContain('class="pat-path"');
    expect(html).toMatch(/style="flex:\s?900;background-color:#1a9850;?"/);
    // a kind with no colour of its own still draws, in grey
    expect(html).toMatch(/background-color:#999/);
    expect(html).toContain('title="path: ');
  });

  it("names the kinds in words, and leaves out a sliver under 1%", () => {
    const html = renderToString(
      <ClassKey parts={parts} colors={colors} labels={labels} swatch={(c) => `<svg data-c="${c}"></svg>`} />,
    );
    expect(html).toContain("path 90%");
    expect(html).toContain("busy street 10%");
    expect(html).not.toContain("sharrow");
    expect(html).toContain('<svg data-c="path"></svg>');
  });
});

describe("the cautions", () => {
  const busy: Caution = { name: "Mass Ave", cls: "busy_street", meters: 300, lon: -71.1, lat: 42.37 };

  it("say so when there is nothing to watch for", () => {
    const html = renderToString(<Cautions cautions={[]} labels={labels} photos={false} onPhoto={() => undefined} />);
    expect(html).toBe('<div class="all-clear">✓ no stressful segments</div>');
  });

  it("name each stretch, with street view, and a photo only with a token", () => {
    const withPhotos = renderToString(<Cautions cautions={[busy]} labels={labels} photos onPhoto={() => undefined} />);
    expect(withPhotos).toContain("⚠ Mass Ave: ");
    expect(withPhotos).toContain("of busy street");
    expect(withPhotos).toContain('href="https://maps.google.com/maps?q=&amp;layer=c&amp;cbll=42.37,-71.1"');
    expect(withPhotos).toContain("📷 photo");
    const without = renderToString(<Cautions cautions={[busy]} labels={labels} photos={false} onPhoto={() => undefined} />);
    expect(without).not.toContain("📷");
  });

  it("offer no street view for a stretch with no place", () => {
    const nowhere: Caution = { name: "Somewhere", cls: "busy_street", meters: 50 };
    const html = renderToString(<Cautions cautions={[nowhere]} labels={labels} photos onPhoto={() => undefined} />);
    expect(html).not.toContain("street view");
  });
});

describe("why this route", () => {
  it("is the router's reasons, one per line, as text", () => {
    const html = renderToString(<WhyList reasons={["Avoids Mass Ave.", "<b>not markup</b>"]} />);
    expect(html).toBe("<li>Avoids Mass Ave.</li><li>&lt;b>not markup&lt;/b></li>");
  });
});

describe("the ribbon", () => {
  const segs: RibbonSeg[] = [
    { m: 300, cls: "path", e0: 10, e1: 14, crossing: false },
    { m: 100, cls: "lane", e0: 14, e1: 30, crossing: true },
    { m: 100, cls: "busy_street", e0: 30, e1: 28, crossing: false, walk: true },
  ];
  const ribbonColors = { ...colors, lane: "#91cf60" };
  const ribbonLabels = { ...labels, lane: "painted lane" };
  const draw = (s: RibbonSeg[]): string =>
    renderToString(
      <Ribbon
        segs={s}
        colors={ribbonColors}
        labels={ribbonLabels}
        marked={new Set(["lane", "busy_street"])}
        patterns='<defs><pattern id="rp-lane"></pattern></defs>'
        climb={(m) => `${Math.round(m)} m`}
      />,
    );

  it("lays the route out left to right, each stretch in proportion and named", () => {
    const html = draw(segs);
    expect(html).toContain(`<svg width="${RIBBON_W}" height="70"`);
    expect(html).toContain('<rect x="0.00" y="0" width="168.00" height="12" fill="#1a9850"><title>path: ');
    expect(html).toContain('<rect x="168.00" y="0" width="56.00" height="12" fill="#91cf60"><title>painted lane: ');
    // the marks come with the page's own patterns
    expect(html).toContain('<g><defs><pattern id="rp-lane"></pattern></defs></g>');
    expect(html).toContain('fill="url(#rp-lane)" pointer-events="none"');
  });

  it("draws a walked stretch as walking, with no street mark", () => {
    const html = draw(segs);
    expect(html).toContain('fill="#8aa4b8"><title>walk the bike: ');
    expect(html).not.toContain("url(#rp-busy_street)");
  });

  it("flags the busy crossings where they start", () => {
    expect(draw(segs)).toContain('<text x="168.00" y="23" font-size="11" fill="#a33">▲<title>busy crossing</title></text>');
  });

  it("draws the climb between its lowest and highest points, and names them", () => {
    const html = draw(segs);
    expect(html).toContain('points="0.00,62.0 168.00,57.2 168.00,57.2 224.00,38.0 224.00,38.0 280.00,40.4"');
    expect(html).toContain('opacity=".7">30 m</text>');
    expect(html).toContain('opacity=".7">10 m</text>');
  });

  it("a flat route still gets a scale, not a division by zero", () => {
    const html = draw([{ m: 100, cls: "path", e0: 12, e1: 12, crossing: false }]);
    expect(html).toContain('points="0.00,62.0 280.00,62.0"');
    expect(html).toContain('opacity=".7">17 m</text>');
  });

  it("draws nothing for a route without one", () => {
    expect(draw([])).toBe("");
    expect(draw([{ m: 0, cls: "path", e0: 1, e1: 1, crossing: false }])).toBe("");
  });
});
