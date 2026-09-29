// A report as the app sends one, for the tests to vary.
import type { Report } from "../src/report.js";

export function sample(over: Partial<Report> = {}): Report {
  return {
    v: 1,
    kind: "error",
    message: "TypeError: Cannot read properties of undefined (reading 'lngLat')",
    frames: ["renderRibbon (app-BrmPk3gH.js:1:23456)", "showSummary (app-BrmPk3gH.js:1:24000)"],
    build: "app-v55 d649c79",
    page: "planner",
    platform: "web",
    browser: "Chrome 140",
    ...over,
  };
}
