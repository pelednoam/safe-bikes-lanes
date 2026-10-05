// The street card as a popup keeps it: one element, drawn again for each street and again when
// a photo arrives. The DOM is a stub with an innerHTML, and Preact's render writes what the
// string renderer makes into it, so what the card says is what is checked, and not the DOM.
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => ({
  fetchSegmentPhoto: vi.fn(),
  photosPaused: vi.fn(() => false),
}));

vi.mock("preact", async (original) => {
  const real = await original<typeof import("preact")>();
  const { renderToString: toString } = await import("preact-render-to-string");
  return {
    ...real,
    render: (vnode: Parameters<typeof real.render>[0], el: { innerHTML: string }) => {
      el.innerHTML = toString(vnode as Parameters<typeof toString>[0]);
    },
  };
});

vi.mock("../src/segment.js", async (original) => ({
  ...(await original<typeof import("../src/segment.js")>()),
  fetchSegmentPhoto: lookup.fetchSegmentPhoto,
  photosPaused: lookup.photosPaused,
}));

import { cardElement, PlaceCard } from "../src/ui/MapCards.js";
import { SegmentCardView } from "../src/ui/SegmentCard.js";

beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => ({ innerHTML: "" }) });
  lookup.fetchSegmentPhoto.mockReset();
  lookup.photosPaused.mockReset();
  lookup.photosPaused.mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const html = (view: SegmentCardView): string => (view.el as unknown as { innerHTML: string }).innerHTML;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("a card drawn into an element of its own", () => {
  it("is what the card says, as text", () => {
    const el = cardElement(h(PlaceCard, { emoji: "🍦", name: "Mikes <b>", kind: "ice cream" }));
    const text = (el as unknown as { innerHTML: string }).innerHTML;
    // the name's own "<b" is text, not a tag: it is the card's own <b> that wraps it
    expect(text).toContain("<b>Mikes &lt;b></b>");
    expect(renderToString(h(PlaceCard, { emoji: "🍦", name: "Mikes <b>", kind: "ice cream" }))).toBe(text);
  });
});

describe("the street card", () => {
  it("draws the street, and what the page adds under it, again for each street", () => {
    const view = new SegmentCardView();
    view.show({ name: "Mass Ave" }, h("small", null, "right-click to mark"), false);
    expect(html(view)).toContain("Mass Ave");
    expect(html(view)).toContain("right-click to mark");
    expect(html(view)).not.toContain("data-seg-photo");
    view.show({ name: "Elm Street" }, null, false);
    expect(html(view)).toContain("Elm Street");
    expect(html(view)).not.toContain("Mass Ave");
  });

  it("waits for a photo when it can ask for one, and shows it when it comes", async () => {
    lookup.fetchSegmentPhoto.mockResolvedValue({ url: "https://img.example/1.jpg", captured: null });
    const view = new SegmentCardView();
    view.show({ name: "Mass Ave" }, null, true);
    expect(html(view)).toContain("data-seg-photo");
    view.loadPhoto(-71.1, 42.38, "token", () => true);
    await settle();
    expect(lookup.fetchSegmentPhoto).toHaveBeenCalledWith(-71.1, 42.38, "token");
    expect(html(view)).toContain("https://img.example/1.jpg");
  });

  it("says so when there is no photo, and when the lookup is backing off", async () => {
    lookup.fetchSegmentPhoto.mockResolvedValue({ url: null, captured: null });
    const view = new SegmentCardView();
    view.show({ name: "Mass Ave" }, null, true);
    view.loadPhoto(0, 0, "token", () => true);
    await settle();
    expect(html(view)).toContain("no street-level photo here");

    lookup.photosPaused.mockReturnValue(true);
    view.show({ name: "Mass Ave" }, null, true);
    view.loadPhoto(0, 0, "token", () => true);
    await settle();
    expect(html(view)).toContain("rate-limited");
  });

  it("drops a photo for a card since replaced, or one no longer wanted", async () => {
    let answer: (v: { url: string; captured: null }) => void = () => undefined;
    lookup.fetchSegmentPhoto.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const view = new SegmentCardView();
    view.show({ name: "Mass Ave" }, null, true);
    view.loadPhoto(0, 0, "token", () => true);
    view.show({ name: "Elm Street" }, null, true); // the pointer moved to another street
    answer({ url: "https://img.example/old.jpg", captured: null });
    await settle();
    expect(html(view)).toContain("Elm Street");
    expect(html(view)).not.toContain("old.jpg");

    // and the same card, when the popup was closed before the photo came
    const again = new SegmentCardView();
    lookup.fetchSegmentPhoto.mockResolvedValue({ url: "https://img.example/late.jpg", captured: null });
    again.show({ name: "Mass Ave" }, null, true);
    again.loadPhoto(0, 0, "token", () => false);
    await settle();
    expect(html(again)).not.toContain("late.jpg");
  });

  it("asks once: a card whose photo is not awaited is left alone", async () => {
    const view = new SegmentCardView();
    view.show({ name: "Mass Ave" }, null, false); // no token to ask with
    view.loadPhoto(0, 0, "", () => true);
    await settle();
    expect(lookup.fetchSegmentPhoto).not.toHaveBeenCalled();
  });
});
