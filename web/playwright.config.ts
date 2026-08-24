import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests-e2e",
  // cov.spec measures how much of app.js an E2E session executes. It asserts
  // nothing and takes ~2 min, so it runs on request (npm run coverage:app)
  // rather than in every suite.
  testIgnore: ["cov.spec.ts"],
  // The Pages runner is about four times slower than a dev machine — the same
  // suite takes 2.7 min here and 10.8 min there — so tests that load an overlay
  // or run a camera animation sit near the limit and fail on time, not on
  // behaviour. The wall-clock budget is the runner's, not the assertion's.
  // CI gets five minutes a test, not two and a half. The waits inside the tests are
  // scaled by tests-e2e/budget.ts for the same reason — a runner that got 33% slower
  // between two runs of the same commit failed nine tests, all of them on map and
  // route waits, all of which passed locally against the identical data. The test
  // timeout has to leave room for the scaled waits inside it, or it becomes the
  // thing that fires first and the scaling achieves nothing.
  timeout: process.env["CI"] === undefined ? 60_000 : 300_000,
  use: {
    baseURL: "http://127.0.0.1:8321",
    viewport: { width: 1200, height: 800 },
  },
  webServer: {
    command: "python3 scripts/testserver.py 8321",
    url: "http://127.0.0.1:8321",
    reuseExistingServer: true,
  },
});
