import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests-e2e",
  timeout: 60_000,
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
