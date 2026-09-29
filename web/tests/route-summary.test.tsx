// The chosen route's summary, rendered.
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";

import type { Caution } from "../src/types.js";
import { Cautions, ClassBar, ClassKey, WhyList } from "../src/ui/RouteSummary.js";

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
