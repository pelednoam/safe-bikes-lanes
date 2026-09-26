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

test.describe("the sheet on a phone", () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  /** Is the element fully inside both the screen and the sheet's visible part? */
  const inView = (page: Page, sel: string): Promise<boolean> =>
    page.evaluate((s) => {
      const e = document.querySelector(s);
      const panel = document.getElementById("panel");
      if (e === null || panel === null) return false;
      const r = e.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return r.height > 0 && r.top >= p.top && r.bottom <= Math.min(p.bottom, innerHeight);
    }, sel);

  test("a route's answer is what the sheet shows once it lands", async ({ page }) => {
    // "3 ROUTE OPTIONS" started at y=784 of 820, below the round-trip block,
    // Recent routes and the rider switch; the grade and ▶ Navigate needed a
    // scroll nothing hinted at
    await routed(page);
    await expect.poll(() => inView(page, ".option-card.selected")).toBe(true);
    expect(await inView(page, "#nav-btn"), "▶ Navigate is below the fold").toBe(true);
    // and the handle is still there to pull the sheet up or down
    expect(await inView(page, "#sheet-handle")).toBe(true);
  });

  test("re-planning the same trip leaves the reader where they were", async ({ page }) => {
    // the guard on the test above: only a new trip brings the options up, so
    // changing a preference further down is not answered by a jump away from it
    await routed(page);
    await page.locator("summary", { hasText: "Preferences" }).click();
    const flat = page.locator("#prefer-flat");
    await flat.scrollIntoViewIfNeeded();
    await flat.check();
    await expect(page.locator("#loading")).toBeHidden({ timeout: budget(30_000) });
    await page.waitForTimeout(1000); // the panel repaints once the line is drawn
    expect(await inView(page, "#prefer-flat"), "the sheet jumped away from the preference").toBe(
      true,
    );
  });

  test("searching opens the sheet at once, not over an animation", async ({ page }) => {
    // with the 0.2 s transition the field was lifted while the sheet was still
    // growing, and iOS scrolled the focused field on its own timing
    await boot(page);
    const firstFrame = await page.evaluate(async () => {
      (document.getElementById("search") as HTMLInputElement).focus();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const panel = (document.getElementById("panel") as HTMLElement).getBoundingClientRect();
      const field = (document.getElementById("search") as HTMLElement).getBoundingClientRect();
      return { height: panel.height, fieldTop: field.top };
    });
    expect(firstFrame.height).toBeGreaterThan(820 * 0.8);
    expect(firstFrame.fieldTop).toBeLessThan(820 * 0.3);
  });

  test("a page left scrolled by the keyboard is put back", async ({ page }) => {
    await boot(page);
    // what iOS leaves behind: the page itself scrolled to lift a focused field
    await page.evaluate(() => {
      const tall = document.createElement("div");
      tall.style.cssText = "position:absolute;top:0;left:0;width:1px;height:3000px";
      document.body.appendChild(tall);
    });
    await page.locator("#search").focus();
    await page.evaluate(() => window.scrollTo(0, 300));
    expect(await page.evaluate(() => window.scrollY)).toBe(300);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
});

/** WCAG contrast of two computed CSS colours ("rgb(…)" / "rgba(…)"). */
function contrast(a: string, b: string): number {
  const lum = (c: string): number => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).map(Number).map((v) => v / 255);
    const f = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(bl ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

test.describe("read outdoors", () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  test("the grade letters can be read on their colours", async ({ page }) => {
    await routed(page);
    const pairs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".option-card .grade, .opt-chip")].map((e) => {
        const s = getComputedStyle(e);
        return { text: e.textContent ?? "", fg: s.color, bg: s.backgroundColor, px: s.fontSize };
      }),
    );
    expect(pairs.length).toBeGreaterThan(3);
    for (const p of pairs) {
      expect(contrast(p.fg, p.bg), `"${p.text}" ${p.fg} on ${p.bg}`).toBeGreaterThanOrEqual(4.5);
      expect(parseFloat(p.px), `"${p.text}" is ${p.px}`).toBeGreaterThanOrEqual(13);
    }
  });

  test("no text in the panel or on the dock is too small to read", async ({ page }) => {
    await routed(page);
    await page.evaluate(() => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>("#panel details")) d.open = true;
      document.body.classList.add("navigating"); // the dock, too
    });
    const tiny = await page.evaluate(() => {
      const out: string[] = [];
      const roots = [document.getElementById("panel"), document.getElementById("ride-dock")];
      for (const root of roots) {
        if (root === null) continue;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const text = (n.textContent ?? "").trim();
          const e = n.parentElement;
          if (text === "" || e === null) continue;
          const r = e.getBoundingClientRect();
          if (r.width <= 1 || r.height <= 1) continue; // not on screen (or screen-reader only)
          const px = parseFloat(getComputedStyle(e).fontSize);
          if (px < 11 || (px < 12 && !e.closest("#ride-dock"))) out.push(`${text.slice(0, 24)} ${px}px`);
        }
      }
      return out;
    });
    // the panel's floor is 12 px; the dock's labels sit under a 24 px icon on a
    // 64 px button and get 11
    expect(tiny).toEqual([]);
  });
});

test.describe("at night", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("darkMode", "1"));
  });

  test("native controls, links and buttons follow dark mode", async ({ page }) => {
    await boot(page);
    // the round-trip distance, stop and preference fields were white boxes
    const field = await page
      .locator("#loop-dist")
      .evaluate((e) => ({ scheme: getComputedStyle(e).colorScheme, bg: getComputedStyle(e).backgroundColor }));
    expect(field.scheme).toContain("dark");
    expect(contrast(field.bg, "rgb(255,255,255)"), "the field is still white").toBeGreaterThan(3);

    const primary = await page
      .locator("#loop-btn")
      .evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
    expect(contrast(primary[0] ?? "", primary[1] ?? "")).toBeGreaterThanOrEqual(4.5);

    const ctrl = await page
      .locator(".maplibregl-ctrl-group")
      .first()
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(contrast(ctrl, "rgb(255,255,255)"), "MapLibre's buttons are still white").toBeGreaterThan(3);

    await page.locator("#about-top").click();
    const link = await page
      .locator("#about a")
      .first()
      .evaluate((e) => getComputedStyle(e).color);
    const dialogBg = await page.locator("#about").evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(contrast(link, dialogBg)).toBeGreaterThanOrEqual(4.5);
  });

  test("the layer list says what dark mode actually does", async ({ page }) => {
    // it claimed to follow the system setting; the code deliberately does not
    await boot(page);
    await expect(page.locator("label.toggle", { hasText: "dark mode" })).not.toContainText(
      /system setting at first/,
    );
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
    // (polled: the pill's background eases in over 0.16 s)
    await expect.poll(() => bg("older_kids")).not.toBe(await bg("solo"));
  });

  test("the loading line and errors are live regions", async ({ page }) => {
    await boot(page);
    await expect(page.locator("#loading")).toHaveAttribute("role", "status");
    await expect(page.locator("#error")).toHaveAttribute("role", "alert");
  });
});
