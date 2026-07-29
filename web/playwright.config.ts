import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests-e2e",
  // The Pages runner is about four times slower than a dev machine — the same
  // suite takes 2.7 min here and 10.8 min there — so tests that load an overlay
  // or run a camera animation sit near the limit and fail on time, not on
  // behaviour. The wall-clock budget is the runner's, not the assertion's.
  timeout: process.env["CI"] === undefined ? 60_000 : 150_000,
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
