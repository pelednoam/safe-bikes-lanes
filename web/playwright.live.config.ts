import { defineConfig } from "@playwright/test";

import base from "./playwright.config.js";

// The smoke tests that run on the data actually being deployed (data/), not the
// pinned test snapshot the rest of the suite uses (test-data.json).
//
// The pinned snapshot keeps a weekly rebuild from failing the deploy gate by
// moving what a test aims at. It also means the gate no longer loads the data
// it publishes, so these few tests do: tagged @live, and written to hold for any
// sound build (a route is found, a page draws, an offline map survives the
// network going) rather than for the exact routes of one week.
export default defineConfig({
  ...base,
  grep: /@live/,
  use: { ...base.use, baseURL: "http://127.0.0.1:8324" },
  webServer: {
    command: "python3 scripts/testserver.py 8324 .",
    url: "http://127.0.0.1:8324",
    // its own port, and never another run's server: that one may be serving the
    // pinned snapshot, which is exactly what these tests must not see
    reuseExistingServer: false,
  },
});
