// The map's small cards, rendered: what each says, and that nothing a feed or
// a rider typed can become markup in them.
import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";

import {
  BlockCard,
  ConstructionCard,
  type ConstructionCardProps,
  CrossingCard,
  ElevationCard,
  HazardCard,
  PlaceCard,
  textOf,
} from "../src/ui/MapCards.js";

const permit = (over: Partial<ConstructionCardProps> = {}): ConstructionCardProps => ({
  name: "Water main replacement",
  kind: "excavation",
  address: "12 Elm St",
  detail: "lane closed",
  src: "cambridge",
  start: "2026-09-01",
  end: "2026-10-15",
  ...over,
});

describe("a place", () => {
  it("is its emoji and name, and what kind of place when that adds anything", () => {
    expect(renderToString(<PlaceCard emoji="🛝" name="Hodgkins Park" kind="playground" />)).toBe(
      "🛝 <b>Hodgkins Park</b><br/><small>playground</small>",
    );
    expect(renderToString(<PlaceCard emoji="🛝" name="playground" kind="" />)).toBe("🛝 <b>playground</b>");
  });
});

describe("a safe crossing", () => {
  it("says what makes it safe", () => {
    expect(renderToString(<CrossingCard />)).toBe(
      "🚦 <b>safe crossing</b><br/><small>signalized crossing of a busy street</small>",
    );
  });
});

describe("a reported hazard", () => {
  it("names the hazard, the rider's note, and when, with how to remove it", () => {
    const html = renderToString(
      <HazardCard label="broken surface / glass" note="glass by the curb" when="9/29/2026" photo={null} />,
    );
    expect(html).toBe(
      "⚠ <b>broken surface / glass</b><br/>glass by the curb<br/><small>9/29/2026 · click to remove</small>",
    );
  });

  it("shows its photo once it has been read from the device", () => {
    const html = renderToString(<HazardCard label="other" note="" when={null} photo="blob:abc" />);
    expect(html).toMatch(/<img src="blob:abc" alt(="")? /);
  });
});

describe("a construction site", () => {
  it("is named, with its address, what's happening, the feed and the dates", () => {
    expect(renderToString(<ConstructionCard {...permit()} />)).toBe(
      "🚧 <b>Water main replacement</b> · excavation<br/>12 Elm St<br/>lane closed" +
        "<br/><small>Cambridge street permit · 2026-09-01 → 2026-10-15</small>",
    );
  });

  it("leaves out what the feed didn't say, rather than blank lines", () => {
    const html = renderToString(<ConstructionCard {...permit({ address: "", detail: "", start: "", end: "" })} />);
    expect(html).toBe("🚧 <b>Water main replacement</b> · excavation<br/><small>Cambridge street permit</small>");
  });

  it("falls back to the kind, then to 'construction', for a title", () => {
    expect(renderToString(<ConstructionCard {...permit({ name: "" })} />)).toContain("<b>excavation</b><br/>");
    expect(renderToString(<ConstructionCard {...permit({ name: "", kind: "" })} />)).toContain(
      "<b>construction</b>",
    );
  });

  it("says a work zone is MassDOT's, and marks a missing date rather than hiding the other", () => {
    const html = renderToString(<ConstructionCard {...permit({ src: "massdot_wzdx", end: "" })} />);
    expect(html).toContain("<small>MassDOT work zone · 2026-09-01 → ?</small>");
  });

  it("cannot be made to carry markup by a feed", () => {
    const html = renderToString(
      <ConstructionCard {...permit({ name: '<img src=x onerror="alert(1)">', address: "<script>x</script>" })} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
  });
});

describe("a feed's text", () => {
  it("is absent unless it says something", () => {
    expect(textOf("  12 Elm St ")).toBe("12 Elm St");
    expect(textOf("   ")).toBe("");
    expect(textOf(null)).toBe("");
    expect(textOf(7)).toBe("");
  });
});

describe("the overlays' cards", () => {
  it("say how much of a block has bike facilities, and how much is protected", () => {
    const html = renderToString(<BlockCard facilityM={400} protectedM={120} />);
    expect(html).toMatch(/^🚴 \S+ \w+ of bike facilities in this block<br\/><small>\S+ \w+ protected \(path\/separated\)<\/small>$/);
  });

  it("give a point's elevation", () => {
    expect(renderToString(<ElevationCard elevM={42} />)).toMatch(/^elevation ~\S+/);
  });
});
