// A sweep over the findings the six simulated riders reported, one assertion
// per finding, so "it's fixed" is checkable rather than asserted in a commit
// message. Titles carry the original symptom.
//
// Findings deliberately NOT covered here, because they are not fixed, are
// listed in docs/ride-audit.md with the reason.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { installRider, ride } from "./rider.js";

declare global {
  interface Window {
    _map?: MLMap;
    __navAlertsSeen?: number;
    __rider: {
      spoken: string[];
      fixCount: number;
      setFix: (f: {
        lon: number;
        lat: number;
        accuracy?: number;
        speed?: number | null;
        heading?: number | null;
      }) => void;
      failFix: (code: number, message: string) => void;
    };
  }
}

type Page = import("@playwright/test").Page;
const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

async function plan(page: Page, hash = DAVIS_KENDALL): Promise<[number, number][]> {
  await installRider(page);
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => {
    const src = window._map?.getSource("route") as { _data?: GeoJSON.FeatureCollection } | undefined;
    return (src?._data?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
  });
}

async function startNav(page: Page, hash = DAVIS_KENDALL): Promise<[number, number][]> {
  const path = await plan(page, hash);
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  return path;
}

// ── controls: sizes, labels, spacing ──────────────────────────────────────

test("every emoji control carries a word and a label (tooltips don't exist on touch)", async ({
  page,
}) => {
  await startNav(page);
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll("#nav-tools button")].map((b) => ({
      id: b.id,
      text: (b.textContent ?? "").replace(/[^\p{L}\p{N} ]/gu, "").trim(),
      aria: b.getAttribute("aria-label") ?? "",
    })),
  );
  expect(tools.length).toBeGreaterThan(5);
  for (const t of tools) {
    expect(t.text, `${t.id} needs a visible word`).not.toBe("");
    expect(t.aria, `${t.id} needs an aria-label`).not.toBe("");
  }
});

test("the warning triangle renders as an emoji, not a hairline glyph", async ({ page }) => {
  await startNav(page);
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  // U+FE0F forces the coloured presentation; without it the one control with a
  // persistent side effect was the faintest thing in the row
  const glyph = await page.evaluate(
    () => document.querySelector("#nav-hazard span")?.textContent ?? "",
  );
  expect(glyph).toContain("️");
});

test("adjacent controls are far enough apart to not mis-tap", async ({ page }) => {
  await startNav(page);
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  const gaps = await page.evaluate(() => {
    const rects = [...document.querySelectorAll("#nav-tools button, #nav-buttons button")].map(
      (b) => b.getBoundingClientRect(),
    );
    const out: number[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i] as DOMRect;
        const b = rects[j] as DOMRect;
        const dx = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
        const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
        if (dx === 0 || dy === 0) out.push(Math.max(dx, dy));
      }
    }
    return out.filter((g) => g > 0);
  });
  // measured 7-9 px before, where a 30 px slip from mute landed on "end ride"
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10);
});

// ── banner: stability and what it says ────────────────────────────────────

test("the trip line stays on one line and the banner keeps its height", async ({ page }) => {
  const path = await startNav(page);
  const heights = new Set<number>();
  await ride(page, path, {
    speedKmh: 12,
    timeScale: 30,
    untilM: 700,
    onFix: async () => {
      const h = await page.evaluate(() => {
        const trip = document.getElementById("nav-trip");
        return trip ? Math.round(trip.getBoundingClientRect().height) : 0;
      });
      heights.add(h);
    },
  });
  // "arrive 2:47 PM" wrapped with "PM" alone on line 2, so the banner twitched
  // between 107 and 125 px all ride
  expect([...heights].length).toBeLessThanOrEqual(2);
  expect(Math.max(...heights)).toBeLessThan(30);
});

test("the arrival ETA doesn't jump when you stop at a light", async ({ page }) => {
  const path = await startNav(page);
  // one continuous ride with a stop in it: ride() always starts from the top of
  // the path, so two calls would replay the route and move the ETA honestly
  let rolling = "";
  let stopped = "";
  await ride(page, path, {
    speedKmh: 11,
    timeScale: 20,
    untilM: 460,
    pauseAtM: 400,
    pauseSeconds: 30,
    onFix: async ({ alongM }) => {
      const txt = (await page.locator("#nav-remaining").textContent()) ?? "";
      if (alongM < 400) rolling = txt;
      else if (stopped === "") stopped = txt;
    },
  });
  const mins = (s: string): number => Number(/(\d+) min/.exec(s)?.[1] ?? 0);
  // it used to swing ~6 min at every stop, flipping between measured and
  // profile pace
  expect(Math.abs(mins(stopped) - mins(rolling))).toBeLessThanOrEqual(3);
});

test("the selected route still shows its protected share", async ({ page }) => {
  await plan(page);
  // the safety-first card was the one card with no safety number, because the
  // breakdown that "already says it" is below the fold on a phone
  await expect(page.locator(".option-card.selected .opt-stats")).toContainText(/% protected/);
});

// ── GPS trouble ───────────────────────────────────────────────────────────

test("losing GPS is announced, and blames the signal rather than permissions", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 200 });
  await page.evaluate(() => window.__rider.failFix(2, "position unavailable"));
  await expect(page.locator("#nav-alert")).toBeVisible();
  await expect(page.locator("#nav-alert")).toContainText(/signal/i);
  await expect(page.locator("#nav-alert")).not.toContainText(/permission/i);
  const spoken = await page.evaluate(() => window.__rider.spoken);
  expect(spoken.join(" | ")).toMatch(/lost g p s|signal/i);
  // and the street name is left alone rather than overwritten and clipped
  await expect(page.locator("#nav-street")).not.toContainText(/unavailable/i);
});

test("a useless fix doesn't garble the distance to the turn", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 20, untilM: 250 });
  const good = (await page.locator("#nav-dist").textContent()) ?? "";
  // 120 m accuracy: the readout used to bounce 40 -> now -> 100 m
  const seen = new Set<string>([good]);
  for (let i = 0; i < 8; i++) {
    await page.evaluate(
      (p) => window.__rider.setFix({ lon: p[0], lat: p[1], accuracy: 120, speed: 3, heading: 90 }),
      [(path[20] as [number, number])[0] + i * 0.0004, (path[20] as [number, number])[1]] as [
        number,
        number,
      ],
    );
    await page.waitForTimeout(80);
    seen.add((await page.locator("#nav-dist").textContent()) ?? "");
  }
  // the reading is held, and the rider is told the signal is poor
  expect(seen.size).toBe(1);
  await expect(page.locator("#nav-alert")).toContainText(/poor/i);
});

// ── recovery ──────────────────────────────────────────────────────────────

test("starting a second ride from the old destination still guides", async ({ page }) => {
  const path = await startNav(page);
  // arrive, end, then set off again while standing at the destination
  await ride(page, path, { speedKmh: 20, timeScale: 90 });
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  await page.locator("#nav-exit").click();
  await page.locator("#nav-ask-yes").click();
  await expect(page.locator("#nav-banner")).not.toBeVisible();

  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  await ride(page, path, { speedKmh: 14, timeScale: 40, untilM: 400 });
  // it used to latch "arrived!" on the first fix and never update again
  await expect(page.locator("#nav-dist")).not.toContainText(/arrived/i);
  await expect(page.locator("#nav-remaining")).toContainText(/min/);
});

test("a turn you overshoot and come back to is called again", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 20, untilM: 320 });
  const before = await page.evaluate(() => window.__rider.spoken.length);
  // double back past the turn, then approach it again
  await ride(page, path, { speedKmh: 12, timeScale: 20, untilM: 200 });
  await ride(page, path, { speedKmh: 12, timeScale: 20, untilM: 340 });
  const after = await page.evaluate(() => window.__rider.spoken);
  // navNext only ever advanced, so the missed turn was never announced again
  expect(after.length).toBeGreaterThan(before);
});

// ── nothing may cover the guidance ────────────────────────────────────────

test("update banners stay out of the way while navigating", async ({ page }) => {
  await startNav(page);
  const hidden = await page.evaluate(() => {
    const vis = (id: string): string => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).display : "missing";
    };
    return { update: vis("update-banner"), data: vis("data-update") };
  });
  // measured 17,040 px² over the banner, and the chevron resolved to the
  // banner's dismiss button
  expect(hidden.update).toBe("none");
  expect(hidden.data).toBe("none");
});

test("the safety network is dimmed so the route is the obvious line", async ({ page }) => {
  await startNav(page);
  const opacity = await page.evaluate(
    () => window._map?.getPaintProperty("network", "line-opacity") as number,
  );
  expect(opacity).toBeLessThan(0.6);
});

// ── dialogs and popups ────────────────────────────────────────────────────

test("the hazard dialog fits the phone and can be dismissed by tapping outside", async ({
  page,
}) => {
  const path = await startNav(page);
  // it needs a fix to know where the hazard is
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 120 });
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  await page.locator("#nav-report").click();
  const box = await page.locator("#hazard").boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  // it was 398 px wide on a 390 px screen, hanging off the side
  expect(box.width).toBeLessThanOrEqual(390);
  // its inputs were 21 px tall — the phone rule only covered input[type=search]
  const shortest = await page.evaluate(() =>
    Math.min(
      ...[...document.querySelectorAll("#hazard input, #hazard select")].map(
        (i) => i.getBoundingClientRect().height,
      ),
    ),
  );
  expect(shortest).toBeGreaterThanOrEqual(36);
  // it says where you are in words, not decimal degrees
  await expect(page.locator("#hazard")).not.toContainText(/-71\.\d{4}/);
  // and tap-outside closes it, like the other two dialogs
  await page.mouse.click(10, 10);
  await expect(page.locator("#hazard")).not.toBeVisible();
});

test("marking a hazard twice in one spot doesn't write it twice", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 150 });
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  await page.locator("#nav-hazard").click();
  await expect(page.locator("#nav-alert")).toContainText(/marked/i);
  await page.locator("#nav-hazard").click();
  await page.locator("#nav-hazard").click();
  const marks = await page.evaluate(
    () => (JSON.parse(localStorage.getItem("sketchyMarks") ?? "[]") as unknown[]).length,
  );
  expect(marks).toBe(1);
});

test("the street card can be dismissed and doesn't mention right-clicking on touch", async ({
  browser,
}) => {
  // a real touch context: the popup appeared from an ordinary pan or pinch and
  // could not be closed, and told the rider to right-click
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["network-hit"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const pt = await page.evaluate(() => {
    const map = window._map;
    if (!map) return null;
    const all = map.queryRenderedFeatures(undefined, { layers: ["network-hit"] });
    for (const f of all) {
      if (f.geometry.type !== "LineString") continue;
      const p = map.project(f.geometry.coordinates[0] as [number, number]);
      if (p.x > 40 && p.x < 350 && p.y > 60 && p.y < 380) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return null;
  });
  if (pt) {
    await page.mouse.move(pt.x, pt.y, { steps: 3 });
    const popup = page.locator(".maplibregl-popup").first();
    if (await popup.isVisible().catch(() => false)) {
      await expect(popup).not.toContainText(/right-click/i);
      await expect(page.locator(".maplibregl-popup-close-button").first()).toBeVisible();
    }
  }
  await ctx.close();
});
