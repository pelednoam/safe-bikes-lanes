// The voice test, the way an iPhone answers it: Safari reports no voices at
// all until something has been spoken, and speaks only what was started inside
// the tap.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { budget } from "./budget.js";

declare global {
  interface Window {
    _map?: MLMap;
    __said?: { text: string; inTap: boolean }[];
  }
}

test("the voice test speaks on a browser that lists no voices yet", async ({ page }) => {
  await page.addInitScript(() => {
    let inTap = false;
    window.addEventListener("click", () => (inTap = true), true);
    window.addEventListener("click", () => (inTap = false));
    window.__said = [];
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speaking: false,
        // what iOS Safari reports on a cold page
        getVoices: () => [],
        cancel: () => undefined,
        speak(u: { text: string; onstart?: () => void; onend?: () => void }): void {
          window.__said?.push({ text: u.text, inTap });
          // iOS drops speech that was not started inside the tap
          if (!inTap) return;
          setTimeout(() => u.onstart?.(), 10);
          setTimeout(() => u.onend?.(), 50);
        },
      },
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: class {
        text: string;
        rate = 1;
        volume = 1;
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(t: string) {
          this.text = t;
        }
      },
    });
  });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.locator('summary:has-text("Voice")').click();
  await page.locator("#voice-test").click();

  const status = page.locator("#voice-status");
  await expect(status).toContainText("spoken by the browser", { timeout: 10_000 });
  const said = await page.evaluate(() => window.__said ?? []);
  expect(said.map((s) => s.text).join(" | ")).toMatch(/Voice test/);
  expect(said[0]?.inTap, "spoken after the tap, which iOS ignores").toBe(true);
  // and it promises nothing a browser cannot do: no web page talks with the
  // screen off, and there is no iPhone app to switch to
  await expect(status).not.toContainText("keeps talking with the screen off");
});
