// The saved places and recent routes, rendered.
import type { VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";

import type { RecentRoute, SavedPlace } from "../src/places.js";
import { RECENT_SHOWN, RecentRoutes, SavedPlaces } from "../src/ui/PlacesAndRecent.js";

const home: SavedPlace = { name: "Home", lon: -71.1, lat: 42.38 };
const odd: SavedPlace = { name: "<b>Dentist</b>", lon: -71.2, lat: 42.4 };

function recent(n: number): RecentRoute[] {
  return Array.from({ length: n }, (_, i) => ({
    s: [-71.1, 42.38] as [number, number],
    e: [-71.08, 42.36 + i / 100] as [number, number],
    label: `Home → Stop ${i}`,
    km: 2.5,
    grade: "A",
    t: 1000 + i,
  }));
}

const noop = (): void => {};

describe("the saved places", () => {
  it("names each place with its emoji and offers start, end and delete", () => {
    const html = renderToString(<SavedPlaces places={[home]} onUse={noop} onDelete={noop} />);
    expect(html).toContain('<div class="search-row"><span>🏠 Home</span>');
    expect(html).toContain("<button>start</button><button>end</button>");
    expect(html).toContain('<button title="delete place">✕</button>');
  });

  it("draws a name as text, never as markup", () => {
    const html = renderToString(<SavedPlaces places={[odd]} onUse={noop} onDelete={noop} />);
    expect(html).toContain("📍 &lt;b>Dentist&lt;/b>");
    expect(html).not.toContain("<b>");
  });

  it("draws nothing when there are none", () => {
    expect(renderToString(<SavedPlaces places={[]} onUse={noop} onDelete={noop} />)).toBe("");
  });
});

describe("the recent routes", () => {
  it("is empty with no history, not a lone 'clear' button", () => {
    expect(renderToString(<RecentRoutes routes={[]} onPlan={noop} onClear={noop} />)).toBe("");
  });

  it("offers the latest few, each again or reversed, and a way to clear them", () => {
    const html = renderToString(<RecentRoutes routes={recent(8)} onPlan={noop} onClear={noop} />);
    expect(html.match(/class="search-row"/g)).toHaveLength(RECENT_SHOWN);
    expect(html).toContain("🕘 Home → Stop 0 · ");
    expect(html).not.toContain("Stop 5");
    expect(html).toContain('title="plan this route again"');
    expect(html).toContain('<button title="plan the reverse direction">⇄</button>');
    expect(html).toMatch(/<button title="clear recent routes"[^>]*>clear history<\/button>/);
  });
});

/** Every element in a component's output, depth first. The tests run without
 * a DOM, so a button is pressed by calling the handler it was given. */
function elements(node: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const vnode = node as VNode<Record<string, unknown>>;
  return [vnode, ...elements(vnode.props["children"])];
}

function press(tree: unknown, match: (props: Record<string, unknown>) => boolean): void {
  const hit = elements(tree).find((v) => typeof v.props["onClick"] === "function" && match(v.props));
  if (hit === undefined) throw new Error("nothing to press");
  (hit.props["onClick"] as () => void)();
}

describe("the rows' buttons", () => {
  it("hand back the place, and the route either way round", () => {
    const onUse = vi.fn();
    const onDelete = vi.fn();
    const places = SavedPlaces({ places: [home], onUse, onDelete });
    press(places, (p) => p["children"] === "start");
    press(places, (p) => p["children"] === "end");
    press(places, (p) => p["title"] === "delete place");
    expect(onUse.mock.calls).toEqual([
      [home, "start"],
      [home, "end"],
    ]);
    expect(onDelete).toHaveBeenCalledWith(home);

    const onPlan = vi.fn();
    const onClear = vi.fn();
    const [route] = recent(1);
    const routes = RecentRoutes({ routes: route === undefined ? [] : [route], onPlan, onClear });
    press(routes, (p) => p["title"] === "plan this route again");
    press(routes, (p) => p["title"] === "plan the reverse direction");
    press(routes, (p) => p["title"] === "clear recent routes");
    expect(onPlan.mock.calls).toEqual([
      [route?.s, route?.e],
      [route?.e, route?.s],
    ]);
    expect(onClear).toHaveBeenCalledOnce();
  });
});
