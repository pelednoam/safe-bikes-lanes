// E2E: the app boots without errors and the map layers respond to toggles.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

async function boot(page: import("@playwright/test").Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  return errors;
}

function vis(page: import("@playwright/test").Page, layer: string): Promise<string> {
  return page.evaluate(
    (l) => (window._map?.getLayoutProperty(l, "visibility") as string | undefined) ?? "visible",
    layer,
  );
}

test("boots cleanly and network layers render", async ({ page }) => {
  const errors = await boot(page);
  expect(errors).toEqual([]);
  expect(await vis(page, "network")).toBe("visible");
  const rendered = await page.evaluate(
    () => window._map?.queryRenderedFeatures(undefined, { layers: ["network"] }).length ?? 0,
  );
  expect(rendered).toBeGreaterThan(50);
});

test("safety network toggle hides and restores the layers", async ({ page }) => {
  const errors = await boot(page);
  await page.locator("#show-net").click();
  expect(await vis(page, "network")).toBe("none");
  expect(await vis(page, "network-unconfirmed")).toBe("none");
  await page.locator("#show-net").click();
  expect(await vis(page, "network")).toBe("visible");
  expect(await vis(page, "network-unconfirmed")).toBe("visible");
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["network"] }).length ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test("area overlays are mutually exclusive and render", async ({ page }) => {
  await boot(page);
  await page.locator("#show-lanes").click();
  expect(await vis(page, "lanemap")).toBe("visible");
  await page.locator("#show-heat").click();
  expect(await vis(page, "heatmap")).toBe("visible");
  expect(await vis(page, "lanemap")).toBe("none");
  await expect(page.locator("#show-lanes")).not.toBeChecked();
});

test("route planning end to end on the real graph", async ({ page }) => {
  // Davis Sq -> Kendall via a fresh permalink load (the app reads the hash at boot)
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  const cards = await page.locator(".option-card").count();
  expect(cards).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#s-dist")).toContainText("km");
  await expect(page.locator("#why-list li").first()).toBeVisible();
});
