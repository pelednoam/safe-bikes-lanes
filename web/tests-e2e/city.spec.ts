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
  // The shape of the problem follows this city's numbers rather than the thesis
  // the module was written around. Assert the RULE against the data, not the
  // sentence Somerville happens to produce today: pinning the sentence fails
  // when the city changes and passes when the threshold breaks.
  const s = (await (await page.request.get("/data/cities/somerville.json")).json())
    .stats as Record<string, number>;
  const strandedShare = (s["pocket_km"] as number) / (s["safe_km"] as number);
  if (strandedShare >= 0.3) {
    await expect(lede).toContainText(/The streets they can use don't join up/);
  } else {
    await expect(lede).toContainText(/Most of the safe network here does join up/);
    await expect(lede).not.toContainText(/don't join up/);
  }
  await expect(page.locator("h1")).toHaveText("Somerville");
});

test("the figures split the network into connected and stranded", async ({ page }) => {
  await openCity(page);
  const figures = page.locator(".figure");
  expect(await figures.count()).toBeGreaterThanOrEqual(4);
  const text = (await page.locator("#figures").textContent()) ?? "";
  expect(text).toMatch(/km/);
  expect(text).toMatch(/reach the wider network/);
  expect(text).toMatch(/cut off from that network, in \d+ pockets/);
});

test("every number the page states in public is the one in its data", async ({ page }) => {
  // The claims are about a real city and are meant to be quoted. Matching them
  // against /\d+/ proves only that something was rendered — these tests used to
  // pass while the headline count was being reconstructed from a rounded
  // percentage, a figure the pipeline never computed. Check the page against
  // its own source instead.
  await openCity(page);
  const s = (await (await page.request.get("/data/cities/somerville.json")).json())
    .stats as Record<string, number>;
  const N = (n: number): string => n.toLocaleString("en-US");

  const lede = (await page.locator("#lede").textContent()) ?? "";
  expect(lede).toContain(`About ${N(s["stranded"] as number)} of Somerville's`);
  expect(lede).toContain(`${N(s["residents"] as number)} residents`);
  expect(lede).toContain(`${String(s["stranded_pct"])}%`);
  // the ride length the whole claim assumes, from the data rather than typed
  // into the page next to a pipeline constant that could drift from it
  expect(lede).toContain(`${String(s["budget_km"])} km ride`);
  // the specific regression: the count must not be the percentage multiplied out
  const recovered = Math.round(
    ((s["residents"] as number) * (s["stranded_pct"] as number)) / 100,
  );
  if (recovered !== s["stranded"]) {
    expect(lede).not.toContain(`About ${N(recovered)} of`);
  }

  const figures = (await page.locator("#figures").textContent()) ?? "";
  expect(figures).toContain(`${String(s["connected_km"])} km`);
  expect(figures).toContain(`${String(s["pocket_km"])} km`);
  expect(figures).toContain(`${String(s["pockets"])} pockets`);
  // how many the city has, not how many were drawn
  expect(figures).toContain(String(s["projects"]));
  if ((s["projects"] as number) > (s["projects_shown"] as number)) {
    expect(figures).toContain(`top ${String(s["projects_shown"])} shown`);
  }
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
  // the caveat this page introduces by cutting a region up along a town line:
  // it names the city beside a resident count it assembled from grid cells
  await expect(page.locator("#limits-list")).toContainText(/grid cell/i);
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
    if (!map) return null;
    // a pixel where only the safe network is drawn: barriers sit above the
    // islands, so a shared pixel legitimately answers about the barrier
    for (const f of map.queryRenderedFeatures(undefined, { layers: ["islands"] })) {
      if (f.geometry.type !== "LineString") continue;
      const mid = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
      const p = map.project(mid as [number, number]);
      const box: [[number, number], [number, number]] = [
        [p.x - 6, p.y - 6],
        [p.x + 6, p.y + 6],
      ];
      if (map.queryRenderedFeatures(box, { layers: ["barriers"] }).length > 0) continue;
      return { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return null;
  });
  expect(pt).not.toBeNull();
  if (!pt) return;
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator(".maplibregl-popup")).toContainText(/Connected|pocket/i, {
    timeout: 10_000,
  });
  // and it still says what the street itself is like
  await expect(page.locator(".maplibregl-popup")).toContainText(/kid-stress ×/);
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

test("hovering a project previews it on the map, without moving the camera", async ({
  page,
}) => {
  await openCity(page);
  const rows = page.locator(".project");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });

  const hovered = async (): Promise<string> =>
    page.evaluate(() => {
      const f = window._map?.getFilter("project-hover") as unknown[] | undefined;
      return String(f?.[2] ?? "");
    });
  const camera = async (): Promise<string> =>
    page.evaluate(() => {
      const c = window._map?.getCenter();
      return `${c?.lng.toFixed(5)},${c?.lat.toFixed(5)},${window._map?.getZoom().toFixed(3)}`;
    });

  expect(await hovered()).toBe("");
  const before = await camera();

  const second = rows.nth(1);
  await second.hover();
  const pid = await second.getAttribute("data-pid");
  await expect.poll(hovered).toBe(pid);
  // scanning the list must not drag the map around under the cursor
  expect(await camera()).toBe(before);

  // moving on clears it
  await page.locator("h1").hover();
  await expect.poll(hovered).toBe("");
});

test("the preview and the selection are independent", async ({ page }) => {
  await openCity(page);
  const rows = page.locator(".project");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await rows.first().click();
  const chosen = await rows.first().getAttribute("data-pid");

  await rows.nth(2).hover();
  const state = await page.evaluate(() => {
    const g = (id: string): string =>
      String((window._map?.getFilter(id) as unknown[] | undefined)?.[2] ?? "");
    return { picked: g("project-hi"), hovered: g("project-hover") };
  });
  // previewing a different one must not lose the one you picked
  expect(state.picked).toBe(chosen);
  expect(state.hovered).not.toBe(chosen);
  await expect(rows.first()).toHaveClass(/on/);
});

test("tabbing through the list previews too", async ({ page }) => {
  await openCity(page);
  const rows = page.locator(".project");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await rows.nth(1).focus();
  await expect
    .poll(() =>
      page.evaluate(
        () => String((window._map?.getFilter("project-hover") as unknown[] | undefined)?.[2] ?? ""),
      ),
    )
    .toBe(await rows.nth(1).getAttribute("data-pid"));
});

test("a street on the city page explains itself the way the planner does", async ({ page }) => {
  // the card is the app's, shared through src/segment.ts: a councillor looking
  // at a red line should get the same account of it a parent gets in the planner
  await openCity(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["barriers"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const pt = await page.evaluate(() => {
    const map = window._map;
    const f = map?.queryRenderedFeatures(undefined, { layers: ["barriers"] })[0];
    if (!map || !f || f.geometry.type !== "LineString") return null;
    const mid = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
    const p = map.project(mid as [number, number]);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  expect(pt).not.toBeNull();
  if (!pt) return;
  await page.mouse.move(pt.x, pt.y);
  const card = page.locator(".maplibregl-popup-content");
  await expect(card).toBeVisible({ timeout: 10_000 });
  // what it is, and what that means for a child — not just a colour
  await expect(card).toContainText(/busy street|moderate street|painted lane|sharrow/);
  await expect(card).toContainText(/traffic|protection/);
  await expect(card).toContainText(/kid-stress ×/);
  // and why it's on this map at all
  await expect(card).toContainText(/barrier/i);
  // the photo slot always settles: a picture, or a plain statement there isn't one
  await expect(card.locator("[data-seg-photo]")).not.toBeEmpty({ timeout: 15_000 });
});

test("moving off a street takes its card away", async ({ page }) => {
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
  if (!pt) return;
  await page.mouse.move(pt.x, pt.y);
  await expect(page.locator(".maplibregl-popup")).toBeVisible({ timeout: 10_000 });
  // an empty patch of map: the card must not follow the pointer around
  await page.mouse.move(5, 830);
  await expect(page.locator(".maplibregl-popup")).toHaveCount(0, { timeout: 10_000 });
});

test("turning off the projects layer also stops the hover preview drawing", async ({ page }) => {
  // the preview is a separate layer; leaving it out of the toggle meant hovering
  // the list drew magenta lines over a layer the reader had just switched off
  await openCity(page);
  await page.locator("#show-projects").uncheck();
  const vis = async (): Promise<string> =>
    await page.evaluate(
      () => window._map?.getLayoutProperty("project-hover", "visibility") as string,
    );
  expect(await vis()).toBe("none");
  await page.locator(".project").first().hover();
  await expect.poll(vis).toBe("none");
  await page.locator("#show-projects").check();
  expect(await vis()).toBe("visible");
});
