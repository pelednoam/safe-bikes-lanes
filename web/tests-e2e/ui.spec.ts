// The planner as a parent meets it: on a phone, outdoors, often one-handed,
// sometimes with a screen reader or a keyboard, sometimes in miles and
// sometimes in kilometres. These tests measure what reaches the person — sizes,
// positions, names, announcements and units — rather than what the code meant.
import { expect, test } from "@playwright/test";

import { budget } from "./budget.js";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";
const PHONE = { width: 390, height: 820 };

async function boot(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map?.isSourceLoaded("network") === true, null, {
    timeout: budget(45_000),
  });
}

async function routed(page: Page): Promise<void> {
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
}

test.describe("units", () => {
  test("the map's route chips say minutes, the way the cards do", async ({ page }) => {
    // "A · 64m" beside a card reading "64 min" — in an app that shows miles,
    // "m" reads as metres, and nobody's ride is 64 metres long
    await routed(page);
    const chips = await page.locator(".opt-chip").allTextContents();
    expect(chips.length).toBeGreaterThan(1);
    for (const c of chips) expect(c).toMatch(/^[A-F] · \d+ min$/);
  });

  test("the walking budget reads in the rider's unit", async ({ page }) => {
    await boot(page);
    const labels = (): Promise<string[]> =>
      page.locator("#walk-max option").allTextContents();
    // miles by default: "100 m" and "1 km" were the only metric left in the panel
    expect(await labels()).toEqual(["0 ft", "330 ft", "820 ft", "0.3 mi", "0.6 mi"]);
    await page.locator("summary", { hasText: "Preferences" }).click();
    await page.locator("#units-pref").selectOption("metric");
    expect(await labels()).toEqual(["0 m", "100 m", "250 m", "500 m", "1 km"]);
  });
});

/** Pretend to be a phone with a status bar, a notch and a home indicator —
 * Chromium's own emulation of env(safe-area-inset-*), which iOS and Android
 * 15+ set for a page with viewport-fit=cover. */
async function insets(
  page: Page,
  i: { top: number; right: number; bottom: number; left: number },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: i });
}

type Box = { top: number; left: number; right: number; bottom: number };
const rect = (page: Page, sel: string): Promise<Box> =>
  page
    .locator(sel)
    .first()
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
    });

test.describe("the edges of a real phone", () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  test("nothing pinned to the top sits under the status bar or the notch", async ({ page }) => {
    await boot(page);
    await insets(page, { top: 47, right: 0, bottom: 34, left: 0 });
    // the ride banner matters most: the turn arrow and the distance to it
    // were drawn under the Dynamic Island
    await page.evaluate(() => {
      for (const id of ["nav-banner", "update-banner", "data-update"]) {
        (document.getElementById(id) as HTMLElement).style.display = "block";
      }
    });
    const pinned = ["#nav-banner", "#update-banner", "#data-update", ".maplibregl-ctrl-top-right"];
    for (const sel of pinned) {
      expect((await rect(page, sel)).top, `${sel} is under the status bar`).toBeGreaterThanOrEqual(
        47,
      );
    }
  });

  test("in landscape the sheet and the ride dock keep clear of the notch", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await boot(page);
    await insets(page, { top: 0, right: 47, bottom: 21, left: 47 });
    await page.evaluate(() => document.body.classList.add("navigating"));
    const dock = await rect(page, "#ride-dock");
    expect(dock.left).toBeGreaterThanOrEqual(47);
    expect(dock.right).toBeLessThanOrEqual(844 - 47);
    await page.evaluate(() => document.body.classList.remove("navigating"));
    for (const sel of ["#search", "#from-field"]) {
      expect((await rect(page, sel)).left, `${sel} runs under the notch`).toBeGreaterThanOrEqual(47);
    }
    expect((await rect(page, "#about-top")).right).toBeLessThanOrEqual(844 - 47);
  });

  test("no field is small enough for iOS to zoom the page when it is tapped", async ({ page }) => {
    await boot(page);
    const small = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLInputElement>(
          "#panel input, #panel select, dialog input, dialog select",
        ),
      ]
        .filter((e) => !["checkbox", "radio", "file", "hidden"].includes(e.type))
        .map((e) => ({ id: e.id, px: parseFloat(getComputedStyle(e).fontSize) }))
        .filter((f) => f.px < 16),
    );
    expect(small).toEqual([]);
  });

  test("everything in the panel is a thumb-sized target", async ({ page }) => {
    await routed(page);
    await page.evaluate(() => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>("#panel details")) d.open = true;
    });
    const tooSmall = await page.evaluate(() => {
      const out: string[] = [];
      const sel =
        "#panel button, #panel select, " +
        "#panel input:not([type=checkbox]):not([type=radio]):not([type=file]), " +
        "#panel summary, #modes label, .maplibregl-ctrl-group button";
      for (const e of document.querySelectorAll<HTMLElement>(sel)) {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || getComputedStyle(e).visibility === "hidden") continue; // not shown
        if (r.height < 44 || r.width < 44) {
          const name = e.id || (e.textContent ?? "").trim().slice(0, 20) || e.tagName;
          out.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return out;
    });
    expect(tooSmall).toEqual([]);
  });

  test("the mid-ride toggles are thumb-sized", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      document.body.classList.add("navigating");
      (document.getElementById("nav-banner") as HTMLElement).style.display = "block";
    });
    for (const id of ["nav-net", "nav-myway", "nav-hazard"]) {
      const b = await page.locator(`#${id}`).boundingBox();
      expect(b?.height ?? 0, `${id} is ${b?.height} px tall`).toBeGreaterThanOrEqual(44);
    }
  });

  test("a hint in the panel is not hidden along with the intro blurb", async ({ page }) => {
    // "#panel .hint { display:none }", meant for the intro, also hid the voice
    // test's verdict and the backup's confirmation — on the one device where
    // they matter
    await boot(page);
    await page.locator("summary", { hasText: "Voice" }).click();
    await page.evaluate(() => {
      (document.getElementById("voice-status") as HTMLElement).textContent = "✓ spoken";
    });
    await expect(page.locator("#voice-status")).toBeVisible();
  });

  test("the title is off the screen but not out of the page", async ({ page }) => {
    await boot(page);
    // a screen reader's "next heading" and "main" had nothing to land on
    await expect(page.getByRole("heading", { name: "Family Bike Router" })).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    const h1 = await rect(page, "#panel h1");
    expect(h1.bottom - h1.top).toBeLessThanOrEqual(1);
  });

  test("the sheet's handle is a control a keyboard can work", async ({ page }) => {
    await boot(page);
    const handle = page.getByRole("button", { name: /panel size/i });
    await expect(handle).toHaveAttribute("aria-expanded", "false");
    await handle.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#panel")).toHaveClass(/half/);
    await expect(handle).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#panel")).toHaveClass(/full/);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#panel")).toHaveClass(/peek/);
    await expect(handle).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("at a desk", () => {
  test("the data banner is centred over the map, not over the panel", async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 800 });
    await boot(page);
    await page.evaluate(() => {
      (document.getElementById("data-update") as HTMLElement).style.display = "block";
    });
    const banner = await rect(page, "#data-update");
    const panel = await rect(page, "#panel");
    expect(banner.left, "the banner covers the panel").toBeGreaterThanOrEqual(panel.right);
  });

  test("a route is announced, and the options can be chosen from the keyboard", async ({
    page,
  }) => {
    await routed(page);
    // what a screen reader hears when the route lands
    await expect(page.locator("#sr-status")).toContainText(/grade [A-F]: .*\d+ min/);
    await expect(page.getByRole("radiogroup", { name: "Route options" })).toBeVisible();
    const first = page.locator(".option-card").first();
    await expect(first).toHaveAttribute("aria-checked", "true");
    await first.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".option-card").nth(1)).toHaveAttribute("aria-checked", "true");
    // focus stayed with the choice through the repaint
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("option-card")))
      .toBe(true);

    // and the chips on the map
    const chip = page.locator(".opt-chip").first();
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".option-card").first()).toHaveAttribute("aria-checked", "true");
  });

  test("the rider choice shows where the keyboard is, and which is chosen", async ({ page }) => {
    await boot(page);
    await page.locator('#modes input[value="young_kids"]').focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('#modes input[value="older_kids"]')).toBeChecked();
    const pill = (v: string): import("@playwright/test").Locator =>
      page.locator(`#modes input[value="${v}"] + span`);
    expect(await pill("older_kids").evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe(
      "none",
    );
    // the chosen pill is drawn without :has(), which Firefox before 121 lacks
    const bg = (v: string): Promise<string> =>
      pill(v).evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await bg("older_kids")).not.toBe(await bg("solo"));
  });

  test("the loading line and errors are live regions", async ({ page }) => {
    await boot(page);
    await expect(page.locator("#loading")).toHaveAttribute("role", "status");
    await expect(page.locator("#error")).toHaveAttribute("role", "alert");
  });
});
