// Planning a ride at a desktop before setting off: the mouse-driven half of
// the app. The other specs mostly arrive with a permalink already built, which
// skips everything a rider actually does the evening before — clicking the map
// for each end, dragging a marker to nudge it, hovering streets to judge them,
// and comparing the options against each other.
import { expect, test } from "@playwright/test";

import { budget } from "./budget.js";
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
const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

async function boot(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: budget(45_000),
  });
  // wait for the network layer, so map clicks land on real geometry
  await page.waitForFunction(() => window._map?.isSourceLoaded("network") === true, null, {
    timeout: budget(30_000),
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
      { timeout: budget(30_000) },
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
  // the app shows miles by default now, and feet under 1000 — read whichever
  // unit is on screen rather than assuming, or "5.3 mi" parses as 5.3 metres
  const txt = (await page.locator("#s-dist").textContent()) ?? "";
  const n = parseFloat(txt.replace(/,/g, ""));
  if (txt.includes("mi")) return n * 1609.344;
  if (txt.includes("ft")) return n / 3.280839895;
  if (txt.includes("km")) return n * 1000;
  return n;
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

  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  await expect(page.locator("#s-dist")).toContainText("mi");
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
  await expect(cards.first()).toBeVisible({ timeout: budget(30_000) });
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
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
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

  await expect.poll(async () => routeMeters(page), { timeout: budget(30_000) }).not.toBe(before);
  await expect(page.locator(".option-card").first()).toBeVisible();
});

test("swap the ends and get the reverse trip", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  await page.locator("#swap").click();
  await expect
    .poll(() => page.url(), { timeout: budget(30_000) })
    .toMatch(/s=-71\.0867|s=-71\.086705/);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  await expect(page.locator("#s-dist")).toContainText("mi");
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
      { timeout: budget(30_000) },
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
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
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
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(45_000) });
  await page.locator("summary", { hasText: "Preferences" }).first().click();
  await expect(page.locator("#avoid-busy_street")).toBeChecked();
  await expect(page.locator("#avoid-sharrow")).toBeChecked();
});

test("switch rider mode and watch the route get gentler", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=solo");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  const soloProtected = parseFloat((await page.locator("#s-prot").textContent()) ?? "0");

  // the segmented control, not a radio dot
  await page.locator("#modes label", { hasText: "young kids" }).click();
  await expect(page.locator('#modes input[value="young_kids"]')).toBeChecked();
  await expect.poll(() => page.url(), { timeout: budget(30_000) }).toMatch(/m=young_kids/);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });

  const kidsProtected = parseFloat((await page.locator("#s-prot").textContent()) ?? "0");
  // riding with kids should not be less protected than riding alone
  expect(kidsProtected).toBeGreaterThanOrEqual(soloProtected);
});

test("a planned trip can be exported and reopened from its link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });

  await page.locator("summary", { hasText: "Export" }).first().click();
  // GPX for a bike computer
  const dl = page.waitForEvent("download", { timeout: budget(30_000) });
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
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(45_000) });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  expect(await routeMeters(page)).toBe(planned);
});

test("reset clears the plan when not navigating", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
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
  await expect(cards.first()).toBeVisible({ timeout: budget(30_000) });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["route"] }).length ?? 0,
        ),
      { timeout: budget(30_000) },
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
  // Measured at ~52 s of a 60 s budget on a quiet machine: a cold map, a route
  // across two cities, and a drag with eight steps. It was passing with 8 s to
  // spare and failing whenever anything else ran, which reads as flakiness and is
  // really a test spending its whole allowance. Nothing here is weakened by
  // giving it room.
  test.slow();
  // the geocoder is a nicety, so it's stubbed: what's under test is that the
  // field gets filled at all, and that it never overwrites what you typed
  await page.route(/nominatim\.openstreetmap\.org\/reverse/, (route) => {
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "Kendall/MIT", display_name: "Kendall/MIT, Cambridge" }),
    });
  });
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
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


test("the planner asks nothing of OpenStreetMap's donated tile servers", async ({ page }) => {
  // tile.openstreetmap.org and Nominatim are donated infrastructure whose usage
  // policies rule out a public product building on them — they block by
  // referrer, and when that happens the map breaks for everybody at once. The
  // basemap moved to Carto; geocoding still uses Nominatim, deliberately, but
  // only on an explicit search and it is debounced and cached.
  const tiles: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("tile.openstreetmap.org")) tiles.push(r.url());
  });
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  expect(tiles, "basemap tiles must not come from OSM's servers").toHaveLength(0);
});

test("the wait is narrated, and something moves while it waits", async ({ page }) => {
  // The wait is mostly the map downloading — about 90 tiles for an ordinary trip
  // — and it used to show one motionless "routing…" through all of it, which
  // reads as a frozen app rather than a busy one.
  const seen: string[] = [];
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  const poll = setInterval(() => {
    void page
      .locator("#loading")
      .innerText()
      .then((t) => {
        const line = t.replace(/\s+/g, " ").trim();
        if (line !== "" && seen[seen.length - 1] !== line) seen.push(line);
      })
      .catch(() => undefined);
  }, 90);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(60_000) });
  clearInterval(poll);

  // it said what it was doing, and the count moved while it did it
  expect(seen.some((l) => /Loading the map/i.test(l))).toBe(true);
  expect(seen.some((l) => /\d+ of \d+/.test(l))).toBe(true);
  expect(new Set(seen).size, "the line never changed — that's the frozen look").toBeGreaterThan(1);
  // and it stopped claiming to be routing while it was really downloading
  expect(seen.some((l) => /Finding the safest way/i.test(l))).toBe(true);
});

test("naming a pin on a mapped street costs no call to OSM's geocoder", async ({ page }) => {
  // Nominatim is donated infrastructure with a usage policy that rules out a
  // public product leaning on it, and the map already loaded knows the street.
  // It is still the fallback for anywhere the local map can't name — a pin on a
  // building is better described as "Google" than as the road beside it — so
  // this checks the case the local answer is right for, not the total.
  const geocodes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("nominatim")) geocodes.push(r.url());
  });
  await boot(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  // count only calls for the point we are about to drop, so an unrelated pin
  // being geocoded can't decide this test
  const asked = (lon: number): number =>
    geocodes.filter((u) => u.includes(`lon=${lon.toFixed(6)}`)).length;
  // a pin dropped on a street the app has in its own map
  const onAStreet = await at(page, -71.1049, 42.3893);
  await page.mouse.click(onAStreet.x, onAStreet.y);
  await expect(page.locator("#from-field, #to-field").first()).toBeVisible();
  await page.waitForTimeout(2500);
  expect(asked(-71.1049), "a pin on a mapped street went to Nominatim").toBe(0);
});

test("a rider who already allowed location gets their start without asking", async ({
  page,
  context,
}) => {
  // The From field promises "Your location". Until this, nothing was located
  // until a route was asked for, so it was a promise the app hadn't kept.
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  // the start marker appears on its own, with no interaction at all
  await expect
    .poll(() => page.locator(".maplibregl-marker").count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
});

test("a round trip can be planned without hunting for it", async ({ page, context }) => {
  // The loop planner existed but lived inside a collapsed section called "Other
  // trip types", which is the same as not having it: you had to know it was
  // there to find it. It belongs beside "Where to?", because "a ride that comes
  // back here" is a different intent, not an advanced option.
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });

  const loop = page.locator("#loop-btn");
  await expect(loop, "the round-trip button must be visible without opening anything").toBeVisible();
  // the action comes after the choices: length, then stop, then go
  const order = await page.evaluate(() =>
    [...document.querySelectorAll("#loop-row input, #loop-row select, #loop-row button")].map(
      (e) => e.id,
    ),
  );
  expect(order).toEqual(["loop-dist", "loop-stop", "loop-btn"]);
  // and it must not be inside something collapsed
  const hidden = await loop.evaluate((b) => b.closest("details:not([open])") !== null);
  expect(hidden, "the button is inside a collapsed section").toBe(false);

  // pressing it with no start set finds one rather than refusing
  await loop.click();
  await page.waitForFunction(
    () => {
      const s = window._map?.getSource("route") as { _data?: { features?: unknown[] } } | undefined;
      return (s?._data?.features ?? []).length > 0;
    },
    null,
    { timeout: budget(60_000) },
  );
  await expect(page.locator("#error")).not.toBeVisible();

  // it is a loop: the drawn line comes back to where it started
  const closed = await page.evaluate(() => {
    const src = window._map?.getSource("route") as
      | { _data?: GeoJSON.FeatureCollection }
      | undefined;
    const coords = (src?._data?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
    if (coords.length < 2) return -1;
    const a = coords[0] as [number, number];
    const b = coords[coords.length - 1] as [number, number];
    return Math.hypot((b[0] - a[0]) * 82_000, (b[1] - a[1]) * 111_000); // metres apart
  });
  expect(closed, "a round trip should end roughly where it began").toBeGreaterThanOrEqual(0);
  expect(closed).toBeLessThan(400);
});


test("a round trip can have no stop at all", async ({ page, context }) => {
  // "just get us out for an hour" is a real ask, and every option in the list
  // used to be a place you had to visit
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });

  await expect(page.locator("#loop-stop option[value='none']")).toHaveCount(1);
  await page.locator("#loop-stop").selectOption("none");
  await page.locator("#loop-btn").click();
  await page.waitForFunction(
    () => {
      const s = window._map?.getSource("route") as { _data?: { features?: unknown[] } } | undefined;
      return (s?._data?.features ?? []).length > 0;
    },
    null,
    { timeout: budget(60_000) },
  );
  // no stop marker, and the explanation doesn't promise one
  const markers = await page.evaluate(
    () => document.querySelectorAll('.maplibregl-marker[style*="e67e22"]').length,
  );
  expect(markers, "a no-stop loop must not drop a stop marker").toBe(0);
  await expect(page.locator("#summary")).not.toContainText(/stop at/i);
});

test("the free-ride recorder is gone, but rides are still saved while navigating", async ({
  page,
}) => {
  await boot(page, HOME_VIEW);
  expect(await page.locator("#record-btn").count(), "the Record button was removed").toBe(0);
  // the recorder itself stays: a navigated ride still lands in the history,
  // which is the case that was actually worth keeping
  await expect(page.locator("#nav-btn")).toBeAttached();
});


test("a round trip is asked for in miles, typed freely, and answered with a choice", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });

  // miles, because this is eastern Massachusetts
  await expect(page.locator("#loop-unit")).toHaveText("mi");
  // and any distance, not four fixed ones: "about an hour" is 8 miles for one
  // family and 3 for another
  const box = page.locator("#loop-dist");
  await expect(box).toHaveAttribute("type", "number");
  await box.fill("4");
  await page.locator("#loop-stop").selectOption("none");
  await page.locator("#loop-btn").click();
  await page.waitForFunction(
    () => {
      const s = window._map?.getSource("route") as { _data?: { features?: unknown[] } } | undefined;
      return (s?._data?.features ?? []).length > 0;
    },
    null,
    { timeout: budget(60_000) },
  );
  await expect.poll(() => page.locator(".option-card").count(), { timeout: 20_000 }).toBeGreaterThan(1);

  const cards = await page.locator(".option-card").allInnerTexts();
  const miles = cards.map((c) => Number(/([\d.]+)\s*mi/.exec(c)?.[1] ?? NaN));
  const prot = cards.map((c) => Number(/(\d+)%\s*protected/.exec(c)?.[1] ?? NaN));
  // every option answers the question that was asked...
  for (const mi of miles) {
    expect(mi, `offered a ${mi} mi loop for a 4 mi request`).toBeGreaterThan(2.8);
    expect(mi).toBeLessThan(5.4);
  }
  // ...and the safest of them leads, which distance-only ranking got backwards:
  // it put a 27%-protected loop ahead of a 69%-protected one the same length
  expect(prot[0]).toBe(Math.max(...prot));
  // distances read in miles throughout, not kilometres
  await expect(page.locator("#summary")).toContainText(/mi\b/);
  await expect(page.locator("#summary")).not.toContainText(/\bkm\b/);
});

test("search results say how safe the way there is, before you commit", async ({
  page,
  context,
}) => {
  // The app's premise is that where you go is a safety decision, and it only
  // said so after you had already chosen. A park on the far side of an arterial
  // is a D before you set out.
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.waitForTimeout(2500);

  await page.locator("#search").fill("danehy");
  await expect(page.locator(".search-row").first()).toBeVisible({ timeout: budget(30_000) });

  // a real grade, from a real route — it arrives after the routing, so poll
  const badge = page.locator(".search-row").first().locator(".search-grade");
  await expect.poll(async () => (await badge.innerText()).trim(), { timeout: budget(60_000) }).toMatch(
    /^[ABCDF]$/,
  );
  // Coloured on the same scale the route cards use, so an A means one thing
  // everywhere. Compared against the placeholder colour, not against
  // transparency — the ungraded state is opaque too, so "not transparent" was
  // true before any grade arrived.
  const grade = (await badge.innerText()).trim();
  const bg = await badge.evaluate((b) => getComputedStyle(b).backgroundColor);
  // the same five colours the route cards grade with, so an A means one thing
  const GRADE_RGB: Record<string, string> = {
    A: "rgb(26, 152, 80)",
    B: "rgb(102, 189, 99)",
    C: "rgb(253, 174, 97)",
    D: "rgb(244, 109, 67)",
    F: "rgb(215, 48, 39)",
  };
  expect(GRADE_RGB[grade], `no colour defined for grade ${grade}`).toBeDefined();
  expect(bg, "the badge kept its ungraded placeholder colour").toBe(GRADE_RGB[grade]);
  // and the distance is the safest way's, not a straight line
  await expect(page.locator(".search-row").first().locator(".search-sub")).toContainText(
    /by the safest way/,
  );
});

test("a grade is never shown for a route that wasn't computed", async ({ page }) => {
  // The letter is a safety claim. Without a start there is nothing to route
  // from, so there is nothing honest to say — and inventing a start would be a
  // claim about a route nobody asked for.
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.waitForTimeout(2000);
  const hasStart = await page.evaluate(() => document.querySelectorAll(".maplibregl-marker").length);
  expect(hasStart, "this test needs no start marker to be meaningful").toBe(0);

  await page.locator("#search").fill("danehy");
  await expect(page.locator(".search-row").first()).toBeVisible({ timeout: budget(30_000) });
  await page.waitForTimeout(4000);
  // hidden rather than removed — taking them out re-flowed the rows under the
  // finger reaching for one — so this asks what a rider can see
  const visibleGrades = await page
    .locator(".search-grade")
    .evaluateAll((els) => els.filter((e) => getComputedStyle(e).visibility !== "hidden").length);
  expect(visibleGrades, "a grade appeared with nowhere to route from").toBe(0);
});

test("typing again abandons the grades for the list that's gone", async ({ page, context }) => {
  // five routes take a moment; the answers to the previous query must not land
  // against this query's rows
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.waitForTimeout(2500);

  await page.locator("#search").fill("danehy");
  await expect(page.locator(".search-row").first()).toBeVisible({ timeout: budget(30_000) });
  await page.locator("#search").fill("porter");
  // wait for the list to actually change hands — the old rows are still on
  // screen until the debounced search returns, so "a row is visible" proves
  // nothing about which query it belongs to
  await expect
    .poll(async () => (await page.locator("#search-results").innerText()).toLowerCase(), {
      timeout: 40_000,
    })
    .toContain("porter");
  const shown = (await page.locator("#search-results").innerText()).toLowerCase();
  expect(shown, "results from the abandoned query are still on screen").not.toContain("danehy");
  // and grading ran for the list that is actually there: a row left saying
  // "checking…" for ever would mean the guard cancelled the wrong generation
  await expect
    .poll(
      async () => (await page.locator(".search-row").first().locator(".search-sub").innerText()).trim(),
      { timeout: budget(60_000) },
    )
    .not.toContain("checking");
});

test("a destination the router can't reach gets no grade at all", async ({ page, context }) => {
  // The letter is a safety claim, and off the edge of the mapped area there is
  // no route to grade. The search itself is bounded to the local towns, so the
  // only way to reach this branch is to hand it a result from outside — which
  // is also exactly what a bad geocoder answer would look like.
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.route(/nominatim.*\/search/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { display_name: "Nowhere, Berkshire County, MA", lon: "-73.2500", lat: "42.4500" },
      ]),
    }),
  );
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.waitForTimeout(2500);
  await page.locator("#search").fill("nowhere");
  await expect(page.locator(".search-row").first()).toBeVisible({ timeout: budget(30_000) });
  // there IS a start, so a missing grade here means "no route", not "nowhere to
  // route from" — the two branches look identical on screen
  expect(
    await page.evaluate(() => document.querySelectorAll(".maplibregl-marker").length),
    "this test needs a start marker, or it proves the wrong branch",
  ).toBeGreaterThan(0);

  // it may take a moment to discover there is no route; what it must never do
  // is settle on a letter
  await page.waitForTimeout(15_000);
  const letters = await page
    .locator(".search-grade")
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
  for (const l of letters) {
    expect(l, "graded a route that could not be computed").not.toMatch(/^[ABCDF]$/);
  }
  // and the row is still usable as a destination — it just makes no claim, with
  // no placeholder left implying a computation is still running
  await expect(page.locator(".search-row").first()).toContainText("Nowhere");
  const stillChecking = await page.locator(".search-sub").evaluateAll((els) =>
    els.filter((e) => (e.textContent ?? "").includes("checking")).length,
  );
  expect(stillChecking, "a row is still claiming to be working it out").toBe(0);
});

test("changing a routing setting withdraws the letters it invalidated", async ({
  page,
  context,
}) => {
  // The letters describe routes under particular settings. Change one and they
  // are answers to a question nobody asked any more — so they must be withdrawn
  // and worked out again, not left on screen.
  //
  // (Whether the CACHE would have replayed a stale letter is tested directly in
  // tests/router.test.ts, against routeCacheKey — a browser test can't tell a
  // recomputed B from a replayed one, which is what made my first attempt at
  // this test unfalsifiable.)
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.waitForTimeout(2500);

  await page.locator("#search").fill("danehy");
  await expect(page.locator(".search-row").first()).toBeVisible({ timeout: budget(30_000) });
  const badge = page.locator(".search-row").first().locator(".search-grade");
  await expect.poll(async () => (await badge.innerText()).trim(), { timeout: budget(60_000) }).toMatch(
    /^[ABCDF]$/,
  );

  const prefs = page.locator("details.section", { has: page.locator("#prefer-flat") });
  await prefs.locator("summary").click();
  await page.locator("#avoid-lane").check();

  // Recorded rather than polled: with the corridor tiles already loaded the
  // recomputation takes milliseconds, so a poll can miss the withdrawal
  // entirely and conclude the letter was never taken down.
  await page.evaluate(() => {
    const el = document.querySelector(".search-row .search-grade");
    if (!el) return;
    (window as unknown as { __seen: string[] }).__seen = [];
    new MutationObserver(() => {
      (window as unknown as { __seen: string[] }).__seen.push((el.textContent ?? "").trim());
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });

  const prefs2 = page.locator("details.section", { has: page.locator("#prefer-flat") });
  await expect(prefs2).toBeVisible();
  await page.locator("#avoid-sharrow").check();

  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen ?? []),
      { timeout: budget(60_000) },
    )
    .toContain("·");
  // and it comes back: withdrawing is not the same as deleting
  await expect.poll(async () => (await badge.innerText()).trim(), { timeout: budget(60_000) }).toMatch(
    /^[ABCDF]$/,
  );
});

test("picking a start doesn't get graded as if it were a destination", async ({ page, context }) => {
  // The grade describes the route from your start to a destination. On the
  // start-picker list it would describe the route from the CURRENT start to a
  // candidate start — a journey nobody is taking, labelled as if they were.
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.waitForTimeout(2500);

  await page.locator("#from-field").fill("danehy");
  await expect(page.locator(".search-row").first()).toBeVisible({ timeout: budget(30_000) });
  await page.waitForTimeout(6000);
  const shownGrades = await page
    .locator(".search-grade")
    .evaluateAll((els) => els.filter((e) => getComputedStyle(e).visibility !== "hidden").length);
  expect(shownGrades, "the start picker showed a grade for a route nobody is taking").toBe(0);
  // And no leftover "checking…": a row that will never be graded must not claim a
  // computation is running. What it MAY say is what the place is and how far —
  // that is true whether or not a grade is coming, and a blank line under the
  // name read as broken rather than as ungraded.
  const subs = await page
    .locator(".search-sub")
    .evaluateAll((els) =>
      els
        .filter((e) => getComputedStyle(e).visibility !== "hidden")
        .map((e) => e.textContent ?? ""),
    );
  for (const text of subs) {
    expect(text, "the start picker claimed it was working out a grade").not.toContain("checking");
    expect(text, "the start picker showed a route's distance and time").not.toContain(
      "by the safest way",
    );
  }
});

test("searching before setting a start still gets grades once there is one", async ({
  page,
}) => {
  // Rows with nowhere to route from are hidden rather than removed, so the list
  // doesn't re-flow under a finger. Nothing ever un-hid them, so this ordinary
  // sequence — look for somewhere to go, then say where you are — left the
  // whole list permanently blank.
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.waitForTimeout(2000);

  await page.locator("#search").fill("danehy");
  await expect(page.locator(".search-row").first()).toBeVisible({ timeout: budget(30_000) });
  await page.waitForTimeout(3000);
  const badge = page.locator(".search-row").first().locator(".search-grade");
  expect(await badge.evaluate((b) => getComputedStyle(b).visibility)).toBe("hidden");

  // now set a start by picking it on the map — the flow "plan a ride entirely
  // with the mouse" already exercises
  await page.locator("#from-pick").click();
  const spot = await at(page, -71.0995, 42.3875);
  await page.mouse.click(spot.x, spot.y);
  await expect
    .poll(() => page.locator(".maplibregl-marker").count(), { timeout: budget(30_000) })
    .toBeGreaterThan(0);

  await expect.poll(async () => (await badge.innerText()).trim(), { timeout: budget(60_000) }).toMatch(
    /^[ABCDF]$/,
  );
  expect(await badge.evaluate((b) => getComputedStyle(b).visibility)).toBe("visible");
});

test("changing rider takes down the letters computed for the last one", async ({
  page,
  context,
}) => {
  // A grade is the safest route for a particular rider. Switching from young
  // kids to solo leaves letters describing a route the app would no longer
  // suggest — and a cache key can prevent a stale one being replayed but cannot
  // take down one already on screen.
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3875, longitude: -71.0995 });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.waitForTimeout(2500);
  await page.locator("#search").fill("danehy");
  await expect(page.locator(".search-row").first()).toBeVisible({ timeout: budget(30_000) });
  const badge = page.locator(".search-row").first().locator(".search-grade");
  await expect.poll(async () => (await badge.innerText()).trim(), { timeout: budget(60_000) }).toMatch(
    /^[ABCDF]$/,
  );

  await page.evaluate(() => {
    const el = document.querySelector(".search-row .search-grade");
    if (!el) return;
    (window as unknown as { __seen2: string[] }).__seen2 = [];
    new MutationObserver(() => {
      (window as unknown as { __seen2: string[] }).__seen2.push((el.textContent ?? "").trim());
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  // the radio itself is visually hidden behind a styled label
  await page.locator("#modes label", { hasText: "solo" }).click();

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __seen2: string[] }).__seen2 ?? []), {
      timeout: budget(60_000),
    })
    .toContain("·");
  // The tooltip and the label must go with it — a stale letter left in either is
  // the same claim, made to someone using a screen reader. Sampled at the moment
  // of withdrawal: `stale === "" || /grades [ABCDF]/` was true of the removed
  // case, the recomputed case AND the bug, so it asserted nothing.
  const labelWhileWithdrawn = await page.evaluate(() => {
    const el = document.querySelector(".search-row .search-grade");
    return el?.textContent?.trim() === "·" ? (el.getAttribute("aria-label") ?? "") : null;
  });
  if (labelWhileWithdrawn !== null) {
    expect(labelWhileWithdrawn, "a withdrawn badge still announced its old grade").toBe("");
  }
  // and once it settles it announces the new one
  await expect.poll(async () => (await badge.innerText()).trim(), { timeout: budget(60_000) }).toMatch(
    /^[ABCDF]$/,
  );
  const settled = await badge.getAttribute("aria-label");
  expect(settled).toMatch(/safest route grades [ABCDF]$/);
});

// ── the destination search ─────────────────────────────────────────────────
/** Both geocoder endpoints, stubbed as themselves.
 *
 * /search returns a list, /reverse returns one object — answering reverse with an
 * empty list happens to be harmless today, and is the kind of stub that quietly
 * stops testing what it claims to. Returns a live count of /search calls, which
 * is how "the local index answered without the network" is checked.
 */
async function stubGeocoder(
  page: Page,
  results: unknown[] = [],
): Promise<{ searches: () => number }> {
  // Awaited, not fired and forgotten: page.route returns a promise, and a boot that
  // navigates before the route is installed would reach the real Nominatim — a
  // flake, and a request to somebody else's donated service from a test.
  let searches = 0;
  await page.route(/nominatim.*\/search/, (route) => {
    searches++;
    void route.fulfill({ contentType: "application/json", body: JSON.stringify(results) });
  });
  await page.route(/nominatim.*\/reverse/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "Kendall/MIT", display_name: "Kendall/MIT, Cambridge" }),
    }),
  );
  return { searches: () => searches };
}



test("the search answers from the first letter, without asking the geocoder", async ({
  page,
  context,
}) => {
  test.slow();
  // The old search waited for three characters and then 400 ms, and asked
  // Nominatim for everything — including the 2,500 named places and every street
  // name the app already has on the device. Typing felt like waiting.
  // /search only: the app also reverse-geocodes the destination in the URL to put
  // a name in the field, and counting that would be counting the wrong thing.
  const geocoder = await stubGeocoder(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  // one letter, results, no network
  await page.locator("#search").fill("m");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({
    timeout: 3_000,
  });
  expect(geocoder.searches(), "a single letter went to the geocoder").toBe(0);

  // and they are real places, each with a name
  const names = await page
    .locator("#search-results .search-row .search-text > span:first-child")
    .allTextContents();
  expect(names.length).toBeGreaterThan(1);
  for (const n of names) expect(n.trim()).not.toBe("");
});

test("the search knows what people type, not what OSM stores", async ({ page, context }) => {
  test.slow();
  // "mass ave" is what a person types. Nominatim wants an address, and the app's
  // own data says "Massachusetts Avenue" — so both sides are normalised until they
  // meet, rather than hoping one matches the other.
  await stubGeocoder(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  const first = async (q: string): Promise<string> => {
    await page.locator("#search").fill(q);
    await expect(page.locator("#search-results .search-row").first()).toBeVisible({
      timeout: 5_000,
    });
    return (
      (await page
        .locator("#search-results .search-row .search-text > span:first-child")
        .first()
        .textContent()) ?? ""
    );
  };

  expect(await first("mass ave")).toContain("Massachusetts Avenue");
  // a playground, by the word a parent would use
  expect(await first("playgr")).toMatch(/Playground/i);
});

test("the nearest of several same-named streets comes first", async ({ page, context }) => {
  test.slow();
  // There are several Elm Streets in this region, and the one you meant is the one
  // you could ride to. The first version of this test read the rows and asserted
  // nothing about their order — it could not fail whatever the ranking did.
  await stubGeocoder(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  await page.locator("#search").fill("elm");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 8_000 });

  // Each row's own point, from its identity, measured against the start the app is
  // routing from — no text, no grades, just the geometry the ranking used.
  const rows = await page.evaluate(() => {
    const from = window._map?.getCenter();
    if (!from) return [];
    const R = 6_371_000;
    return [...document.querySelectorAll<HTMLElement>("#search-results .search-row")].map((r) => {
      const key = r.dataset["key"] ?? "";
      const name = key.split("|")[0] ?? "";
      const [lon, lat] = (key.split("|")[1] ?? "0,0").split(",").map(Number);
      const dLat = (((lat ?? 0) - from.lat) * Math.PI) / 180;
      const dLon = (((lon ?? 0) - from.lng) * Math.PI * Math.cos((from.lat * Math.PI) / 180)) / 180;
      return { name, m: Math.hypot(dLat, dLon) * R };
    });
  });
  expect(rows.length).toBeGreaterThan(1);

  // Among rows sharing a name, they must be offered nearest first.
  const byName = new Map<string, number[]>();
  for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r.m]);
  let compared = 0;
  for (const [name, ds] of byName) {
    for (let i = 1; i < ds.length; i++) {
      compared++;
      expect(
        ds[i] ?? 0,
        `a further ${name} was offered before a nearer one`,
      ).toBeGreaterThanOrEqual((ds[i - 1] ?? 0) - 1);
    }
  }
  // NOT "the first row is the nearest": that would contradict the rule the ranking
  // states. Typing "elm" here offers a street literally called "Elm" 7.6 km away
  // ahead of "Elm Street" 2.1 km away, because an exact name match is a better
  // answer than a prefix and distance never crosses a tier. Asserting nearest-first
  // across the whole list would be asserting the opposite of the design.
  //
  // What must hold is that a far exact match does not crowd the near ones out.
  const nearest = Math.min(...rows.map((r) => r.m));
  expect(rows.length).toBeGreaterThan(2);
  expect(
    rows.slice(0, 3).some((r) => r.m <= nearest + 1),
    "the nearest match was pushed out of the top of the list",
  ).toBe(true);
  expect(compared + rows.length).toBeGreaterThan(1);
});

test("arrow keys and Enter choose a destination without a mouse", async ({ page, context }) => {
  test.slow();
  await stubGeocoder(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  await page.locator("#search").fill("playgr");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 5_000 });
  const rows = page.locator("#search-results .search-row");
  const secondName =
    (await rows.nth(1).locator(".search-text > span:first-child").textContent()) ?? "";

  await page.locator("#search").press("ArrowDown");
  await page.locator("#search").press("ArrowDown");
  await expect(rows.nth(1)).toHaveClass(/active/);

  await page.locator("#search").press("Enter");
  // the field takes the highlighted row, not the first one
  await expect(page.locator("#search")).toHaveValue(secondName.trim());
  await expect(page.locator("#search-results .search-row")).toHaveCount(0);
});

test("Enter with nothing highlighted takes the best answer", async ({ page, context }) => {
  test.slow();
  // The ranking exists so the top row is right; making someone aim at it anyway
  // wastes that.
  await stubGeocoder(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  await page.locator("#search").fill("mass ave");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 5_000 });
  const top =
    (await page
      .locator("#search-results .search-row .search-text > span:first-child")
      .first()
      .textContent()) ?? "";
  await page.locator("#search").press("Enter");
  await expect(page.locator("#search")).toHaveValue(top.trim());
});

test("a geocoder that is down does not empty a list that already has answers", async ({
  page,
  context,
}) => {
  test.slow();
  // It used to replace everything with "search unavailable", including the local
  // results that were already on screen and still perfectly usable — which is
  // also what happens on a bike, offline, which is when it matters most.
  await page.route(/nominatim.*\/search/, (route) => route.abort());
  await page.route(/nominatim.*\/reverse/, (route) => route.abort());
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  await page.locator("#search").fill("playground");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 5_000 });
  const before = await page.locator("#search-results .search-row").count();
  // long enough for the failed request to have come back and done its worst
  await page.waitForTimeout(2_500);
  expect(await page.locator("#search-results .search-row").count()).toBe(before);
  await expect(page.locator("#search-results")).not.toContainText("search unavailable");
});

test("a late geocoder answer cannot move the row you already chose", async ({ page, context }) => {
  test.slow();
  // The bug this exists for: local results appear instantly, the geocoder answers
  // 250 ms later, the list re-renders — and the arrow-key highlight went with the
  // old DOM. Enter then took the first row instead of the chosen one, which on a
  // destination list means riding somewhere you did not pick. Found because the
  // keyboard test failed one run in three.
  let release: (() => void) | undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/nominatim.*\/search/, async (route) => {
    await held; // answer only when the test says so
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { display_name: "Aardvark Alley, Somerville", name: "Aardvark Alley", lon: "-71.12", lat: "42.397" },
      ]),
    });
  });
  await page.route(/nominatim.*\/reverse/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "Kendall/MIT", display_name: "Kendall/MIT, Cambridge" }),
    }),
  );
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  await page.locator("#search").fill("playgr");
  const rows = page.locator("#search-results .search-row");
  await expect(rows.first()).toBeVisible({ timeout: 5_000 });

  // choose the second row while the geocoder is still thinking
  await page.locator("#search").press("ArrowDown");
  await page.locator("#search").press("ArrowDown");
  const chosen = (await rows.nth(1).locator(".search-text > span:first-child").textContent()) ?? "";
  const chosenKey = await rows.nth(1).getAttribute("data-key");
  expect(chosen.trim()).not.toBe("");

  release?.();
  await page.waitForTimeout(1_500); // long enough for the answer to have landed

  // the selection is still on the same place, by identity and not by position
  const active = page.locator("#search-results .search-row.active");
  await expect(active).toHaveCount(1);
  expect(await active.getAttribute("data-key")).toBe(chosenKey);

  await page.locator("#search").press("Enter");
  await expect(page.locator("#search")).toHaveValue(chosen.trim());
});

test("your own places and the trips you took come first", async ({ page, context }) => {
  test.slow();
  // Two of the four sources the search reads live in localStorage rather than in
  // the data snapshot: places the rider named, and destinations they have already
  // ridden to. They outrank a street of the same name, because someone saying "this
  // matters" is better evidence than a name match.
  await stubGeocoder(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await page.evaluate(() => {
    // Named exactly like a real street, and further away, so the only thing that
    // can put it first is being theirs.
    localStorage.setItem(
      "savedPlaces",
      JSON.stringify([{ name: "Elm Street", lon: -71.06, lat: 42.35 }]),
    );
    localStorage.setItem(
      "recentRoutes",
      JSON.stringify([
        {
          s: [-71.1223, 42.3968],
          e: [-71.07, 42.36],
          label: "Davis to Elmwood Pool",
          km: 5,
          grade: "B",
          t: Date.now(),
        },
      ]),
    );
  });
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: budget(60_000),
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  const names = async (q: string): Promise<string[]> => {
    await page.locator("#search").fill(q);
    await expect(page.locator("#search-results .search-row").first()).toBeVisible({
      timeout: 5_000,
    });
    return page
      .locator("#search-results .search-row .search-text > span:first-child")
      .allTextContents();
  };

  // The saved place beats the real Elm Streets, though it is further away. The
  // names are identical on purpose, so the rows are told apart by their point.
  await page.locator("#search").fill("elm street");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 5_000 });
  const firstKey = await page
    .locator("#search-results .search-row")
    .first()
    .getAttribute("data-key");
  expect(firstKey, "a street outranked the rider's own place of the same name").toContain(
    "-71.06000,42.35000",
  );

  // and somewhere they have ridden to is offered by the name it was filed under
  const pool = await names("elmwood");
  expect(pool.some((n) => n.includes("Elmwood Pool"))).toBe(true);
});

test("with no start set, the search orders by what you are looking at", async ({
  page,
  context,
}) => {
  test.slow();
  // Distances have to come from somewhere before a start exists — the app opens
  // with an empty from-field, and a list in arbitrary order is the first thing a
  // new reader would see.
  await stubGeocoder(page);
  await context.grantPermissions(["geolocation"]);
  await page.goto("/#c=-71.1223,42.3968,14"); // a view, no start and no destination
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: budget(60_000),
  });
  await page.waitForTimeout(2_500);

  await page.locator("#search").fill("playgr");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 8_000 });

  // Ordered by distance from the map centre. Read the rows' own points and check
  // the order rather than trusting the text, which has no grade yet.
  const dists = await page.evaluate(() => {
    const c = window._map?.getCenter();
    if (!c) return [];
    const R = 6_371_000;
    return [...document.querySelectorAll<HTMLElement>("#search-results .search-row")].map((r) => {
      const key = r.dataset["key"] ?? "";
      const [lon, lat] = (key.split("|")[1] ?? "0,0").split(",").map(Number);
      const dLat = (((lat ?? 0) - c.lat) * Math.PI) / 180;
      const dLon =
        (((lon ?? 0) - c.lng) * Math.PI * Math.cos((c.lat * Math.PI) / 180)) / 180;
      return Math.hypot(dLat, dLon) * R;
    });
  });
  // The first row is the nearest of those offered. Not globally monotonic: rows can
  // come from different match tiers, and a better-named match further away
  // legitimately outranks a nearer loose one — asserting monotonicity would have
  // been asserting the opposite of the ranking's stated rule.
  expect(dists.length).toBeGreaterThan(2);
  expect(dists[0] ?? Infinity, "the first row is not the nearest match").toBeLessThanOrEqual(
    Math.min(...dists) + 1,
  );
});

test("a geocoder answer with a broken coordinate is dropped, not offered", async ({
  page,
  context,
}) => {
  test.slow();
  // Nominatim is someone else's service and its answers are parsed with
  // parseFloat. A malformed one becomes NaN, and NaN as a destination reaches the
  // router and the route cache key — so the row is dropped rather than shown.
  await page.route(/nominatim.*\/search/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        // a token nothing local can match, so only the geocoder's answers can
        // appear and the test is about them rather than about the ranking
        { display_name: "Zzyzx Broken, Somerville", name: "Zzyzx Broken", lon: "not-a-number", lat: "42.39" },
        { display_name: "Zzyzx Empty, Somerville", name: "Zzyzx Empty", lon: "-71.1", lat: "" },
        { display_name: "Zzyzx Fine, Somerville", name: "Zzyzx Fine", lon: "-71.1", lat: "42.39" },
      ]),
    }),
  );
  await page.route(/nominatim.*\/reverse/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "Kendall/MIT", display_name: "Kendall/MIT, Cambridge" }),
    }),
  );
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  await page.locator("#search").fill("zzyzx");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(1_200); // the geocoder's answer has landed

  const rows = await page.locator("#search-results .search-row").evaluateAll((rs) =>
    rs.map((r) => ({
      name: r.querySelector(".search-text > span")?.textContent ?? "",
      key: (r as HTMLElement).dataset["key"] ?? "",
    })),
  );
  const names = rows.map((r) => r.name);
  expect(names, "the good answer was dropped too").toContain("Zzyzx Fine");
  expect(names, "a row was offered with an unusable coordinate").not.toContain("Zzyzx Broken");
  expect(names).not.toContain("Zzyzx Empty");
  // and nothing anywhere carries a NaN, which would poison the route cache key
  for (const r of rows) expect(r.key).not.toContain("NaN");
});

test("a build with no recorded weighting still opens a usable list", async ({ page }) => {
  test.slow();
  // The app's planner list reads the weighting the pipeline published. A snapshot
  // without it — an older build, or a partial write — must fall back rather than
  // put NaN into the sliders and rank by it.
  await page.route(/priorities_meta\.json/, async (route) => {
    const res = await route.fetch();
    const meta = (await res.json()) as { model?: Record<string, unknown> };
    // three of the four weights: partial, which is the case that produces NaN
    meta.model = { ...(meta.model ?? {}), weights: { severance: 0.4, access: 0.3, crash: 0.15 } };
    await route.fulfill({ response: res, json: meta });
  });
  await boot(page, HOME_VIEW);
  await page.locator("#build-box > summary").click();
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: budget(30_000) });

  // Asserted on the ranking, not on the slider values: a range input silently
  // rejects "NaN" and keeps whatever it had, so the sliders look fine either way.
  // What a NaN weighting actually does is make every score NaN, which leaves the
  // list in file order — ranked-looking, and not ranked.
  const scores = await page.evaluate(async () => {
    const fc = (await (await fetch("data/priorities.geojson")).json()) as {
      features: { properties: Record<string, number | string> }[];
    };
    const byPid = new Map(
      fc.features.map((f) => [String(f.properties["pid"]), Number(f.properties["score"])]),
    );
    return [...document.querySelectorAll<HTMLElement>(".build-row")].map(
      (r) => byPid.get(r.getAttribute("data-pid") ?? "") ?? Number.NaN,
    );
  });
  expect(scores.length).toBeGreaterThan(1);
  for (const s of scores) expect(Number.isFinite(s)).toBe(true);
  for (let i = 1; i < scores.length; i++) {
    expect(
      (scores[i] ?? 0) - 1e-9,
      "the list is not ranked — a partial weighting was used instead of the fallback",
    ).toBeLessThanOrEqual(scores[i - 1] ?? 0);
  }
  await expect(page.locator("#build-list")).toContainText(/top \d+ of \d+/);
});

test("a late answer for the start field cannot retarget the destination list", async ({
  page,
  context,
}) => {
  test.slow();
  // Both fields render into one #search-results box, and each closure captured its
  // own target. A slow answer for the start field could therefore re-render the
  // list while the reader was typing a destination — and every row in it would then
  // set the START when tapped. The wrong point, silently, on a safety app.
  let release: (() => void) | undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/nominatim.*\/search/, async (route) => {
    await held;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { display_name: "Zzyzx Start, Somerville", name: "Zzyzx Start", lon: "-71.09", lat: "42.37" },
      ]),
    });
  });
  await page.route(/nominatim.*\/reverse/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "Kendall/MIT", display_name: "Kendall/MIT, Cambridge" }),
    }),
  );
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });

  // ask from the START field, with a query that only the geocoder can answer
  await page.locator("#from-field").fill("zzyzx start");
  await page.waitForTimeout(300);
  // then move to the destination field before the answer lands
  await page.locator("#search").fill("playgr");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 8_000 });
  const startBefore = await page.evaluate(() => {
    const s = window._map?.getSource("route") as unknown;
    return JSON.stringify(document.querySelector<HTMLInputElement>("#from-field")?.value ?? "") + String(s !== undefined);
  });

  release?.();
  await page.waitForTimeout(2_000);

  // the list still belongs to the destination field: its rows are playgrounds, and
  // choosing one fills the destination rather than the start
  const names = await page
    .locator("#search-results .search-row .search-text > span:first-child")
    .allTextContents();
  expect(names.join(" "), "the start field's answer took over the list").not.toContain("Zzyzx");
  await page.locator("#search-results .search-row").first().locator(".search-text").click();
  await expect(page.locator("#search")).not.toHaveValue("playgr");
  // and the start field was left alone
  expect(await page.locator("#from-field").inputValue()).toBe("zzyzx start");
  expect(startBefore.length).toBeGreaterThan(0);
});

test("the geocoder is asked sparingly, and never faster than once a second", async ({
  page,
  context,
}) => {
  test.slow();
  // Nominatim's usage policy asks for at most one request per second and says
  // plainly that it is not for autocomplete. The first version of this search
  // debounced at 250 ms and fired from the third character — the exact pattern it
  // asks people not to send, to a service that is donated.
  const at: number[] = [];
  await page.route(/nominatim.*\/search/, (route) => {
    at.push(Date.now());
    void route.fulfill({ contentType: "application/json", body: "[]" });
  });
  await page.route(/nominatim.*\/reverse/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "Kendall/MIT", display_name: "Kendall/MIT, Cambridge" }),
    }),
  );
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3968, longitude: -71.1223 });
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 40_000 });
  at.length = 0;

  // A query the device answers well, typed and then left alone long enough for the
  // debounce to have fired. Not a burst: a burst is bounded by the debounce alone,
  // so it would pass whatever the policy did — which is how the first version of
  // this test passed with the policy removed.
  await page.locator("#search").fill("playgr");
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({ timeout: 8_000 });
  const localRows = await page.locator("#search-results .search-row").count();
  expect(localRows, "the local index did not answer, so this proves nothing").toBeGreaterThan(2);
  await page.waitForTimeout(2_500);
  expect(
    at.length,
    "a query the device already answered was sent to the geocoder anyway",
  ).toBe(0);

  // A house number is different: only the geocoder knows those, so it is asked.
  at.length = 0;
  await page.locator("#search").fill("123 broadway");
  await page.waitForTimeout(2_500);
  expect(at.length, "an address query never reached the geocoder").toBeGreaterThan(0);

  // The one-per-second floor is asserted in tests/search.test.ts, on the function
  // that decides it. Through the browser the request offsets vary by more than a
  // second between runs on this machine, so the same assertion here was both flaky
  // and unable to fail when the floor was deleted.
});
