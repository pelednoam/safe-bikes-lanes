// The ride banner's words, rendered with the ids the page and its tests use.
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";

import { NavHeadline, NavTripLine } from "../src/ui/NavBanner.js";

describe("the ride banner", () => {
  it("says the turn, how far, and where", () => {
    expect(renderToString(<NavHeadline icon="↰" dist="300 ft" street="Elm Street" />)).toBe(
      '<span id="nav-icon">↰</span><div id="nav-texts"><div id="nav-dist">300 ft</div>' +
        '<div id="nav-street">Elm Street</div></div>',
    );
  });

  it("says what is left and how fast, and nothing for a speed it doesn't have", () => {
    const html = renderToString(<NavTripLine remaining="2.1 mi · 12 min · eta 3:40 PM" speed="" />);
    expect(html).toBe('<span id="nav-remaining">2.1 mi · 12 min · eta 3:40 PM</span><span id="nav-speed"></span>');
  });

  it("writes what it is given as text, never as markup", () => {
    // a street name comes from OpenStreetMap: it must not become part of the page
    const html = renderToString(<NavHeadline icon="⬆" dist="now" street={'<img src=x onerror="alert(1)">'} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
