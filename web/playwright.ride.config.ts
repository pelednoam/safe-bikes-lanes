import { defineConfig } from "@playwright/test";

// Whole-ride simulation: a virtual rider moves along the route feeding the app
// full GPS fixes (speed, heading, accuracy, wander), so navigation is exercised
// the way it is actually used. Kept out of the per-commit deploy gate because a
// full ride is minutes of simulated time — run it with `npm run e2e:ride`
// before shipping navigation changes, or when a ride behaved oddly.
export default defineConfig({
  testDir: "tests-e2e-ride",
  timeout: 600_000,
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:8323",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: "python3 -m http.server 8323 --bind 127.0.0.1",
    url: "http://127.0.0.1:8323",
    reuseExistingServer: true,
  },
});
