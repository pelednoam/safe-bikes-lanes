// Tests for the pure parts of hazard reporting (IndexedDB is browser-only).
import { describe, expect, it } from "vitest";

import { buildReportText, HAZARD_LABELS } from "../src/hazards.js";
import type { HazardReport } from "../src/hazards.js";

describe("buildReportText", () => {
  const report: HazardReport = {
    id: "1",
    t: Date.UTC(2026, 6, 20, 15, 0),
    lon: -71.09876,
    lat: 42.38765,
    category: "surface",
    note: "glass across the whole lane",
    hasPhoto: true,
  };

  it("includes category, note, and a maps link", () => {
    const text = buildReportText(report);
    expect(text).toContain(HAZARD_LABELS.surface);
    expect(text).toContain("glass across the whole lane");
    expect(text).toContain("https://maps.google.com/?q=42.387650,-71.098760");
    expect(text).toContain("42.38765, -71.09876");
  });

  it("omits the note sentence when empty", () => {
    const text = buildReportText({ ...report, note: "  " });
    expect(text).not.toContain("..");
    expect(text).toContain(`${HAZARD_LABELS.surface}. Location:`);
  });
});
