// Tests for saved places and recent-route logic (pure parts).
import { describe, expect, it } from "vitest";

import { emojiFor, recentWithNew } from "../src/places.js";
import type { RecentRoute } from "../src/places.js";

describe("emojiFor", () => {
  it("matches common tags", () => {
    expect(emojiFor("Home")).toBe("🏠");
    expect(emojiFor("noam's work")).toBe("💼");
    expect(emojiFor("School - dropoff")).toBe("🏫");
    expect(emojiFor("Danehy Park")).toBe("🛝");
    expect(emojiFor("Random Cafe")).toBe("📍");
  });
});

describe("recentWithNew", () => {
  const route = (
    s: [number, number],
    e: [number, number],
    label: string,
    t = 0,
  ): RecentRoute => ({ s, e, label, km: 5, grade: "A", t });

  it("prepends and dedupes near-identical endpoint pairs", () => {
    const a = route([-71.1, 42.38], [-71.09, 42.39], "old", 1);
    const b = route([-71.10001, 42.38001], [-71.09002, 42.39001], "same again", 2);
    const merged = recentWithNew([a], b);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe("same again");
  });

  it("keeps distinct routes and caps at 8", () => {
    let list: RecentRoute[] = [];
    for (let i = 0; i < 12; i++) {
      list = recentWithNew(list, route([-71.1 + i * 0.01, 42.38], [-71.0, 42.4], `r${i}`, i));
    }
    expect(list).toHaveLength(8);
    expect(list[0]?.label).toBe("r11");
    expect(list[7]?.label).toBe("r4");
  });
});
