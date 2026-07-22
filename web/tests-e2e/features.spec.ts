// E2E coverage of the major user journeys, on the real app + real graph.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

async function boot(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
}

function vis(page: Page, layer: string): Promise<string> {
  return page.evaluate(
    (l) => (window._map?.getLayoutProperty(l, "visibility") as string | undefined) ?? "visible",
    layer,
  );
}

async function openSection(page: Page, label: string): Promise<void> {
  const sum = page.locator("summary", { hasText: label }).first();
  const isOpen = await sum.evaluate((el) => (el.parentElement as HTMLDetailsElement).open);
  if (!isOpen) await sum.click();
}


const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

test("avoid lane types shapes the route and the explanation", async ({ page }) => {
  await boot(page, `${DAVIS_KENDALL}&x=lane,sharrow`);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#avoid-lane")).toBeChecked();
  await expect(page.locator("#avoid-summary")).toContainText("avoiding 2");
  await expect(page.locator("#why-list")).toContainText(/Avoiding lane, sharrow/);
});

test("walk budget selector persists into the permalink", async ({ page }) => {
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await openSection(page, "Preferences");
  await page.locator("#walk-max").selectOption("500");
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("wk=500");
});

test("dark mode, aerial view, and 3D toggles drive the map", async ({ page }) => {
  await boot(page);
  await openSection(page, "Map layers");
  await page.locator("#dark-mode").check();
  await expect(page.locator("body")).toHaveClass(/dark/);
  expect(await vis(page, "osm-dark")).toBe("visible");
  await page.locator("#show-aerial").check();
  expect(await vis(page, "aerial")).toBe("visible");
  expect(await vis(page, "network-casing")).toBe("visible"); // contrast halo
  await page.locator("#show-heat").check();
  await page.locator("#show-3d").check();
  await page.waitForFunction(() => (window._map?.getPitch() ?? 0) > 30);
  expect(await vis(page, "heatmap-3d")).toBe("visible");
  expect(await vis(page, "heatmap")).toBe("none");
});

test("construction layer is on by default with real permits", async ({ page }) => {
  await boot(page);
  await page.waitForFunction(
    () =>
      (window._map?.queryRenderedFeatures(undefined, { layers: ["construction-pts"] }).length ??
        0) > 0,
    null,
    { timeout: 20_000 },
  );
});

test("save a place via right-click and use it as start", async ({ page }) => {
  await boot(page);
  page.once("dialog", (d) => void d.accept("Test Home"));
  // right-click on a street: project a rendered network feature to screen
  const pt = await page.evaluate(() => {
    const map = window._map;
    if (!map) return null;
    for (const f of map.queryRenderedFeatures(undefined, { layers: ["network-hit"] })) {
      if (f.geometry.type !== "LineString") continue;
      const [lon, lat] = f.geometry.coordinates[0] as [number, number];
      const p = map.project([lon, lat]);
      if (p.x > 380 && p.x < 1150 && p.y > 60 && p.y < 750) return { x: p.x, y: p.y };
    }
    return null;
  });
  expect(pt).not.toBeNull();
  if (!pt) return;
  await page.mouse.click(pt.x, pt.y, { button: "right" });
  await page.getByText("☆ save place…").click();
  await expect(page.locator("#places-list")).toContainText("🏠 Test Home");
  await page.locator("#places-list button", { hasText: "start" }).first().click();
  // a start marker appears (permalinks only form once start AND end exist)
  await expect(page.locator(".maplibregl-marker").first()).toBeVisible();
});

test("recent routes appear and replan on tap", async ({ page }) => {
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#recent-list")).toContainText("recent routes");
  await page.locator("#reset").click();
  await page.locator("#recent-list span").first().click();
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
});

test("loop planner builds a round trip from a start point", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748");
  await openSection(page, "Other trip types");
  await page.locator("#loop-btn").click();
  await expect(page.locator(".option-card", { hasText: "Loop via" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("#s-dist")).toContainText("km");
});

test("reach map floods from a clicked point", async ({ page }) => {
  await boot(page);
  await openSection(page, "Other trip types");
  await page.locator("#shed-btn").click();
  await page.mouse.click(700, 400);
  await expect(page.locator("#shed-info")).toContainText(/reachable/, { timeout: 30_000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["shed"] }).length ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(10);
});

test("hovering a street shows the safety card with a grade", async ({ page }) => {
  await boot(page);
  const pts = await page.evaluate(() => {
    const map = window._map;
    if (!map) return [];
    const all = map.queryRenderedFeatures(undefined, { layers: ["network-hit"] });
    // qRF returns tile order (west first, behind the panel) — stride across
    const stride = Math.max(1, Math.floor(all.length / 60));
    return all
      .filter((_, i) => i % stride === 0)
      .flatMap((f) => {
        if (f.geometry.type !== "LineString") return [];
        // any on-screen vertex clear of the panel will do
        return f.geometry.coordinates
          .map((c) => map.project(c as [number, number]))
          .filter((p) => p.x > 380 && p.x < 1150 && p.y > 60 && p.y < 750)
          .map((p) => ({ x: p.x, y: p.y }));
      });
  });
  expect(pts.length).toBeGreaterThan(0);
  let shown = false;
  for (const pt of pts) {
    await page.mouse.move(pt.x, pt.y, { steps: 3 });
    try {
      await expect(page.locator(".maplibregl-popup").first()).toBeVisible({ timeout: 3000 });
      shown = true;
      break;
    } catch {
      // line may be under another marker at this pixel — try the next one
    }
  }
  expect(shown).toBe(true);
  await expect(page.locator(".maplibregl-popup").first()).toContainText(/kid-stress|off-street/);
});

test("GPX download produces a track file", async ({ page }) => {
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await openSection(page, "Export");
  const downloadP = page.waitForEvent("download");
  await page.locator("#gpx").click();
  const download = await downloadP;
  expect(download.suggestedFilename()).toBe("family-bike-route.gpx");
});

test("about and rides dialogs open with live content", async ({ page }) => {
  await boot(page);
  await page.locator("#about-btn").click();
  await expect(page.locator("#about")).toBeVisible();
  await expect(page.locator("#mult-table")).toContainText("busy street");
  await expect(page.locator("#built-date")).not.toContainText("…");
  await page.locator("#about-close").click();
  await page.locator("#rides-btn").click();
  await expect(page.locator("#ride-totals")).toContainText(/No rides yet|rides/);
});

test("phone layout collapses the panel to a bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await expect(page.locator("#panel-collapse")).toBeVisible();
  await page.locator("#panel-collapse").click();
  await expect(page.locator("#panel")).toHaveClass(/collapsed/);
});
