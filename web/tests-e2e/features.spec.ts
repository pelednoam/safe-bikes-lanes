// E2E coverage of the major user journeys, on the real app + real graph.
import { expect, test } from "@playwright/test";

import { budget } from "./budget.js";
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
    timeout: budget(45_000),
  });
}

function vis(page: Page, layer: string): Promise<string> {
  return page.evaluate(
    (l) => (window._map?.getLayoutProperty(l, "visibility") as string | undefined) ?? "visible",
    layer,
  );
}

/** Which basemap themes are actually showing, as "light"/"dark".
 *
 * The basemap is Carto's vector styles now — one layer set per theme
 * (bm-light-*, bm-dark-*) toggled by visibility — so there is no single "osm"
 * or "osm-dark" layer left to ask about. Asking for one by name was worse than
 * useless: vis() reports a layer that does not exist as "visible", so the
 * assertion here went on passing no matter what the map was doing.
 */
function shownThemes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const m = window._map;
    if (!m) return [];
    const on = new Set<string>();
    for (const layer of m.getStyle().layers) {
      const theme = /^bm-(light|dark)-/.exec(layer.id)?.[1];
      const visible =
        ((m.getLayoutProperty(layer.id, "visibility") as string | undefined) ?? "visible") ===
        "visible";
      if (theme !== undefined && visible) on.add(theme);
    }
    return [...on];
  });
}

async function openSection(page: Page, label: string): Promise<void> {
  const sum = page.locator("summary", { hasText: label }).first();
  const isOpen = await sum.evaluate((el) => (el.parentElement as HTMLDetailsElement).open);
  if (!isOpen) await sum.click();
}

/** On-screen (clear of the panel) points sampled along rendered streets.
 * Polls until the network layer has actually painted — on slow CI the source
 * can be loaded a frame or two before queryRenderedFeatures returns anything,
 * so a one-shot read flakes. */
async function streetPointsOnScreen(page: Page): Promise<{ x: number; y: number }[]> {
  let pts: { x: number; y: number }[] = [];
  await expect
    .poll(
      async () => {
        pts = await page.evaluate(() => {
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
        return pts.length;
      },
      { timeout: budget(30_000) },
    )
    .toBeGreaterThan(0);
  return pts;
}

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

test("avoid lane types shapes the route and the explanation", async ({ page }) => {
  await boot(page, `${DAVIS_KENDALL}&x=lane,sharrow`);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  await expect(page.locator("#avoid-lane")).toBeChecked();
  await expect(page.locator("#avoid-summary")).toContainText("avoiding 2");
  await expect(page.locator("#why-list")).toContainText(/Avoiding lane, sharrow/);
});

test("walk budget selector persists into the permalink", async ({ page }) => {
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  await openSection(page, "Preferences");
  await page.locator("#walk-max").selectOption("500");
  await expect.poll(() => page.url(), { timeout: budget(30_000) }).toContain("wk=500");
});

test("dark mode, aerial view, and 3D toggles drive the map", async ({ page }) => {
  await boot(page);
  await openSection(page, "Map layers");
  await page.locator("#dark-mode").check();
  await expect(page.locator("body")).toHaveClass(/dark/);
  // dark-matter, and only dark-matter: two themes shown at once would stack
  // two basemaps. Polled, because a theme's style is fetched the first time it
  // is asked for.
  await expect.poll(() => shownThemes(page), { timeout: budget(30_000) }).toEqual(["dark"]);
  await page.locator("#show-aerial").check();
  expect(await vis(page, "aerial")).toBe("visible");
  // the aerial view replaces the basemap rather than covering it
  await expect.poll(() => shownThemes(page), { timeout: budget(30_000) }).toEqual([]);
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

test("a permit feed cannot script the map popups", async ({ page }) => {
  test.slow();
  // The construction layers come from Cambridge's street-permit feed and
  // MassDOT's work-zone API. Neither is ours, and a project named
  // `<img onerror=…>` reached setHTML unescaped in the click popup while the
  // hover popup beside it escaped the same fields.
  await page.route(/construction\.geojson/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-71.1, 42.38] },
            properties: {
              src: "cambridge",
              name: "<img src=x onerror=\"window.__xss=1\">Water main",
              address: "<script>window.__xss2=1<\/script>10 Elm St",
              detail: "<b>bold</b> lane closed",
              start: "2026-01-01",
              end: "2026-02-01",
            },
          },
        ],
      }),
    });
  });
  await boot(page);
  await page.evaluate(() => {
    window._map?.jumpTo({ center: [-71.1, 42.38], zoom: 16 });
  });
  await page.waitForFunction(
    () =>
      (window._map?.queryRenderedFeatures(undefined, { layers: ["construction-pts"] }).length ??
        0) > 0,
    null,
    { timeout: 25_000 },
  );

  // click it, wherever it landed on screen
  const at = await page.evaluate(() => {
    const f = window._map?.queryRenderedFeatures(undefined, { layers: ["construction-pts"] })[0];
    const c = (f?.geometry as GeoJSON.Point | undefined)?.coordinates as [number, number];
    const p = window._map?.project(c);
    return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
  });
  expect(at).not.toBeNull();
  await page.mouse.click((at as { x: number; y: number }).x, (at as { x: number; y: number }).y);
  await expect(page.locator(".maplibregl-popup").first()).toBeVisible({ timeout: 10_000 });

  const state = await page.evaluate(() => ({
    xss: (window as unknown as Record<string, unknown>)["__xss"] ?? null,
    xss2: (window as unknown as Record<string, unknown>)["__xss2"] ?? null,
    imgs: document.querySelectorAll(".maplibregl-popup img").length,
    bolds: document.querySelectorAll(".maplibregl-popup b").length,
    text: document.querySelector(".maplibregl-popup")?.textContent ?? "",
  }));
  expect(state.xss, "an onerror handler from the feed ran").toBeNull();
  expect(state.xss2).toBeNull();
  expect(state.imgs, "the feed injected an element").toBe(0);
  // the popup's own <b> for the title is there; the feed's is not
  expect(state.bolds).toBe(1);
  // and the name is still readable, as text
  expect(state.text).toContain("Water main");
  expect(state.text).toContain("<img");
  expect(state.text).toContain("<b>bold</b>");
});

test("save a place via right-click and use it as start", async ({ page }) => {
  await boot(page);
  page.once("dialog", (d) => void d.accept("Test Home"));
  // right-click on a street (clear of the panel), waiting for it to paint;
  // try successive points until the context menu actually opens (a given
  // pixel can miss the map's contextmenu target on a slow CI frame)
  const pts = await streetPointsOnScreen(page);
  let opened = false;
  for (const pt of pts) {
    // clear any popup left by a previous miss so the text matches at most once
    await page.evaluate(() =>
      document.querySelectorAll(".maplibregl-popup").forEach((n) => n.remove()),
    );
    await page.mouse.click(pt.x, pt.y, { button: "right" });
    const saveItem = page.getByText("☆ save place…");
    try {
      await saveItem.click({ timeout: 2000 });
      opened = true;
      break;
    } catch {
      // right-click missed the hit layer at this pixel — try the next point
    }
  }
  expect(opened).toBe(true);
  await expect(page.locator("#places-list")).toContainText("🏠 Test Home");
  await page.locator("#places-list button", { hasText: "start" }).first().click();
  // a start marker appears (permalinks only form once start AND end exist)
  await expect(page.locator(".maplibregl-marker").first()).toBeVisible();
});

test("recent routes appear and replan on tap", async ({ page }) => {
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  // recent routes are collapsed by default — the section appears once there is history
  await expect(page.locator("#recent-box")).toBeVisible();
  await openSection(page, "Recent routes");
  await expect(page.locator("#recent-list")).toContainText("→");
  await page.locator("#reset").click();
  await openSection(page, "Recent routes");
  await page.locator("#recent-list span").first().click();
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
});

// Coverage reaches the next ring of towns (app-v32). These routes sit entirely
// in the newly-added areas and span several tiles, so they exercise on-demand
// corridor loading + cross-tile stitching out where the graph was just grown.
for (const [name, hash] of [
  ["Waltham → Lexington", "#s=-71.236,42.376&e=-71.224,42.447&m=young_kids"],
  ["Quincy → Milton", "#s=-71.002,42.252&e=-71.066,42.250&m=young_kids"],
  ["Wellesley → Revere (cross-metro)", "#s=-71.293,42.296&e=-71.012,42.408&m=young_kids"],
  // second ring
  ["Lynn → Saugus", "#s=-70.949,42.466&e=-71.010,42.464&m=young_kids"],
  ["Natick → Wellesley", "#s=-71.349,42.283&e=-71.293,42.296&m=young_kids"],
  ["Sherborn → Swampscott (corner to corner)", "#s=-71.369,42.239&e=-70.917,42.472&m=young_kids"],
  // third ring
  ["Salem → Peabody", "#s=-70.898,42.519&e=-70.929,42.528&m=young_kids"],
  ["Framingham → Ashland", "#s=-71.416,42.279&e=-71.463,42.261&m=young_kids"],
  ["Brockton → Abington", "#s=-71.018,42.084&e=-70.945,42.105&m=young_kids"],
  ["Concord → Cohasset (corner to corner)", "#s=-71.349,42.460&e=-70.803,42.242&m=young_kids"],
] as [string, string][]) {
  test(`new-ring towns route: ${name}`, async ({ page }) => {
    // a cross-metro trip legitimately pulls ~120 graph tiles before it can
    // route; that is seconds locally but well past the default on CI
    test.slow();
    await boot(page, hash);
    await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(90_000) });
    // a real drawn route, not just an empty card
    const coords = await page.evaluate(
      () => (window._map?.getSource("route") as { _data?: GeoJSON.FeatureCollection })._data,
    );
    expect(JSON.stringify(coords)).toContain("LineString");
  });
}

test("loop planner builds a round trip from a start point", async ({ page }) => {
  await boot(page, "#s=-71.122258,42.396748");
  await openSection(page, "Other trip types");
  await page.locator("#loop-btn").click();
  // several loops are offered now, so take the one that leads
  await expect(page.locator(".option-card", { hasText: "Loop via" }).first()).toBeVisible({
    timeout: budget(30_000),
  });
  await expect(page.locator("#s-dist")).toContainText("mi");
});

test("reach map floods from a clicked point", async ({ page }) => {
  await boot(page);
  await openSection(page, "Other trip types");
  await page.locator("#shed-btn").click();
  await page.mouse.click(700, 400);
  await expect(page.locator("#shed-info")).toContainText(/reachable/, { timeout: budget(30_000) });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window._map?.isSourceLoaded("shed")
              ? window._map.querySourceFeatures("shed").length
              : 0,
        ),
      { timeout: budget(30_000) },
    )
    .toBeGreaterThan(10);
});

test("hovering a street shows the safety card with a grade", async ({ page }) => {
  await boot(page);
  const pts = await streetPointsOnScreen(page);
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
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
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
  await expect(page.locator("#sheet-handle")).toBeVisible();
  // starts collapsed so the map gets the screen
  await expect(page.locator("#panel")).toHaveClass(/peek/);
  await page.locator("#sheet-handle").click(); // tap cycles peek -> half
  await expect(page.locator("#panel")).toHaveClass(/half/);
});

test("the bottom sheet can be dragged down to give the map the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, DAVIS_KENDALL);
  // a computed route opens the sheet to half
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  await expect(page.locator("#panel")).toHaveClass(/half/);

  const handle = page.locator("#sheet-handle");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  // the grabber must be a real thumb target, not a hairline
  expect(box.height).toBeGreaterThan(20);
  expect(box.width).toBeGreaterThan(200);

  // drag it down; the sheet should collapse and hand the space back.
  // hover() first: it waits for the handle to stop moving (the sheet is still
  // settling right after a route lands), then presses at its real centre.
  await handle.hover();
  const from = await handle.boundingBox();
  if (!from) return;
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  await page.mouse.down();
  for (let y = 0; y <= 320; y += 40) {
    await page.mouse.move(cx, cy + y);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await expect(page.locator("#panel")).toHaveClass(/peek/);
  const panelBox = await page.locator("#panel").boundingBox();
  expect(panelBox?.height ?? 999).toBeLessThan(844 * 0.3);
});

test.describe("system theme is dark", () => {
  test.use({ colorScheme: "dark" });
  test("the app still opens in light mode unless dark was chosen", async ({ page }) => {
    // following the phone's theme turned dark mode on for riders who never
    // asked for it; it's opt-in and remembered instead
    await page.goto("/");
    await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(45_000) });
    await expect(page.locator("body")).not.toHaveClass(/dark/);
    await expect(page.locator("#dark-mode")).not.toBeChecked();
  });
});

test("a route can be planned by typing both ends, not just tapping the map", async ({ page }) => {
  // stub the geocoder: the test is about the fields, not Nominatim
  await page.route("**/nominatim**", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const [lon, lat] = q.toLowerCase().includes("davis")
      ? [-71.122258, 42.396748]
      : [-71.086705, 42.362552];
    void route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{ display_name: `${q}, Somerville, MA`, lon: String(lon), lat: String(lat) }]),
    });
  });
  await boot(page);

  // the origin is searchable now — type it instead of tapping the map
  await page.locator("#from-field").fill("Davis Square");
  await page.locator("#search-results .search-row button", { hasText: "start" }).first().click();
  await expect(page.locator("#from-field")).toHaveValue(/Davis Square/);

  await page.locator("#search").fill("Kendall");
  await page.locator("#search-results .search-row button", { hasText: "go" }).first().click();

  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
  await expect(page.locator("#s-dist")).toContainText("mi");

  // the pin button hands the origin back to the current location
  await page.locator("#from-locate").click();
  await expect(page.locator("#from-field")).toHaveValue("");
});

test("saved places survive a wipe via backup and restore", async ({ page }) => {
  // Uninstalling an Android app wipes its storage, so places vanished on every
  // update while each APK needed a reinstall. Backup is the safety net.
  await boot(page);
  await page.evaluate(() => {
    localStorage.setItem(
      "savedPlaces",
      JSON.stringify([{ name: "Home", lon: -71.1, lat: 42.38 }]),
    );
  });
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(45_000) });
  await openSection(page, "Preferences");
  await expect(page.locator("#places-list")).toContainText("Home");

  // arm the listener before the click; racing them means the click can win and
  // the download is lost
  const downloadPromise = page.waitForEvent("download", { timeout: budget(30_000) });
  await page.locator("#backup-save").click();
  const file = await (await downloadPromise).path();
  expect(file).not.toBeNull();
  await expect(page.locator("#backup-note")).toContainText(/Backed up 1 saved place/);

  // the device gets wiped
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(45_000) });
  await openSection(page, "Preferences");
  await expect(page.locator("#places-list")).not.toContainText("Home");

  // restore from the file we just downloaded
  if (file) await page.locator("#backup-file").setInputFiles(file);
  await expect(page.locator("#backup-note")).toContainText(/Restored/);
  await expect(page.locator("#places-list")).toContainText("Home");
});

test("a shared route link brings the route into view", async ({ page }) => {
  // a link is how routes are shared; the recipient of a long route used to get
  // the default view of Somerville with ~2% of the route on screen
  await boot(page, "#s=-71.293,42.296&e=-71.012,42.408&m=solo");
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(90_000) });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const src = window._map?.getSource("route") as
            | { _data?: GeoJSON.FeatureCollection }
            | undefined;
          const coords = (src?._data?.features ?? []).flatMap((f) =>
            f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
          );
          if (coords.length === 0 || !window._map) return 0;
          const b = window._map.getBounds();
          const inside = coords.filter(
            (c) =>
              c[0] >= b.getWest() && c[0] <= b.getEast() && c[1] >= b.getSouth() && c[1] <= b.getNorth(),
          );
          return Math.round((100 * inside.length) / coords.length);
        }),
      { timeout: budget(30_000) },
    )
    .toBeGreaterThan(80);
});

test("map layers are grouped by the question they answer", async ({ page }) => {
  // Twelve checkboxes in one list, with a planner's analysis layers sitting
  // between dark mode and kid stops. That is how the round-trip planner ended
  // up invisible inside a drawer called "Other trip types" — the same failure.
  await boot(page);
  const box = page.locator("details.section", { has: page.locator("#show-net") });
  await box.locator("summary").click();

  await expect(box.locator(".layer-group h4")).toHaveText([
    "Safety",
    "Places",
    "Terrain & view",
    "For planners",
  ]);
  // every layer survived the regrouping
  expect(await box.locator(".layer-group input[type=checkbox]").count()).toBe(12);

  // the planner layers are named as such, not left to be discovered
  const planners = box.locator(".layer-group.planners");
  await expect(planners).toContainText(/analysis layers, not riding layers/i);
  for (const id of ["show-lanes", "show-access", "show-build"]) {
    await expect(planners.locator(`#${id}`)).toBeAttached();
  }
});

test("what each layer does is written down, not left in a tooltip", async ({ page }) => {
  // this project already has a test asserting that emoji controls carry a word,
  // because "tooltips don't exist on touch" — the same applies to twelve layers
  await boot(page);
  const box = page.locator("details.section", { has: page.locator("#show-net") });
  await box.locator("summary").click();
  const described = await box.evaluate((root) =>
    [...root.querySelectorAll(".layer-group .toggle")].map((l) => ({
      id: l.querySelector("input")?.id ?? "",
      note: l.querySelector("small")?.textContent?.trim() ?? "",
    })),
  );
  expect(described.length).toBe(12);
  for (const d of described) {
    expect(d.note, `${d.id} has no visible description`).not.toBe("");
  }
});

test("Reset puts the layers back to what a rider starts with", async ({ page }) => {
  await boot(page);
  const box = page.locator("details.section", { has: page.locator("#show-net") });
  await box.locator("summary").click();

  // turn the world on
  for (const id of ["show-heat", "show-pois", "show-aerial", "show-lanes", "show-build"]) {
    await page.locator(`#${id}`).check();
  }
  await page.locator("#show-net").uncheck();
  await page.waitForTimeout(400);

  // The layers really were on, or "they went away" is a statement about
  // nothing. Only lanemap is checked: heatmap, elevation and lane coverage are
  // mutually exclusive area overlays — ticking one unticks the others — so
  // asserting two of them at once tests a state the app will never be in.
  // Polled because they are built lazily on first use.
  const visible = async (id: string): Promise<boolean> =>
    await page.evaluate(
      (l) =>
        window._map?.getLayer(l) !== undefined &&
        (window._map?.getLayoutProperty(l, "visibility") ?? "visible") === "visible",
      id,
    );
  await expect.poll(() => visible("lanemap"), { timeout: 20_000 }).toBe(true);

  // dark mode is the deliberate exception: it follows the rider's system
  // setting and a reset on a night ride must not white out the screen
  await page.locator("#dark-mode").check();
  await page.waitForTimeout(300);

  await page.locator("#layers-reset").click();
  await page.waitForTimeout(600);
  // the two a rider wants on, and nothing else
  await expect(page.locator("#show-net")).toBeChecked();
  await expect(page.locator("#show-constr")).toBeChecked();
  for (const id of ["show-heat", "show-pois", "show-aerial", "show-lanes", "show-build", "show-elev", "show-3d", "show-gates", "show-access"]) {
    await expect(page.locator(`#${id}`), `${id} should be off after a reset`).not.toBeChecked();
  }
  // and the map agrees: reset goes through the same change events a tap does,
  // so the layers themselves actually went away
  // Checked without a `?? "none"` fallback: that turned a missing map, a
  // renamed layer and a never-set property into the same pass as a layer that
  // was genuinely hidden.
  const lanes = await page.evaluate(() => {
    const m = window._map;
    if (!m) return "NO MAP";
    if (m.getLayer("lanemap") === undefined) return "NO LAYER";
    return String(m.getLayoutProperty("lanemap", "visibility") ?? "visible");
  });
  expect(lanes).toBe("none");
  // and one layer is not the test: every planner layer must have gone too
  const planners = await page.evaluate(() =>
    ["lanemap", "access", "build"]
      .filter((id) => window._map?.getLayer(id) !== undefined)
      .map((id) => `${id}=${String(window._map?.getLayoutProperty(id, "visibility") ?? "visible")}`),
  );
  expect(planners.length, "none of the planner layers existed to check").toBeGreaterThan(0);
  for (const p of planners) expect(p).toMatch(/=none$/);
  await expect(page.locator("#dark-mode"), "Reset turned dark mode off").toBeChecked();
});

test("the planner layers point at the workspace they belong to", async ({ page }) => {
  await boot(page);
  const box = page.locator("details.section", { has: page.locator("#show-net") });
  await box.locator("summary").click();
  // The workspace is its own page now — a planner should land there, not have a
  // section expand inside a rider's app.
  const link = page.locator("#layers-build-link");
  await expect(link).toHaveAttribute("href", "build/");
  await link.click();
  await page.waitForURL(/\/build\/$/);
  await expect(page.locator("#rank-panel h1")).toBeVisible();
  await expect(page.locator(".row").first()).toBeVisible({ timeout: budget(30_000) });
});

test("the info box says which build you are looking at", async ({ page }) => {
  test.slow();
  // A hard refresh that appears to change nothing is indistinguishable from a
  // deploy that never happened. This is the only thing in the app that can tell
  // them apart, and it is the first line of the box people open to ask.
  await boot(page);
  await page.locator("#about-top").click();
  await expect(page.locator("#about")).toBeVisible();
  const stamp = page.locator("#build-stamp");
  await expect(stamp).toBeVisible();

  // Served from the repo rather than from a deploy, so the placeholder is
  // unsubstituted — and it says so plainly instead of inventing a date.
  await expect(stamp).toHaveText(/Development build|You're running/);

  // The data date is beside it, and is the pipeline's, not today's.
  await expect(page.locator("#built-date")).toHaveText(/\d{4}-\d{2}-\d{2}/);
});

// The app's service worker is network-first and answers same-origin requests
// itself, and page.route cannot intercept what a service worker serves — so the
// routes below would silently do nothing. Blocked for this test only; every
// other test wants the app as it really runs.
test.describe("build identity", () => {
  test.use({ serviceWorkers: "block" });

  test("a deployed build names itself and notices a newer one", async ({ page }) => {
  test.slow();
  // The substitution the deploy performs, done here so the deployed behaviour is
  // exercised rather than only the development fallback.
  await page.route("**/app.js", async (route) => {
    const res = await route.fetch();
    const body = (await res.text())
      .replace("__BUILD_VERSION__", "web")
      .replace("__BUILD_TIME__", "2026-08-12T02:00:00Z")
      .replace("__BUILD_COMMIT__", "aaaa111");
    await route.fulfill({
      response: res,
      body,
      headers: { ...res.headers(), "content-type": "text/javascript" },
    });
  });
  // and a site serving a different build than this page
  await page.route("**/build.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: '{"version":"web","built":"2026-08-12T03:30:00Z","commit":"bbbb222"}',
    }),
  );
  await boot(page);
  await page.locator("#about-top").click();
  const stamp = page.locator("#build-stamp");
  await expect(stamp).toContainText("aaaa111");
  await expect(stamp).toContainText("You're running");
  // the page is stale, and is told so rather than left to guess
  await expect(stamp.locator(".stale-build")).toBeVisible({ timeout: 10_000 });
  await expect(stamp).toContainText("bbbb222");
  await expect(stamp).toContainText("cached copy");

  // When the site agrees with the page, it says nothing further.
  await page.unroute("**/build.json");
  await page.route("**/build.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: '{"version":"web","built":"2026-08-12T02:00:00Z","commit":"aaaa111"}',
    }),
  );
  await page.reload();
  await page.locator("#about-top").click();
  await expect(page.locator("#build-stamp")).toContainText("aaaa111");
  await page.waitForTimeout(1500);
  expect(await page.locator(".stale-build").count()).toBe(0);
  });
});
