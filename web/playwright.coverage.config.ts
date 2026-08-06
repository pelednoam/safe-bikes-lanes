// How much of the shipped app.js an end-to-end session actually executes.
// app.ts is the DOM and map wiring — 5,000 of ~6,400 TypeScript lines, with no
// unit tests by design — so this is the only honest way to put a number on it.
// Separate from the suites because it asserts nothing and takes about 2 minutes.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests-e2e",
  testMatch: ["cov.spec.ts"],
  timeout: 300_000,
  use: {
    baseURL: "http://127.0.0.1:8321",
    viewport: { width: 1200, height: 800 },
  },
  webServer: {
    command: "python3 -m http.server 8321 --bind 127.0.0.1",
    url: "http://127.0.0.1:8321",
    reuseExistingServer: true,
  },
});
