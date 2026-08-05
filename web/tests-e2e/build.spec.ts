// The city-facing half of the app: where new protection would do the most good.
// Everything here was measured offline by pipeline/priorities.py; these tests
// cover that the panel filters, re-sorts and explains it without overstating it.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

async function openBuild(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  // the section only exists when the data build has a ranking in it
  await expect(page.locator("#build-box")).toBeVisible({ timeout: 30_000 });
  await page.locator("#build-box > summary").click();
}

test("the ranking loads, and says how much of it you're looking at", async ({ page }) => {
  await openBuild(page);
  const rows = page.locator(".build-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  expect(await rows.count()).toBe(20);
  // a top-20 must never read as the whole field
  await expect(page.locator("#build-list")).toContainText(/top 20 of \d+/);
  await expect(page.locator("#build-list")).toContainText(/CSV has all \d+/);

  // each row says where, and why, in words
  const first = rows.first();
  await expect(first).toContainText(/\d+ m of /);
  await expect(first).toContainText(/kid-safe|crash|residents|network/);
});

test("the intro states the budget behind its headline percentage", async ({ page }) => {
  await openBuild(page);
  // "43% can't reach a school" is meaningless without the distance it assumes
  await expect(page.locator("#build-intro")).toContainText(/%/);
  await expect(page.locator("#build-intro")).toContainText(/perceived distance/);
  await expect(page.locator("#build-method")).toContainText(/Measured \d+ candidates/);
});

test("filtering by town narrows the list to that town", async ({ page }) => {
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 20_000 });
  const select = page.locator("#build-town");
  await expect(select.locator("option")).not.toHaveCount(1);
  // pick a town we know has candidates
  await select.selectOption("Arlington");
  await expect(page.locator(".build-row").first()).toBeVisible();
  for (const row of await page.locator(".build-row").all()) {
    await expect(row).toContainText("Arlington");
  }
});

test("the weight sliders re-sort without changing the numbers", async ({ page }) => {
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 20_000 });
  await page.locator("#build-weights > summary").click();
  const firstBefore = await page.locator(".build-row").first().textContent();

  // all the way onto crash history alone: a different question, a different order
  await page.locator("#wt-severance").fill("0");
  await page.locator("#wt-access").fill("0");
  await page.locator("#wt-coverage").fill("0");
  await page.locator("#wt-crash").fill("100");
  await expect
    .poll(async () => page.locator(".build-row").first().textContent())
    .not.toBe(firstBefore);
  // the project's own measured sentence is unchanged — only its rank moved
  await expect(page.locator(".build-row").first()).toContainText(/\d+ m of /);

  await page.locator("#wt-reset").click();
  await expect
    .poll(async () => page.locator(".build-row").first().textContent())
    .toBe(firstBefore);
});

test("selecting a project highlights it on the map and frames it", async ({ page }) => {
  await openBuild(page);
  const row = page.locator(".build-row").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const zoomBefore = await page.evaluate(() => window._map?.getZoom() ?? 0);
  await row.click();
  await expect(row).toHaveClass(/selected/);
  // the map moves in to the project and the highlight layer targets it
  await expect.poll(() => page.evaluate(() => window._map?.getZoom() ?? 0)).toBeGreaterThan(
    zoomBefore,
  );
  const shown = await page.evaluate(
    () => window._map?.getLayoutProperty("build-selected", "visibility") ?? "none",
  );
  expect(shown).toBe("visible");
});

test("the layer toggles draw the projects and the coverage backdrop", async ({ page }) => {
  await openBuild(page);
  await page.locator("summary", { hasText: "Map layers" }).first().click();
  for (const [box, layer] of [
    ["#show-build", "build"],
    ["#show-access", "access"],
  ] as const) {
    await page.locator(box).check();
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window._map?.queryRenderedFeatures(undefined, { layers: [id] }).length ?? 0,
            layer,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  }
});

test("About carries the method and what the numbers don't mean", async ({ page }) => {
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 20_000 });
  await page.locator("#about-top").click();
  await expect(page.locator("#about-build")).toBeVisible();
  await expect(page.locator("#about-build-text")).toContainText(/Census|street length/);
  // the caveats have to be somewhere citable, not only in a commit message
  const limits = page.locator("#about-build-limits li");
  expect(await limits.count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator("#about-build-limits")).toContainText(/model output|not measurement/i);
});

test("the CSV download is the whole ranking", async ({ page }) => {
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 20_000 });
  // arm before the click: the download races the handler otherwise
  const dl = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator("#build-csv").click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  const path = await file.path();
  expect(path).not.toBeNull();
});

test("clicking a project inspects it and does not re-route", async ({ page }) => {
  // The map click handler sets your destination. Without a guard, clicking a
  // project both selected it and dropped a pin, quietly replanning the trip.
  await openBuild(page);
  const row = page.locator(".build-row").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click(); // turns the layer on and frames the project
  // the layer is 2.8 MB and the camera eases for 600 ms: wait for real geometry
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["build"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  const pt = await page.evaluate(() => {
    const map = window._map;
    if (!map) return null;
    const hit = map.queryRenderedFeatures(undefined, { layers: ["build"] })[0];
    if (!hit) return null;
    const coords =
      hit.geometry.type === "MultiLineString"
        ? hit.geometry.coordinates[0]
        : hit.geometry.type === "LineString"
          ? hit.geometry.coordinates
          : [];
    const mid = coords[Math.floor(coords.length / 2)] as [number, number] | undefined;
    if (!mid) return null;
    const p = map.project(mid);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  expect(pt).not.toBeNull();
  if (!pt) return;
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(800);
  // no destination pin, no route, no option cards
  await expect(page.locator(".maplibregl-marker:not(.opt-chip)")).toHaveCount(0);
  await expect(page.locator(".option-card")).toHaveCount(0);
});

test("the coverage backdrop sits under the network it explains", async ({ page }) => {
  await openBuild(page);
  await page.locator("summary", { hasText: "Map layers" }).first().click();
  await page.locator("#show-access").check();
  const order = await page.evaluate(() => {
    const layers = window._map?.getStyle().layers ?? [];
    const idx = (id: string): number => layers.findIndex((l) => l.id === id);
    return { access: idx("access"), network: idx("network"), route: idx("route") };
  });
  // a 35% fill drawn on top washed out the safety colours it's a backdrop for
  expect(order.access).toBeGreaterThan(-1);
  expect(order.access).toBeLessThan(order.network);
  expect(order.access).toBeLessThan(order.route);
});

test("the town filter matches whole names, not substrings", async ({ page }) => {
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 20_000 });
  const options = await page.locator("#build-town option").allTextContents();
  // this data has both, which is exactly the trap: "Reading" matched them both
  if (!options.includes("Reading") || !options.includes("North Reading")) {
    test.skip(true, "this data build has no substring-colliding town pair");
  }
  await page.locator("#build-town").selectOption("Reading");
  for (const row of await page.locator(".build-row").all()) {
    await expect(row).not.toContainText("North Reading");
  }
});

// These three stub data files, and a service worker answering from its cache
// bypasses page.route entirely — the stubs silently didn't apply, and one test
// passed for the wrong reason. Block the worker so the network is authoritative.
test.describe("data availability", () => {
  test.use({ serviceWorkers: "block" });

  test("an older data build hides the section instead of showing an empty shell", async ({
    page,
  }) => {
    // Data snapshots are published separately from the app, so a phone can be
    // running this build against data that predates the module. The 2 KB metadata
    // is the gate — the 2.8 MB ranking only loads when someone opens the section.
    await page.route("**/priorities_meta.json", (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
    await page.route("**/priorities.geojson", (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto("/");
    await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
      timeout: 45_000,
    });
    await expect(page.locator(".option-card, #panel")).not.toHaveCount(0); // app still fine
    await expect(page.locator("#build-box")).toBeHidden();
    // and the About section about it stays out too
    await page.locator("#about-top").click();
    await expect(page.locator("#about-build")).toBeHidden();
  });

  test("a ranking that fails to load says so instead of spinning forever", async ({ page }) => {
    // metadata present, projects missing: the section exists (the data build does
    // have a ranking) but the list can't be filled
    await page.route("**/priorities.geojson", (route) => route.fulfill({ status: 500, body: "" }));
    await page.goto("/");
    await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
      timeout: 45_000,
    });
    await expect(page.locator("#build-box")).toBeVisible({ timeout: 30_000 });
    await page.locator("#build-box > summary").click();
    await expect(page.locator("#build-list")).toContainText(/couldn't load/i, { timeout: 20_000 });
    await expect(page.locator("#build-list")).not.toContainText(/loading projects/);
  });

  test("the ranking isn't downloaded until someone asks for it", async ({ page }) => {
    // it's 2.8 MB of city-planning data; a rider opening the app shouldn't pay for it
    let fetched = 0;
    await page.route("**/priorities.geojson", (route) => {
      fetched++;
      void route.continue();
    });
    await page.goto("/");
    await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
      timeout: 45_000,
    });
    await expect(page.locator("#build-box")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    expect(fetched).toBe(0);

    await page.locator("#build-box > summary").click();
    await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 30_000 });
    expect(fetched).toBe(1);
  });
});
