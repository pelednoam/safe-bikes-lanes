import { defineConfig } from "@playwright/test";

// "Native app-layer" emulation: serve the assembled APK bundle (dist/) and
// let the specs shim window.Capacitor so isNativeApp() paths execute — the
// code the web E2E can't reach. This is NOT a full Android emulator (no
// device plugins), but it covers the WebView/JS layer where the stale-shell
// bug lived.
export default defineConfig({
  testDir: "tests-e2e-native",
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:8322",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: "bash scripts/assemble.sh && python3 -m http.server 8322 --bind 127.0.0.1 -d dist",
    url: "http://127.0.0.1:8322",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
