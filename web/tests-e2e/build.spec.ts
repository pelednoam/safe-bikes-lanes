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
  await expect(first).toContainText(/[\d.]+ (ft|mi|m|km) of /);
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
  await expect(page.locator(".build-row").first()).toContainText(/[\d.]+ (ft|mi|m|km) of /);

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

test("re-weighting repaints the map, so it can't contradict the list", async ({ page }) => {
  // colour and width are driven by the score property; moving the sliders used
  // to re-sort the list while the map kept painting the pipeline's weighting
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 20_000 });
  // selecting a row turns the layer on by itself; reaching for the checkbox in
  // the collapsed Map layers section just burns the test's whole budget
  await page.locator(".build-row").first().click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["build"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  const topScore = async (): Promise<number> =>
    page.evaluate(() => {
      const src = window._map?.getSource("build") as
        | { _data?: GeoJSON.FeatureCollection }
        | undefined;
      const feats = src?._data?.features ?? [];
      return Math.max(
        ...feats.map((f) => Number((f.properties as { score?: number } | null)?.score ?? 0)),
      );
    });

  const before = await topScore();
  await page.locator("#build-weights > summary").click();
  await page.locator("#wt-severance").fill("0");
  await page.locator("#wt-access").fill("0");
  await page.locator("#wt-coverage").fill("0");
  await page.locator("#wt-crash").fill("100");
  // the painted scores move with the sliders
  await expect.poll(topScore, { timeout: 10_000 }).not.toBe(before);

  // and the list's leader is the map's leader
  const listLeader = await page.locator(".build-row").first().getAttribute("data-pid");
  const paintedLeader = await page.evaluate(() => {
    const src = window._map?.getSource("build") as
      | { _data?: GeoJSON.FeatureCollection }
      | undefined;
    const feats = src?._data?.features ?? [];
    let best = { pid: "", score: -1 };
    for (const f of feats) {
      const p = f.properties as { pid?: string; score?: number } | null;
      if (p?.pid !== undefined && Number(p.score) > best.score) {
        best = { pid: p.pid, score: Number(p.score) };
      }
    }
    return best.pid;
  });
  expect(paintedLeader).toBe(listLeader);
});

test("spot fixes are drawn as points and read as one location, not a street", async ({
  page,
}) => {
  // A 14 m link between two safe grids is one location to treat, and a line that
  // short is invisible and untappable at the zoom a city looks at.
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 20_000 });
  // Select a spot fix, not the top row: queryRenderedFeatures only sees what's
  // on screen, and there are a few dozen spot fixes across 130 towns — framing
  // the highest-scoring corridor puts none of them in the viewport.
  const spotRow = page.locator(".build-row", { hasText: "spot fix" }).first();
  if ((await spotRow.count()) === 0) {
    test.skip(true, "no spot fix in the top 20 under the default weighting");
  }
  await spotRow.click();

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window._map?.queryRenderedFeatures(undefined, { layers: ["crossings"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // the list names a location and its size, without asserting the treatment
  const spotText = (await spotRow.textContent()) ?? "";
  expect(spotText).toContain("spot fix");
  expect(spotText).toContain("one location to treat");
  // never asserts a treatment the geometry can't support
  expect(spotText).not.toMatch(/crossing|signal/i);

  // tapping one selects it and does not drop a destination pin
  const pt = await page.evaluate(() => {
    const map = window._map;
    const f = map?.queryRenderedFeatures(undefined, { layers: ["crossings"] })[0];
    if (!map || !f || f.geometry.type !== "Point") return null;
    const p = map.project(f.geometry.coordinates as [number, number]);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  expect(pt).not.toBeNull();
  if (!pt) return;
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(600);
  await expect(page.locator(".maplibregl-marker:not(.opt-chip)")).toHaveCount(0);
  await expect(page.locator(".build-row.selected")).toHaveCount(1);
});

test("what-if re-costs your own trip, and undoes cleanly", async ({ page }) => {
  // The ranked list asserts a project is worth building; this is how a reader
  // checks that against a trip they actually take.
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  const distanceBefore = (await page.locator("#s-dist").textContent()) ?? "";
  const protectedBefore = (await page.locator("#s-prot").textContent()) ?? "";

  await expect(page.locator("#build-box")).toBeVisible({ timeout: 30_000 });
  await page.locator("#build-box > summary").click();
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".build-row").first().click();
  await expect(page.locator("#whatif")).toBeVisible();

  await page.locator("#whatif-run").click();
  await expect(page.locator("#whatif-result")).not.toBeEmpty({ timeout: 30_000 });
  const answer = (await page.locator("#whatif-result").textContent()) ?? "";
  // it always says how much it modelled, so the phrasing can't imply more
  expect(answer).toMatch(/rebuilt segment/);
  expect(answer).toMatch(/same assumption the ranking uses/);
  // and it either moved the trip or said plainly that it didn't
  expect(answer).toMatch(/protected|km|doesn't change/);

  // undo restores the real trip: this is a question, not a setting
  await page.locator("#whatif-clear").click();
  await expect.poll(async () => page.locator("#s-dist").textContent(), { timeout: 30_000 })
    .toBe(distanceBefore);
  expect(await page.locator("#s-prot").textContent()).toBe(protectedBefore);
  await expect(page.locator("#whatif-clear")).toBeHidden();
});

test("with no trip planned, what-if answers with reach instead", async ({ page }) => {
  await page.goto("/#c=-71.105,42.383,13");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  await expect(page.locator("#build-box")).toBeVisible({ timeout: 30_000 });
  await page.locator("#build-box > summary").click();
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".build-row").first().click();
  await page.locator("#whatif-run").click();
  // no start and no destination: say what's missing rather than nothing
  await expect(page.locator("#whatif-result")).toContainText(/plan a trip|set a start|in reach/i, {
    timeout: 30_000,
  });
});

test("the one-pager stands alone: numbers, provenance, and caveats", async ({ page, context }) => {
  // A page a city hands round is exactly where a model's caveats get lost, so
  // they have to be printed on it rather than left behind in the app.
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 20_000 });
  await page.locator(".build-row").first().click();

  const opened = context.waitForEvent("page", { timeout: 30_000 });
  await page.locator("#build-print").click();
  const sheet = await opened;
  await sheet.waitForLoadState("domcontentloaded");
  const text = (await sheet.locator("body").textContent()) ?? "";

  // What it is and what it would do. join_m is the smaller of the two sides — the
  // streets connected in, not the network they connect to — and this sheet and
  // the /build workspace have to say that the same way: two surfaces wording one
  // field differently is how a city ends up with two answers to one question.
  expect(text).toMatch(/Kid-safe streets it would connect in/);
  expect(text).not.toMatch(/network it (joins|would join)/);
  expect(text).toMatch(/libraries on the network it opens/);
  expect(text).toMatch(/\d+(\.\d+)? (mi|ft|m)\b/);
  // where the numbers came from
  expect(text).toMatch(/How this was measured/);
  expect(text).toMatch(/Census|street length/);
  expect(text).toMatch(/Data built \d{4}-\d{2}-\d{2}/);
  // and what they don't mean — the part most likely to be dropped
  expect(text).toMatch(/What these numbers do not mean/);
  expect(text).toMatch(/model output|not measurement/i);
  // the cost is never presented as an estimate
  expect(text).toMatch(/sorting proxy, not an estimate/);
  await sheet.close();
});

test("hovering a project in the app previews it without losing the selection", async ({
  page,
}) => {
  await openBuild(page);
  const rows = page.locator(".build-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await rows.first().click(); // selecting turns the layer on
  const chosen = await rows.first().getAttribute("data-pid");

  const hovered = async (): Promise<string> =>
    page.evaluate(() =>
      String((window._map?.getFilter("build-hover") as unknown[] | undefined)?.[2] ?? ""),
    );
  // clicking leaves the pointer on the row, so it is legitimately previewed —
  // move off before asserting the cleared state
  await page.locator("#build-intro").hover();
  await expect.poll(hovered).toBe("");

  await rows.nth(2).hover();
  const pid = await rows.nth(2).getAttribute("data-pid");
  await expect.poll(hovered).toBe(pid);
  // the picked one stays picked
  expect(
    await page.evaluate(() =>
      String((window._map?.getFilter("build-selected") as unknown[] | undefined)?.[2] ?? ""),
    ),
  ).toBe(chosen);

  await page.locator("#build-intro").hover();
  await expect.poll(hovered).toBe("");
});

test("the app's own ranking opens on the weighting the pipeline published", async ({ page }) => {
  test.slow();
  // Two surfaces rank the same candidates: this list and /build. Both must start
  // from meta.model.weights — the weighting the exported `score` was computed
  // with — or a city gets two answers to "which project first?". They used to
  // agree only because four literals happened to match the config.
  await openBuild(page);
  await expect(page.locator(".build-row").first()).toBeVisible({ timeout: 30_000 });

  const check = await page.evaluate(async () => {
    const meta = (await (await fetch("data/priorities_meta.json")).json()) as {
      model?: { weights?: Record<string, number> };
    };
    const w = meta.model?.weights;
    if (!w) return { ok: false as const, why: "no weights in meta" };
    const total = w["severance"]! + w["access"]! + w["crash"]! + w["coverage"]!;
    const want = Object.fromEntries(
      ["severance", "access", "crash", "coverage"].map((k) => [
        k,
        String(Math.round((w[k]! / total) * 100)),
      ]),
    );
    const got = Object.fromEntries(
      ["severance", "access", "crash", "coverage"].map((k) => [
        k,
        (document.getElementById(`wt-${k}`) as HTMLInputElement).value,
      ]),
    );
    return { ok: true as const, want, got };
  });
  expect(check.ok, check.why).toBe(true);
  expect(check.got).toEqual(check.want);

  // and the list's own order is the exported one
  const agree = await page.evaluate(async () => {
    const fc = (await (await fetch("data/priorities.geojson")).json()) as {
      features: { properties: Record<string, number | string> }[];
    };
    const seen = new Set<string>();
    const want = [...fc.features]
      .sort((a, b) => Number(b.properties["score"]) - Number(a.properties["score"]))
      .filter((f) => {
        const g = String(f.properties["group"]);
        if (seen.has(g)) return false;
        seen.add(g);
        return true;
      })
      .slice(0, 10)
      .map((f) => String(f.properties["name"]));
    const got = [...document.querySelectorAll<HTMLElement>(".build-row")]
      .slice(0, 10)
      .map((r) => r.textContent ?? "");
    return { want, got };
  });
  expect(agree.got.length).toBeGreaterThan(0);
  for (const [i, name] of agree.want.entries()) {
    if (i >= agree.got.length) break;
    expect(agree.got[i], `row ${String(i + 1)} is not the pipeline's ${String(i + 1)}`).toContain(
      name,
    );
  }
});
