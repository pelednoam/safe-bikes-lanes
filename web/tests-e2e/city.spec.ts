// The per-city page: /somerville and friends. A councillor's page, not a tool —
// it has to load a map, say one true thing prominently, and let someone see why
// it's true. Tested separately from the app because it shares no code with it.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

async function openCity(page: Page, slug = "somerville"): Promise<void> {
  await page.goto(`/${slug}/`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
}

test("leads with how many people can't reach a school or park", async ({ page }) => {
  await openCity(page);
  const lede = page.locator("#lede");
  // the count and the share together: 9% sounds small until it's 7,000 people
  await expect(lede).toContainText(/About [\d,]+ of Somerville's [\d,]+ residents/);
  await expect(lede).toContainText(/\d+%/);
  await expect(lede).toContainText(/school, playground or library/);
  // and never without the distance it assumes
  await expect(lede).toContainText(/2\.5 km/);
  // the shape of the problem follows this city's numbers: Somerville's safe
  // network is mostly one piece, so the page must not call it an archipelago
  await expect(lede).toContainText(/Most of the safe network here does join up/);
  await expect(lede).not.toContainText(/don't join up/);
  await expect(page.locator("h1")).toHaveText("Somerville");
});

test("the figures split the network into connected and stranded", async ({ page }) => {
  await openCity(page);
  const figures = page.locator(".figure");
  expect(await figures.count()).toBeGreaterThanOrEqual(4);
  const text = (await page.locator("#figures").textContent()) ?? "";
  expect(text).toMatch(/km/);
  expect(text).toMatch(/reach the wider network/);
  expect(text).toMatch(/stranded in \d+ pockets/);
});

test("the map draws the archipelago: pockets in their own colours", async ({ page }) => {
  await openCity(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["islands"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // more than one island rank is on screen, or the picture says nothing
  const ranks = await page.evaluate(() => {
    const feats = window._map?.queryRenderedFeatures(undefined, { layers: ["islands"] }) ?? [];
    return [...new Set(feats.map((f) => (f.properties as { isle?: number }).isle))];
  });
  expect(ranks.length).toBeGreaterThan(1);
  expect(ranks).toContain(0); // the network that leaves the city

  // and the barriers that cut them apart are drawn too
  await expect
    .poll(() =>
      page.evaluate(
        () => window._map?.queryRenderedFeatures(undefined, { layers: ["barriers"] }).length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
});

test("every layer can be turned off and back on", async ({ page }) => {
  await openCity(page);
  for (const [box, layer] of [
    ["#show-islands", "islands"],
    ["#show-barriers", "barriers"],
    ["#show-projects", "projects"],
    ["#show-access", "access"],
  ] as const) {
    const input = page.locator(box);
    const was = await input.isChecked();
    await input.setChecked(!was);
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window._map?.getLayoutProperty(id, "visibility") ?? "visible",
          layer,
        ),
      )
      .toBe(was ? "none" : "visible");
  }
});

test("a project can be picked from the list and is shown on the map", async ({ page }) => {
  await openCity(page);
  const rows = page.locator(".project");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  expect(await rows.count()).toBeGreaterThan(3);
  await expect(rows.first()).toContainText(/\d+ m of /);

  const zoomBefore = await page.evaluate(() => window._map?.getZoom() ?? 0);
  await rows.first().click();
  await expect(rows.first()).toHaveClass(/on/);
  await expect.poll(() => page.evaluate(() => window._map?.getZoom() ?? 0)).toBeGreaterThan(
    zoomBefore,
  );
});

test("it says how it was worked out and what it doesn't mean", async ({ page }) => {
  await openCity(page);
  await page.locator("details.limits summary").click();
  await expect(page.locator("details.limits")).toContainText(/protection class/i);
  const limits = page.locator("#limits-list li");
  expect(await limits.count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator("#limits-list")).toContainText(/model output|not measurement/i);
  await expect(page.locator("#built")).not.toHaveText("—");
});

test("a city we haven't generated says so instead of breaking", async ({ page }) => {
  await page.goto("/somerville/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 45_000 });
  // same page, a slug with no data behind it
  await page.route("**/data/cities/*.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.reload();
  await expect(page.locator("body")).toContainText(/No page for that city yet/i, {
    timeout: 30_000,
  });
  await expect(page.locator("a[href='../']")).toBeVisible();
});

test("on a phone the map is looking at the city, not the planet", async ({ page }) => {
  // A fixed 400 px left pad for the desktop panel is wider than a 390 px phone,
  // and MapLibre answered that by framing the whole world. Every feature test
  // still passed, because features rendered — just nowhere near Somerville.
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  const view = await page.evaluate(() => {
    const c = window._map?.getCenter();
    return { zoom: window._map?.getZoom() ?? 0, lon: c?.lng ?? 0, lat: c?.lat ?? 0 };
  });
  // Somerville is about 6 km across: anything below z11 is not this city
  expect(view.zoom).toBeGreaterThan(11);
  expect(view.lon).toBeGreaterThan(-71.2);
  expect(view.lon).toBeLessThan(-71.0);
  expect(view.lat).toBeGreaterThan(42.3);
  expect(view.lat).toBeLessThan(42.5);
});

test("tapping a piece of the network says what it is, without a mouse", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["islands"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const pt = await page.evaluate(() => {
    const map = window._map;
    const f = map?.queryRenderedFeatures(undefined, { layers: ["islands"] })[0];
    if (!map || !f || f.geometry.type !== "LineString") return null;
    const mid = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
    const p = map.project(mid as [number, number]);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  expect(pt).not.toBeNull();
  if (!pt) return;
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator(".maplibregl-popup")).toContainText(/Connected|pocket/i, {
    timeout: 10_000,
  });
});

test("the project list is reachable by keyboard", async ({ page }) => {
  await openCity(page);
  const first = page.locator(".project").first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(first).toHaveClass(/on/);
});
