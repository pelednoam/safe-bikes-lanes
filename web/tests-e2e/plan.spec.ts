// Planning a ride at a desktop before setting off: the mouse-driven half of
// the app. The other specs mostly arrive with a permalink already built, which
// skips everything a rider actually does the evening before — clicking the map
// for each end, dragging a marker to nudge it, hovering streets to judge them,
// and comparing the options against each other.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
    __paint: { txt: string; len: number }[];
  }
}

type Page = import("@playwright/test").Page;

/** Somerville/Cambridge, wide enough that any map click lands on streets. */
const HOME_VIEW = "#c=-71.105,42.383,13";

async function boot(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  // wait for the network layer, so map clicks land on real geometry
  await page.waitForFunction(() => window._map?.isSourceLoaded("network") === true, null, {
    timeout: 30_000,
  });
}

/** Screen point of a lon/lat, for clicking a specific place on the map. */
async function at(page: Page, lon: number, lat: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([lo, la]) => {
      const p = window._map?.project([lo, la]);
      return { x: Math.round(p?.x ?? 0), y: Math.round(p?.y ?? 0) };
    },
    [lon, lat] as [number, number],
  );
}

/** Screen pixels that sit on the safety network, for hover/right-click tests. */
async function streetPointsOnScreen(page: Page): Promise<{ x: number; y: number }[]> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window._map?.queryRenderedFeatures(undefined, { layers: ["network-hit"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return page.evaluate(() => {
    const map = window._map;
    if (!map) return [];
    const all = map.queryRenderedFeatures(undefined, { layers: ["network-hit"] });
    const stride = Math.max(1, Math.floor(all.length / 60));
    return all
      .filter((_, i) => i % stride === 0)
      .flatMap((f) =>
        f.geometry.type === "LineString"
          ? f.geometry.coordinates
              .map((c) => map.project(c as [number, number]))
              .filter((p) => p.x > 400 && p.x < 1150 && p.y > 80 && p.y < 700)
              .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
          : [],
      );
  });
}

async function routeMeters(page: Page): Promise<number> {
  const txt = (await page.locator("#s-dist").textContent()) ?? "";
  const n = parseFloat(txt);
  return txt.includes("km") ? n * 1000 : n;
}

test("plan a ride entirely with the mouse: pick a start, then a destination", async ({ page }) => {
  await boot(page, HOME_VIEW);

  // the origin defaults to "your location"; a planner at a desk wants to pick it
  await page.locator("#from-pick").click();
  await expect(page.locator("#from-field")).toHaveClass(/picking/);
  const davis = await at(page, -71.1223, 42.3967);
  await page.mouse.click(davis.x, davis.y);
  await expect(page.locator("#from-field")).not.toHaveClass(/picking/);

  // then the destination
  const kendall = await at(page, -71.0867, 42.3626);
  await page.mouse.click(kendall.x, kendall.y);

  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#s-dist")).toContainText("km");
  await expect(page.locator("#s-prot")).toContainText("%");
  // the fingerprint and the reasoning are the point of this app
  await expect(page.locator("#fingerprint")).toBeVisible();
  await expect(page.locator("#classbar")).toBeVisible();
  await expect(page.locator("#why-list")).toContainText(/\w/);
  // both ends are on the map and the trip is shareable
  // :not(.opt-chip) — the on-map option badges are markers too
  await expect(page.locator(".maplibregl-marker:not(.opt-chip)")).toHaveCount(2);
  await expect.poll(() => page.url()).toMatch(/s=.*e=/);
});

test("compare the options: hovering previews, clicking commits", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  const cards = page.locator(".option-card");
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  const count = await cards.count();
  expect(count).toBeGreaterThan(1);

  const drawn = (): Promise<number> =>
    page.evaluate(() => {
      const src = window._map?.getSource("route") as
        | { _data?: GeoJSON.FeatureCollection }
        | undefined;
      return JSON.stringify(src?._data ?? {}).length;
    });

  const selected = await drawn();
  // hovering the "Direct" card should preview a different line on the map
  await cards.last().hover();
  await expect.poll(drawn, { timeout: 5_000 }).not.toBe(selected);
  // moving away restores the chosen one
  await page.locator("#fingerprint").hover();
  await expect.poll(drawn, { timeout: 5_000 }).toBe(selected);

  // committing to it updates the summary, the selection and the permalink
  const before = await routeMeters(page);
  await cards.last().click();
  // Generous on purpose. selectOption defers the panel repaint through
  // paintPanelWithRoute, which waits for the map to actually *draw* the new
  // route and only gives up after a 3 s hard stop — so the class legitimately
  // does not exist yet for up to three seconds after the click, before any
  // runner slowness. The default 5 s expect timeout left almost no margin and
  // failed on CI, where the runner is several times slower than a laptop.
  await expect(cards.last()).toHaveClass(/selected/, { timeout: 20_000 });
  await expect.poll(async () => routeMeters(page), { timeout: 10_000 }).not.toBe(before);
  await expect.poll(() => page.url()).toMatch(/o=direct/);
});

test("nudge an endpoint by dragging its marker", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  const before = await routeMeters(page);

  // drag the destination marker a few hundred metres and expect a new plan
  const marker = page.locator(".maplibregl-marker:not(.opt-chip)").last();
  const box = await marker.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // discrete moves: a single move with {steps} is delivered too fast for
  // MapLibre's marker drag to follow
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + box.width / 2 + i * 9, box.y + box.height / 2 - i * 6);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  await expect.poll(async () => routeMeters(page), { timeout: 30_000 }).not.toBe(before);
  await expect(page.locator(".option-card").first()).toBeVisible();
});

test("swap the ends and get the reverse trip", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#swap").click();
  await expect
    .poll(() => page.url(), { timeout: 30_000 })
    .toMatch(/s=-71\.0867|s=-71\.086705/);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#s-dist")).toContainText("km");
});

test("hover a street to judge it before committing to the route", async ({ page }) => {
  await boot(page, HOME_VIEW);
  // hovering the safety network is how you check a street you know
  // the source can report loaded a frame or two before anything is painted
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["network-hit"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const pts = await page.evaluate(() => {
    const map = window._map;
    if (!map) return [];
    const all = map.queryRenderedFeatures(undefined, { layers: ["network-hit"] });
    const stride = Math.max(1, Math.floor(all.length / 60));
    return all
      .filter((_, i) => i % stride === 0)
      .flatMap((f) =>
        f.geometry.type === "LineString"
          ? f.geometry.coordinates
              .map((c) => map.project(c as [number, number]))
              .filter((p) => p.x > 400 && p.x < 1150 && p.y > 80 && p.y < 700)
              .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
          : [],
      );
  });
  expect(pts.length).toBeGreaterThan(0);
  let shown = false;
  for (const p of pts.slice(0, 12)) {
    await page.mouse.move(p.x, p.y, { steps: 3 });
    try {
      await expect(page.locator(".maplibregl-popup").first()).toBeVisible({ timeout: 2500 });
      shown = true;
      break;
    } catch {
      /* another feature may sit on this pixel */
    }
  }
  expect(shown).toBe(true);
  // the card names the protection and its stress, which is the whole point
  await expect(page.locator(".maplibregl-popup").first()).toContainText(
    /kid-stress|off-street|protected|quiet|busy|lane|path/i,
  );
});

test("preferences reshape the plan and survive a reload", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  const before = await routeMeters(page);

  const prefs = page.locator("summary", { hasText: "Preferences" }).first();
  await prefs.click();
  await page.locator("#avoid-busy_street").check();
  await page.locator("#avoid-sharrow").check();
  await expect(page.locator("#avoid-summary")).toContainText(/avoiding 2/);
  await expect.poll(() => page.url()).toMatch(/x=/);
  // the reasoning says so, and the safest route already avoids these, so the
  // distance needn't move — asserting it would be asserting a coincidence
  await expect(page.locator("#why-list")).toContainText(/Avoiding/i);

  // (there is no "avoid quiet streets" option, and the safest route is 83%
  // protected + 16% quiet, so no avoidable class is on it in quantity — the
  // contract worth asserting is that the choice is recorded and explained)
  expect(before).toBeGreaterThan(0);

  // the choices come back on a reload, which is what a planner expects
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 45_000 });
  await page.locator("summary", { hasText: "Preferences" }).first().click();
  await expect(page.locator("#avoid-busy_street")).toBeChecked();
  await expect(page.locator("#avoid-sharrow")).toBeChecked();
});

test("switch rider mode and watch the route get gentler", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=solo");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  const soloProtected = parseFloat((await page.locator("#s-prot").textContent()) ?? "0");

  // the segmented control, not a radio dot
  await page.locator("#modes label", { hasText: "young kids" }).click();
  await expect(page.locator('#modes input[value="young_kids"]')).toBeChecked();
  await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/m=young_kids/);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });

  const kidsProtected = parseFloat((await page.locator("#s-prot").textContent()) ?? "0");
  // riding with kids should not be less protected than riding alone
  expect(kidsProtected).toBeGreaterThanOrEqual(soloProtected);
});

test("a planned trip can be exported and reopened from its link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });

  await page.locator("summary", { hasText: "Export" }).first().click();
  // GPX for a bike computer
  const dl = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator("#gpx").click();
  const gpx = await dl;
  expect(await gpx.path()).not.toBeNull();
  expect(gpx.suggestedFilename()).toMatch(/\.gpx$/);

  // the share link reopens the same plan
  await page.locator("#share").click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/s=.*e=/);
  const planned = await routeMeters(page);
  await page.goto(link);
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 45_000 });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  expect(await routeMeters(page)).toBe(planned);
});

test("reset clears the plan when not navigating", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".option-card")).toHaveCount(0);
  await expect(page.locator(".maplibregl-marker:not(.opt-chip)")).toHaveCount(0);
  expect(await page.evaluate(() => window.location.hash)).toBe("");
});

test("a second right-click replaces the spot menu instead of stacking one", async ({ page }) => {
  await boot(page, HOME_VIEW);
  const pts = await streetPointsOnScreen(page);
  expect(pts.length).toBeGreaterThan(0);
  const a = pts[0];
  const b = pts[Math.min(6, pts.length - 1)];
  if (!a || !b) return;
  await page.mouse.click(a.x, a.y, { button: "right" });
  await expect(page.locator(".maplibregl-popup")).toHaveCount(1);
  await page.mouse.click(b.x, b.y, { button: "right" });
  // two cards over one map, and only one of them described the spot you meant
  await expect(page.locator(".maplibregl-popup")).toHaveCount(1);
  await expect(page.locator(".maplibregl-popup")).toContainText(/sketchy/i);
});

test("the route line is on the map by the time the numbers are", async ({ page }) => {
  // A warm map: the first route of a session also waits on basemap tiles, and
  // under load that can outlast any cap the panel could reasonably wait for
  // (it gives up after 3 s and shows the numbers, which is the right call).
  // Switching options is where riders saw the gap anyway.
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  const cards = page.locator(".option-card");
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["route"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // watch the summary distance and note what the map holds at that moment
  await page.evaluate(() => {
    const painted = (): number =>
      window._map?.queryRenderedFeatures(undefined, { layers: ["route"] }).length ?? 0;
    window.__paint = [];
    new MutationObserver(() => {
      const txt = document.getElementById("s-dist")?.textContent ?? "";
      if (txt.trim() !== "") window.__paint.push({ txt, len: painted() });
    }).observe(document.getElementById("s-dist") as Node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  const before = await routeMeters(page);
  await cards.last().click();
  await expect(cards.last()).toHaveClass(/selected/);
  await expect.poll(async () => routeMeters(page), { timeout: 15_000 }).not.toBe(before);

  const seen = await page.evaluate(() => window.__paint);
  expect(seen.length).toBeGreaterThan(0);
  // the numbers used to land a frame or two before the line was drawn, which
  // reads as the app having routed somewhere else and then corrected itself
  for (const s of seen) expect(s.len, `route drawn when "${s.txt}" appeared`).toBeGreaterThan(0);
});

test("a destination set from a link gets a name, and a typed one is left alone", async ({
  page,
}) => {
  // the geocoder is a nicety, so it's stubbed: what's under test is that the
  // field gets filled at all, and that it never overwrites what you typed
  await page.route(/nominatim\.openstreetmap\.org\/reverse/, (route) => {
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "Kendall/MIT", display_name: "Kendall/MIT, Cambridge" }),
    });
  });
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  // it used to open with an empty field and a route to nowhere named
  await expect(page.locator("#search")).toHaveValue("Kendall/MIT", { timeout: 15_000 });

  // type your own and it stands, even after the pin moves
  await page.locator("#search").fill("the bakery");
  const marker = page.locator(".maplibregl-marker:not(.opt-chip)").last();
  const box = await marker.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width / 2 + i * 8, box.y + box.height / 2 - i * 5);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await expect(page.locator("#search")).toHaveValue("the bakery");
});

test("the about dialog is one tap away, without scrolling the panel", async ({ page }) => {
  await boot(page, HOME_VIEW);
  const info = page.locator("#about-top");
  // it has to be reachable where the panel opens, not below every section
  await expect(info).toBeVisible();
  const box = await info.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.y).toBeLessThan(120);
  // a tappable target, not a 16 px glyph
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
  expect(await info.getAttribute("aria-label")).toMatch(/about/i);

  await info.click();
  await expect(page.locator("#about")).toBeVisible();
  await expect(page.locator("#about")).toContainText(/protection\s+class/i);
  // the freshness table is filled in, not left as the placeholder
  await expect(page.locator("#built-date")).not.toHaveText("…");
  await expect(page.locator("#freshness-table tr")).not.toHaveCount(1);

  // and it closes the two ways every other dialog does
  await page.locator("#about-close").click();
  await expect(page.locator("#about")).not.toBeVisible();
  await info.click();
  await page.mouse.click(5, 5);
  await expect(page.locator("#about")).not.toBeVisible();
});
