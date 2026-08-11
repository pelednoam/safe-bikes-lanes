// The /build workspace: a planner's page, separate from the rider's app.
//
// What these tests are for: the page makes claims a city might quote in a
// meeting, and it lets the reader re-weight the ranking. Two things must hold no
// matter what — the sliders must never change a measured number, and the town
// filter must never attribute a project to a town it isn't in. Everything else
// here is the ordinary "does it render and respond" floor.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
    _printed?: number;
  }
}

interface Loaded {
  rows: number;
  towns: string[];
}

/** Open the workspace and wait until the ranking has been drawn from real data. */
async function open(
  page: import("@playwright/test").Page,
  width = 1280,
): Promise<{ errors: string[]; loaded: Loaded }> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e)}`));
  page.on("console", (m) => {
    // A CSP refusal surfaces here and nowhere else — the page still renders.
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.setViewportSize({ width, height: 860 });
  await page.goto("/build/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 60_000 });
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  const rows = await page.locator(".row").count();
  const towns = await page.locator("#town option").evaluateAll((os) =>
    os.map((o) => (o as HTMLOptionElement).value),
  );
  return { errors, loaded: { rows, towns } };
}

/** The list as text, in order — what the reader is being told to build first. */
async function order(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator(".row .what").evaluateAll((ns) => ns.map((n) => n.textContent ?? ""));
}

/** How many candidates the current filter ranks, whether or not all are drawn. */
async function rankedTotal(page: import("@playwright/test").Page): Promise<number> {
  const note = page.locator("#more");
  if (await note.isVisible()) {
    const m = /of ([\d,]+) ranked here/.exec((await note.textContent()) ?? "");
    if (m?.[1] !== undefined) return Number(m[1].replace(/,/g, ""));
  }
  return page.locator(".row").count();
}

/** The picked project's component table, as label → value. */
async function components(page: import("@playwright/test").Page): Promise<Record<string, string>> {
  return page.locator("#d-rows tr").evaluateAll((trs) => {
    const out: Record<string, string> = {};
    for (const tr of trs) {
      const tds = tr.querySelectorAll("td");
      if (tds.length === 2) out[tds[0]?.textContent ?? ""] = tds[1]?.textContent ?? "";
    }
    return out;
  });
}

test("the ranking is drawn from the pipeline's own output", async ({ page }) => {
  test.slow();
  const { errors, loaded } = await open(page);

  // Real data, not a placeholder: the region has thousands of candidates and
  // dozens of towns. A stub or an empty fetch would fall far below this.
  expect(loaded.rows).toBeGreaterThan(200);
  expect(loaded.towns.length).toBeGreaterThan(20);
  expect(loaded.towns).toContain("Somerville");

  // The headline count and the build date come from meta, not from the markup.
  await expect(page.locator("#counts")).toContainText(/[\d,]+ were examined/);
  await expect(page.locator("#built")).toHaveText(/\d{4}-\d{2}-\d{2}|\w+ \d/);
  await expect(page.locator("#built")).not.toHaveText("—");

  // Rank 1 reads as a sentence about what it would achieve, in miles.
  const first = page.locator(".row").first();
  await expect(first.locator(".rank")).toHaveText("1");
  await expect(first.locator(".what")).toContainText(/\d(\.\d)? (mi|ft) of /);
  await expect(first.locator(".why")).toContainText(/connects|opens|crash|residents/);

  // The limits are stated, not implied.
  await expect(page.locator("#limits li")).not.toHaveCount(0);

  expect(errors).toEqual([]);
});

test("the weights re-sort the list without changing a measured number", async ({ page }) => {
  test.slow();
  await open(page);

  await page.locator(".row").first().click();
  const before = await components(page);
  // Without this, every comparison below is ""==="" if the table never rendered.
  // The crash row names itself differently when the build has no counts, and the
  // alternatives row only exists when there are alternatives — so the shape is
  // checked against what this build can produce, not against a fixed list that
  // would need editing every time either changes.
  const keys = Object.keys(before);
  expect(keys[0]).toBe("Gap-closing");
  expect(keys[1]).toBe("Reach to schools & parks");
  expect(keys[2]).toMatch(/^Crash history( \(no counts in this build\))?$/);
  expect(keys[3]).toMatch(/^Residents gaining access( \(estimated\))?$/);
  expect(keys[4]).toBe("Score with these weights");
  expect(keys[5]).toBe("Order-of-magnitude cost");
  expect(keys.slice(6)).toEqual(
    before["Alternatives across this gap"] === undefined ? [] : ["Alternatives across this gap"],
  );
  for (const v of Object.values(before)) expect(v).not.toBe("");
  const nameBefore = await page.locator("#d-name").textContent();
  const orderBefore = await order(page);

  // Set all four explicitly so the expected score is unambiguous: half the
  // weight on crash history, half on reach, nothing on the other two. This is
  // the reader deciding they care about a different thing.
  for (const [id, v] of [
    ["#w-sev", "0"],
    ["#w-acc", "50"],
    ["#w-crash", "50"],
    ["#w-cov", "0"],
  ] as const) {
    await page.locator(id).fill(v);
    await page.locator(id).dispatchEvent("input");
  }
  // shown as the share each one contributes, not as the raw slider number
  await expect(page.locator("#v-sev")).toHaveText("0%");
  await expect(page.locator("#v-crash")).toHaveText("50%");
  await expect(page.locator("#v-acc")).toHaveText("50%");

  // The ranking moved...
  const orderAfter = await order(page);
  expect(orderAfter).not.toEqual(orderBefore);
  expect(orderAfter.length).toBe(orderBefore.length);

  // ...but every measured component of the project still on screen is identical.
  // Only the composite changed, and it changed the way the weights say.
  await expect(page.locator("#d-name")).toHaveText(nameBefore ?? "");
  const after = await components(page);
  for (const key of keys) {
    if (key === "Score with these weights") continue; // the only figure a slider may move
    expect(after[key], `${key} must not move when a slider does`).toBe(before[key]);
  }
  // From the unrounded components in the data file: the table shows both the
  // components and the score to two decimals, so recomputing from what is on
  // screen lands on the rounding boundary rather than on the arithmetic.
  const pid = await page.locator(".row.on").getAttribute("data-pid");
  const exact = await page.evaluate(async (want) => {
    const fc = (await (await fetch("../data/priorities.geojson")).json()) as {
      features: { properties: Record<string, number | string> }[];
    };
    const f = fc.features.find((x) => x.properties["pid"] === want);
    return f === undefined
      ? null
      : {
          sev: Number(f.properties["c_severance"]),
          acc: Number(f.properties["c_access"]),
          crash: Number(f.properties["c_crash"]),
          cov: Number(f.properties["c_coverage"]),
        };
  }, pid);
  expect(exact).not.toBeNull();
  const e = exact as { sev: number; acc: number; crash: number; cov: number };
  const want = 0 * e.sev + 0.5 * e.acc + 0.5 * e.crash + 0 * e.cov;
  // within the 2-decimal rounding of the displayed figure, and no further
  expect(Math.abs(Number(after["Score with these weights"]) - want)).toBeLessThanOrEqual(0.005);
  // and it is not the score it had a moment ago, or the slider did nothing
  expect(after["Score with these weights"]).not.toBe(before["Score with these weights"]);

  // Re-weighting must not move the map — the reader is comparing, not travelling.
  const camBefore = await page.evaluate(() => ({
    c: window._map?.getCenter().toArray(),
    z: window._map?.getZoom(),
  }));
  await page.locator("#w-acc").fill("70");
  await page.locator("#w-acc").dispatchEvent("input");
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => ({
    c: window._map?.getCenter().toArray(),
    z: window._map?.getZoom(),
  }))).toEqual(camBefore);
});

test("the town filter matches a town's name exactly", async ({ page }) => {
  test.slow();
  const { loaded } = await open(page);

  // Two towns whose names contain each other. If either is missing from this
  // build the test still checks the one that is there.
  const pairs: [string, string][] = [
    ["Reading", "North Reading"],
    ["Andover", "North Andover"],
  ];
  const usable = pairs.filter(([a, b]) => loaded.towns.includes(a) && loaded.towns.includes(b));
  expect(usable.length, "no containing town-name pair in this build to test with").toBeGreaterThan(
    0,
  );

  for (const [town, other] of usable) {
    await page.locator("#town").selectOption(town);
    await expect(page.locator(".row").first()).toBeVisible();
    // Read the towns straight off the features behind the visible rows.
    const towns = await page.evaluate(async (n) => {
      const fc = (await (
        await fetch("../data/priorities.geojson")
      ).json()) as GeoJSON.FeatureCollection;
      const byPid = new Map<string, string>();
      for (const f of fc.features) {
        byPid.set(String(f.properties?.["pid"]), String(f.properties?.["towns"]));
      }
      return [...document.querySelectorAll<HTMLElement>(".row")]
        .slice(0, n)
        .map((r) => byPid.get(r.dataset["pid"] ?? "") ?? "?");
    }, 40);
    expect(towns.length).toBeGreaterThan(0);
    for (const t of towns) {
      const names = t.split(",").map((s) => s.trim());
      expect(names, `a ${town} row is actually in ${t}`).toContain(town);
    }
    // And the containing name is genuinely present in the build, so the
    // assertion above is doing work: a substring filter would list these.
    const wouldSweepIn = await page.evaluate(
      async ([a, b]) => {
        const fc = (await (await fetch("../data/priorities.geojson")).json()) as {
          features: { properties: Record<string, unknown> }[];
        };
        return fc.features.filter((f) => {
          const list = String(f.properties["towns"])
            .split(",")
            .map((x) => x.trim());
          return list.includes(b as string) && !list.includes(a as string);
        }).length;
      },
      [town, other],
    );
    expect(wouldSweepIn, `${other} has no rows a substring filter could sweep into ${town}`)
      .toBeGreaterThan(0);
  }
});

test("picking a project shows what it would do and marks it on the map", async ({ page }) => {
  test.slow();
  await open(page);

  await expect(page.locator("#detail-panel")).toBeHidden();
  await page.locator(".row").nth(2).click();
  await expect(page.locator("#detail-panel")).toBeVisible();

  // "of N" is the whole ranking, not the number of rows drawn: the panel caps its
  // DOM at a few hundred, and a rank line that counted only what was on screen
  // would tell a city their project was 3rd of 250 when it is 3rd of 1,480.
  const total = await rankedTotal(page);
  expect(total).toBeGreaterThan((await order(page)).length);
  await expect(page.locator("#d-rank")).toHaveText(`Rank 3 of ${total.toLocaleString("en-US")}`);
  await expect(page.locator("#d-name")).not.toBeEmpty();
  await expect(page.locator("#d-where")).toContainText(" · today ");
  // The class is named in words. Asserting the absence of "_" could not fail —
  // the fallback replaces underscores too — so this checks it is one of the
  // phrases the page defines, which a new class key would not be.
  const where = (await page.locator("#d-where").textContent()) ?? "";
  expect(where).toMatch(
    / · today (off-street path|separated lane|buffered lane|painted lane|shared-lane markings|quiet street|moderate street|busy street|alley or service road)$/,
  );

  // Figures: at least what to build and the network it would join, in miles.
  const figs = await page.locator(".figure .l").allTextContents();
  expect(figs).toContain("to build");
  expect(figs).toContain("kid-safe streets it would connect in");
  await expect(page.locator(".figure .n").first()).toHaveText(/^[\d,.]+ (mi|ft)$/);

  // The what-if is stated from measured fields and says so — and it does not
  // name the region's network, because this snapshot has no joins_region field
  // to support that claim for any individual project.
  await expect(page.locator("#d-whatif")).toContainText("If this were protected");
  await expect(page.locator("#d-whatif")).toContainText("the side that gains");
  await expect(page.locator("#d-whatif")).toContainText("Modelled on the streets as mapped today");
  const hasFlag = await page.evaluate(async () => {
    const fc = (await (await fetch("../data/priorities.geojson")).json()) as {
      features: { properties: Record<string, unknown> }[];
    };
    return fc.features.some((f) => "joins_region" in f.properties);
  });
  if (!hasFlag) {
    await expect(page.locator("#d-whatif")).not.toContainText("region");
  }

  // The map highlights exactly the picked project, and only it.
  const hi = await page.evaluate(() => {
    const map = window._map;
    return {
      filter: JSON.stringify(map?.getFilter("project-hi")),
      pins: document.querySelectorAll(".maplibregl-marker").length,
    };
  });
  const pid = await page.locator(".row.on").getAttribute("data-pid");
  expect(pid).not.toBeNull();
  expect(hi.filter).toBe(JSON.stringify(["==", ["get", "pid"], pid]));
  expect(hi.pins).toBe(1);

  // Picking a second project replaces the pin rather than adding one.
  await page.locator(".row").nth(5).click();
  await expect(page.locator("#d-rank")).toHaveText(/Rank 6 of/);
  expect(await page.locator(".maplibregl-marker").count()).toBe(1);
  expect(await page.locator(".row.on").count()).toBe(1);
});

test("the CSV is the list on screen, with every component", async ({ page }) => {
  test.slow();
  await open(page);
  // an unambiguous weighting: half gap-closing, half reach
  for (const [id, v] of [
    ["#w-sev", "50"],
    ["#w-acc", "50"],
    ["#w-crash", "0"],
    ["#w-cov", "0"],
  ] as const) {
    await page.locator(id).fill(v);
    await page.locator(id).dispatchEvent("input");
  }
  const expected = await order(page);

  // armed before the click: the download can land first
  const wait = page.waitForEvent("download");
  await page.locator("#csv").click();
  const csv = await (await wait).createReadStream();
  const text = await new Promise<string>((res, rej) => {
    let s = "";
    csv.on("data", (c: Buffer) => (s += c.toString()));
    csv.on("end", () => res(s));
    csv.on("error", rej);
  });

  const lines = text.trim().split("\n");
  const total = await rankedTotal(page);
  expect(lines[0]).toBe(
    "rank,score_with_current_weights,pid,name,towns,kind,cls,length_m,join_m,crashes," +
      "dest_unlocked,pop_gaining,cost_proxy,score,group,group_size,c_severance,c_access," +
      "c_crash,c_coverage",
  );
  // The CSV is the whole ranking — the panel's DOM cap must not reach it, or a
  // city's spreadsheet would quietly be missing five sixths of the analysis.
  expect(lines.length - 1).toBe(total);
  expect(total).toBeGreaterThan(expected.length);
  expect(lines[1]?.startsWith("1,")).toBe(true);
  expect(lines[lines.length - 1]?.startsWith(`${total},`)).toBe(true);
  // and the rows on screen are its first rows, in the same order
  await expect(page.locator("#more")).toContainText(`Showing the top ${expected.length}`);
  const names = lines.slice(1, 6).map((l) => {
    const cells = l.split(",");
    return (cells[3] ?? "").replace(/^"|"$/g, "");
  });
  for (const [i, n] of names.entries()) {
    expect(expected[i], `row ${String(i + 1)} on screen is not CSV row ${String(i + 1)}`)
      .toContain(n);
  }
  // the score column reflects the slider the reader just moved
  const header = (lines[0] ?? "").split(",");
  const covCol = header.indexOf("c_coverage");
  const sevCol = header.indexOf("c_severance");
  const accCol = header.indexOf("c_access");
  const crashCol = header.indexOf("c_crash");
  // names with commas are quoted, so only trust columns on a row without any
  const plain = lines.slice(1).find((l) => !l.includes('"'));
  expect(plain, "expected at least one row without a quoted field").toBeTruthy();
  const p = (plain ?? "").split(",");
  expect(Number(p[1])).toBeCloseTo(
    0.5 * Number(p[sevCol]) +
      0.5 * Number(p[accCol]) +
      0 * Number(p[crashCol]) +
      0 * Number(p[covCol]),
    3,
  );
  expect(p.length).toBe(header.length);
});

test("the one-pager prints the project and not the workspace", async ({ page }) => {
  test.slow();
  await open(page);
  await page.evaluate(() => {
    window._printed = 0;
    window.print = () => {
      window._printed = (window._printed ?? 0) + 1;
    };
  });
  await page.locator(".row").first().click();
  await page.locator("#print").click();
  expect(await page.evaluate(() => window._printed)).toBe(1);

  // In print, the ranking and the buttons are gone and the project is the page.
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#rank-panel")).toBeHidden();
  await expect(page.locator("#print")).toBeHidden();
  await expect(page.locator("#map")).toBeHidden();
  await expect(page.locator("#d-name")).toBeVisible();
  await expect(page.locator("#d-figures")).toBeVisible();
  await expect(page.locator("#d-whatif")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator("#rank-panel")).toBeVisible();
});

test("a phone gets one panel at a time", async ({ page }) => {
  test.slow();
  await open(page, 390);

  await expect(page.locator("#rank-panel")).toBeVisible();
  await expect(page.locator("#detail-panel")).toBeHidden();

  await page.locator(".row").first().click();
  await expect(page.locator("#detail-panel")).toBeVisible();
  await expect(page.locator("#rank-panel")).toBeHidden();
  // the way back exists on a phone and is reachable without scrolling past the map
  const back = page.locator("#back-to-list");
  await expect(back).toBeVisible();
  const box = await back.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(60);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(28);

  // The project is framed clear of the bottom sheet. On a wide screen the panel
  // is on the right and gets 420 px of padding; asking for that on a 390 px
  // canvas leaves fitBounds a negative width to fit into.
  await page.waitForTimeout(1200);
  const framing = await page.evaluate(() => {
    const map = window._map;
    const pid = document.querySelector<HTMLElement>(".row.on")?.dataset["pid"] ?? "";
    const src = map?.getSource("projects") as unknown as {
      _data?: GeoJSON.FeatureCollection<GeoJSON.MultiLineString>;
    };
    const f = src._data?.features.find((x) => x.properties?.["pid"] === pid);
    const line = f?.geometry.coordinates.flat() as [number, number][] | undefined;
    const box = map?.getCanvas().getBoundingClientRect();
    if (!map || !line || !box) return null;
    const pts = line.map((c) => map.project(c));
    const c = map.getCenter();
    return {
      finite: Number.isFinite(c.lng) && Number.isFinite(c.lat) && Number.isFinite(map.getZoom()),
      zoom: map.getZoom(),
      // every point of it, not merely one: a camera that never moved can still
      // have a corner of a long street in the visible strip
      allOnScreen: pts.every(
        (p) => p.x >= 0 && p.x <= box.width && p.y >= 0 && p.y <= box.height * 0.38,
      ),
      w: box.width,
    };
  });
  expect(framing).not.toBeNull();
  const fr = framing as { finite: boolean; zoom: number; allOnScreen: boolean; w: number };
  expect(fr.w).toBeLessThan(900);
  expect(fr.finite, "fitBounds produced a broken camera").toBe(true);
  // The page opens at zoom 11. With padding wider than the canvas, fitBounds
  // silently does nothing and leaves it there — which is how the project would
  // never get framed at all on a phone.
  expect(fr.zoom, "the camera never moved off the opening view").toBeGreaterThan(12.5);
  expect(fr.allOnScreen, "the project is not framed clear of the bottom sheet").toBe(true);

  await back.click();
  await expect(page.locator("#rank-panel")).toBeVisible();
  await expect(page.locator("#detail-panel")).toBeHidden();
  expect(await page.locator(".row.on").count()).toBe(0);
  // and the highlight clears with it
  expect(await page.evaluate(() => JSON.stringify(window._map?.getFilter("project-hi")))).toBe(
    JSON.stringify(["==", ["get", "pid"], ""]),
  );

  // nothing overflows sideways at phone width
  const scroll = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(scroll.w).toBeLessThanOrEqual(scroll.c + 1);
});

test("an empty result says so instead of showing nothing", async ({ page }) => {
  test.slow();
  await open(page);
  await expect(page.locator("#empty")).toBeHidden();

  // The select only offers towns that have candidates, so reach the branch the
  // way a stale bookmark or a data change would: a town that is gone.
  await page.evaluate(() => {
    const sel = document.getElementById("town") as HTMLSelectElement;
    const o = document.createElement("option");
    o.value = "Nowhere";
    sel.appendChild(o);
    sel.value = "Nowhere";
    sel.dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#empty")).toBeVisible();
  expect(await page.locator(".row").count()).toBe(0);
});

test("the page loads no third-party code and reports no CSP refusals", async ({ page }) => {
  test.slow();
  const hosts = new Set<string>();
  page.on("request", (r) => {
    // data: and blob: have no host; they are this page's own bytes
    const u = new URL(r.url());
    if (u.protocol === "http:" || u.protocol === "https:") hosts.add(u.host);
  });
  const { errors } = await open(page);
  await page.locator(".row").first().click();
  await page.waitForTimeout(2500);

  // Only this origin and the basemap's tiles. Any other host would mean a
  // planner's session is being seen by someone we didn't name.
  expect([...hosts].sort()).toEqual(["127.0.0.1:8321", "basemaps.cartocdn.com"]);

  // No script from anywhere but here.
  const srcs = await page.locator("script[src]").evaluateAll((ss) =>
    ss.map((s) => (s as HTMLScriptElement).getAttribute("src") ?? ""),
  );
  for (const s of srcs) expect(s.startsWith("http")).toBe(false);
  expect(errors.filter((e) => /Content Security Policy|Refused to/i.test(e))).toEqual([]);
  expect(errors).toEqual([]);
});

test("a headcount is only called people when it was counted", async ({ page }) => {
  test.slow();

  // This build's census fetch worked, so the honest-fallback branch cannot be
  // reached with the real data — the page has to be handed a build where it
  // didn't. Serve exactly that: the same meta with is_headcount off.
  await page.route("**/priorities_meta.json", async (route) => {
    const res = await route.fetch();
    const meta = (await res.json()) as { population?: { is_headcount?: boolean } };
    meta.population = { ...(meta.population ?? {}), is_headcount: false };
    await route.fulfill({ response: res, json: meta });
  });

  await open(page);
  const estimated: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.locator(".row").nth(i).click();
    estimated.push(...(await page.locator(".figure .l").allTextContents()));
  }
  // An estimate is never presented as a number of people.
  expect(estimated).not.toContain("residents gaining a safe route");
  // The rest of the card still works — the fallback hides one figure, not the page.
  expect(estimated).toContain("kid-safe streets it would connect in");

  // With the real meta, the same projects do say residents.
  await page.unroute("**/priorities_meta.json");
  await page.reload();
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  const counted: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.locator(".row").nth(i).click();
    counted.push(...(await page.locator(".figure .l").allTextContents()));
  }
  expect(counted).toContain("residents gaining a safe route");
});

test("a street on the map is a way in, not just a picture", async ({ page }) => {
  test.slow();
  await open(page);
  await page.waitForTimeout(2500);

  // Aim at a highly ranked project: those are the lines the map draws thickly,
  // and a low-ranked one can be drawn under a pixel wide, where a miss would be
  // the paint expression working rather than the click handler failing.
  const hit = await page.evaluate(() => {
    const map = window._map;
    if (!map) return null;
    const src = map.getSource("projects") as unknown as {
      _data?: GeoJSON.FeatureCollection<GeoJSON.MultiLineString>;
    };
    const byPid = new Map<string, GeoJSON.Feature<GeoJSON.MultiLineString>>();
    for (const f of src._data?.features ?? []) byPid.set(String(f.properties?.["pid"]), f);
    const box = map.getCanvas().getBoundingClientRect();
    for (const row of [...document.querySelectorAll<HTMLElement>(".row")].slice(0, 40)) {
      const pid = row.dataset["pid"] ?? "";
      const line = byPid.get(pid)?.geometry.coordinates[0] as [number, number][] | undefined;
      if (!line) continue;
      for (const c of line) {
        const pt = map.project(c);
        if (pt.x > 420 && pt.x < box.width - 420 && pt.y > 40 && pt.y < box.height - 40) {
          return { x: Math.round(pt.x), y: Math.round(pt.y), pid };
        }
      }
    }
    return null;
  });
  expect(hit, "no project drawn away from the panels to click").not.toBeNull();
  const at = hit as { x: number; y: number; pid: string };

  // Hovering a project says it can be clicked.
  await page.mouse.move(at.x, at.y);
  await expect
    .poll(async () => page.evaluate(() => window._map?.getCanvas().style.cursor))
    .toBe("pointer");

  // Candidates overlap, so what opens is whichever is on top at that pixel —
  // one of the projects actually under the cursor, and the map says which.
  const under = await page.evaluate(
    (pt) =>
      (window._map?.queryRenderedFeatures([pt.x, pt.y] as never, { layers: ["projects"] }) ?? []).map(
        (f) => String(f.properties?.["pid"]),
      ),
    { x: at.x, y: at.y },
  );
  expect(under.length).toBeGreaterThan(0);

  await page.mouse.click(at.x, at.y);
  await expect(page.locator("#detail-panel")).toBeVisible();
  const opened = await page.evaluate(() => {
    const f = window._map?.getFilter("project-hi") as [string, unknown, string] | undefined;
    return f?.[2] ?? "";
  });
  expect(under, "opened a project that isn't under the cursor").toContain(opened);
  await expect(page.locator("#d-name")).not.toBeEmpty();

  // It is either the row the reader can see, or an alternative across a gap
  // whose representative is the one listed — and the panel says which.
  const row = page.locator(`.row[data-pid="${opened}"]`);
  if ((await row.count()) > 0) {
    await expect(row).toHaveClass(/\bon\b/);
    await expect(page.locator("#d-rank")).toHaveText(/^Rank [\d,]+ of [\d,]+$/);
  } else {
    await expect(page.locator("#d-rank")).toHaveText("Alternative for the same gap");
  }

  // Moving off it puts the cursor back.
  await page.mouse.move(at.x, 20);
  await expect
    .poll(async () => page.evaluate(() => window._map?.getCanvas().style.cursor))
    .toBe("");
});

test("a crash count is quoted when there is one and never invented", async ({ page }) => {
  test.slow();

  // This build's graph predates the per-edge crash counts, so every project
  // reports the derived fallback. Both halves of that contract matter, and only
  // one of them can be seen with the data as it stands — so serve the other.
  await open(page);
  await page.locator(".row").first().click();
  const fallbackFigures = await page.locator(".figure .l").allTextContents();
  // the crash value of the project actually on screen, not of some other feature
  const pid = await page.locator(".row.on").getAttribute("data-pid");
  const known = await page.evaluate(async (want) => {
    const fc = (await (await fetch("../data/priorities.geojson")).json()) as {
      features: { properties: Record<string, unknown> }[];
    };
    const f = fc.features.find((x) => x.properties["pid"] === want);
    return f === undefined ? "missing" : (f.properties["crashes"] ?? null);
  }, pid);
  expect(known, "the picked project is not in the data file").not.toBe("missing");
  if (known === null) {
    // no count is known: no count is shown, and no figure claims one
    for (const l of fallbackFigures) expect(l).not.toContain("crash");
    // and the component says why it has no figure beside it
    await expect(page.locator("#d-rows")).toContainText("Crash history (no counts in this build)");
  } else if (known === 0) {
    // counted, and there were none here — which is not the same as unmeasured,
    // and not the same as a crash site either
    for (const l of fallbackFigures) expect(l).not.toContain("crash");
    await expect(page.locator("#d-rows")).toContainText("Crash history (none recorded here)");
  } else {
    // this build has counts: they are shown, and not qualified away
    expect(fallbackFigures.some((l) => /^bike crashes here (since \d{4}|on record)$/.test(l))).toBe(
      true,
    );
    await expect(page.locator("#d-rows")).toContainText("Crash history");
    await expect(page.locator("#d-rows")).not.toContainText("no counts in this build");
    await expect(page.locator("#d-rows")).not.toContainText("none recorded here");
  }

  // The three states, all of them, whichever one this build happens to be in.
  const crashFigure = /^bike crashes here (since \d{4}|on record)$/;
  for (const [value, label, figure] of [
    [null, "Crash history (no counts in this build)", false],
    [0, "Crash history (none recorded here)", false],
    [7, "Crash history", true],
  ] as [number | null, string, boolean][]) {
    await page.unroute("**/priorities.geojson").catch(() => undefined);
    await page.route("**/priorities.geojson", async (route) => {
      const res = await route.fetch();
      const fc = (await res.json()) as { features: { properties: Record<string, unknown> }[] };
      for (const f of fc.features) f.properties["crashes"] = value;
      await route.fulfill({ response: res, json: fc });
    });
    await page.goto("/build/");
    await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
    await page.locator(".row").first().click();
    const rows = (await page.locator("#d-rows").textContent()) ?? "";
    expect(rows, `crashes=${String(value)} should say "${label}"`).toContain(label);
    // "Crash history" is a prefix of both qualified labels, so containing it is
    // not enough: the qualifiers this state does not have must be absent.
    for (const other of ["(no counts in this build)", "(none recorded here)"]) {
      if (!label.includes(other)) {
        expect(rows, `crashes=${String(value)} must not say "${other}"`).not.toContain(other);
      }
    }
    const labels = await page.locator(".figure .l").allTextContents();
    expect(labels.some((l) => crashFigure.test(l)), `crashes=${String(value)} figure`).toBe(figure);
    if (figure) expect(await page.locator(".figure.warn .n").textContent()).toBe("7");
  }

  // Whichever this build is, force the other and check it too — so neither half
  // of the contract can go untested as the data changes underneath.
  await page.route("**/priorities.geojson", async (route) => {
    const res = await route.fetch();
    const fc = (await res.json()) as { features: { properties: Record<string, unknown> }[] };
    for (const f of fc.features) f.properties["crashes"] = known === null ? 3 : null;
    await route.fulfill({ response: res, json: fc });
  });
  await page.reload();
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".row").first().click();
  const flipped = await page.locator(".figure .l").allTextContents();
  if (known === null) {
    expect(flipped.some((l) => /^bike crashes here (since \d{4}|on record)$/.test(l))).toBe(true);
    await expect(page.locator("#d-rows")).not.toContainText("no counts in this build");
  } else {
    for (const l of flipped) expect(l).not.toContain("crash");
    await expect(page.locator("#d-rows")).toContainText("no counts in this build");
  }
  await page.unroute("**/priorities.geojson");

  // Now a build where the counts came through.
  await page.route("**/priorities.geojson", async (route) => {
    const res = await route.fetch();
    const fc = (await res.json()) as { features: { properties: Record<string, unknown> }[] };
    for (const f of fc.features) f.properties["crashes"] = 4;
    await route.fulfill({ response: res, json: fc });
  });
  await page.reload();
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".row").first().click();
  const withCounts = await page.locator(".figure .l").allTextContents();
  // the period is the pipeline's to state; this snapshot predates the field, so
  // the figure says "on record" rather than naming a year it cannot support
  expect(withCounts.some((l) => /^bike crashes here (since \d{4}|on record)$/.test(l))).toBe(true);
  // and it is marked as the one figure that is bad news
  expect(await page.locator(".figure.warn .n").textContent()).toBe("4");
});

test("a data file that will not load says so instead of showing an empty ranking", async ({
  page,
}) => {
  test.slow();
  // A planner would read a blank list as "no projects here", which is a claim
  // about their city rather than about a failed fetch.
  await page.route("**/priorities.geojson", (route) => route.fulfill({ status: 503, body: "" }));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/build/");
  await expect(page.locator("#empty")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#empty")).toContainText("could not be loaded");
  await expect(page.locator("#empty")).toContainText("503");
  expect(await page.locator(".row").count()).toBe(0);
  await expect(page.locator("#counts")).toBeEmpty();
  // it fails as a message, not as an unhandled rejection
  expect(errors).toEqual([]);

  // Malformed rather than missing: same outcome.
  await page.unroute("**/priorities.geojson");
  await page.route("**/priorities.geojson", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"type":"FeatureCollection","features":[]}' }),
  );
  await page.reload();
  await expect(page.locator("#empty")).toContainText("could not be loaded");
  await expect(page.locator("#empty")).toContainText("no candidates");

  // Present and parseable but not what the page is made of: the fields every
  // render reads are gone, which used to throw past the failure path and leave a
  // blank working tool rather than this message.
  await page.unroute("**/priorities.geojson");
  await page.route("**/priorities.geojson", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "MultiLineString", coordinates: [[[-71.1, 42.38]]] },
            properties: { pid: "x", name: "Somewhere" },
          },
        ],
      }),
    }),
  );
  const late: string[] = [];
  page.on("pageerror", (e) => late.push(String(e)));
  await page.reload();
  await expect(page.locator("#empty")).toContainText("could not be loaded");
  await expect(page.locator("#empty")).toContainText("missing");
  await expect(page.locator("#empty")).toContainText("c_severance");
  expect(await page.locator(".row").count()).toBe(0);
  expect(late, "it threw instead of reporting").toEqual([]);
});

test("the printed one-pager carries its own caveats", async ({ page }) => {
  test.slow();
  await open(page);
  await page.evaluate(() => {
    window.print = () => undefined;
  });
  await page.locator(".row").first().click();

  // On screen the caveats are folded away to keep the panel short.
  expect(
    await page.locator("details.limits").evaluate((d) => (d as HTMLDetailsElement).open),
  ).toBe(false);

  await page.locator("#print").click();
  await page.emulateMedia({ media: "print" });
  // A sheet that prints the heading "What this ranking does not do" over nothing
  // is worse than one that never raised the question.
  await expect(page.locator("#limits li").first()).toBeVisible();
  expect(await page.locator("#limits li").count()).toBeGreaterThan(2);
  // and it states the weighting, which the paper copy has no sliders to show
  await expect(page.locator("#method")).toContainText("the weighting the analysis itself used");
  await expect(page.locator("#method")).toContainText("gap-closing 40%");
  await expect(page.locator("#method")).toContainText("not field measurements");
  await page.emulateMedia({ media: "screen" });

  // A reader's own weighting is named as theirs, next to the published one — a
  // sheet that showed a re-weighted rank as the analysis's would be a forgery.
  await page.locator("#w-crash").fill("100");
  await page.locator("#w-crash").dispatchEvent("input");
  await expect(page.locator("#method")).toContainText("Re-weighted by the reader");
  await expect(page.locator("#method")).toContainText("the published ranking uses");
  await expect(page.locator("#method")).toContainText("gap-closing 22%");
});

test("the browser's own print command opens the caveats too", async ({ page }) => {
  test.slow();
  await open(page);
  await page.locator(".row").first().click();
  // Ctrl+P never goes through the button, so the button cannot be the only place
  // this happens.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("beforeprint"));
  });
  expect(
    await page.locator("details.limits").evaluate((d) => (d as HTMLDetailsElement).open),
  ).toBe(true);
});

test("a street name cannot become a spreadsheet formula", async ({ page }) => {
  test.slow();
  // Names come from OpenStreetMap, which anyone can edit, and a city opens this
  // CSV in Excel.
  await page.route("**/priorities.geojson", async (route) => {
    const res = await route.fetch();
    const fc = (await res.json()) as {
      features: { properties: Record<string, unknown> }[];
    };
    const evil = [
      "=HYPERLINK(\"http://evil.example\",\"click\")",
      "+1+1",
      "-2+3",
      "@SUM(A1:A9)",
      "Main Street, Somerville",
      "\tleading tab",
    ];
    // Every feature, cycling: the ranking keeps one row per gap, so seeding only
    // the first few could drop them all before the CSV was written.
    fc.features.forEach((f, i) => {
      f.properties["name"] = evil[i % evil.length];
    });
    await route.fulfill({ response: res, json: fc });
  });
  await open(page);

  const wait = page.waitForEvent("download");
  await page.locator("#csv").click();
  const stream = await (await wait).createReadStream();
  const text = await new Promise<string>((res, rej) => {
    let acc = "";
    stream.on("data", (c: Buffer) => (acc += c.toString()));
    stream.on("end", () => res(acc));
    stream.on("error", rej);
  });

  // No cell begins with a character a spreadsheet would evaluate.
  for (const line of text.trim().split("\n").slice(1)) {
    // fields, respecting quotes
    const fields: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        fields.push(cur);
        cur = "";
      } else cur += ch;
    }
    fields.push(cur);
    for (const f of fields) {
      expect(f, `a cell starting with a formula character: ${f}`).not.toMatch(/^[=+@]/);
      // A leading "-" is allowed only on an actual number: negative numbers are
      // the reason the rule cannot simply prefix every "-", and a formula
      // disguised as one is the reason it cannot ignore them.
      if (f.startsWith("-")) {
        expect(Number.isFinite(Number(f)), `a non-numeric cell begins with "-": ${f}`).toBe(true);
      }
    }
  }
  // The neutering is visible on the values that needed it, so the loop above is
  // checking a rule that fired rather than an input that never triggered it.
  expect(text, "a leading-minus formula was not neutered").toContain('"\t-2+3"');
  expect(text, "a leading-plus formula was not neutered").toContain('"\t+1+1"');
  expect(text, "a leading-at formula was not neutered").toContain('"\t@SUM(A1:A9)"');
  // and a genuine negative number is left as a number, not turned into text
  const negatives = text.match(/,-\d+(\.\d+)?[,\n]/g) ?? [];
  for (const n of negatives) expect(n).not.toContain("\t");

  // the name is still readable, just inert
  expect(text).toContain("HYPERLINK");
  // and a name containing a comma is still one field
  expect(text).toContain('"Main Street, Somerville"');
});

test("an empty ranking leaves nothing drawn on the map", async ({ page }) => {
  test.slow();
  await open(page);
  // the list renders before the map's load event adds the layers
  await page.waitForFunction(() => window._map?.getLayer("projects") !== undefined, null, {
    timeout: 45_000,
  });
  const before = await page.evaluate(() =>
    JSON.stringify(window._map?.getPaintProperty("projects", "line-opacity")),
  );
  expect(before).toContain("match");

  await page.evaluate(() => {
    const sel = document.getElementById("town") as HTMLSelectElement;
    const o = document.createElement("option");
    o.value = "Nowhere";
    sel.appendChild(o);
    sel.value = "Nowhere";
    sel.dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#empty")).toBeVisible();

  // A `match` with no branches is invalid, and the old widths must not survive:
  // lines left drawn under a filter that excludes them are a false picture.
  const after = await page.evaluate(() =>
    JSON.stringify(window._map?.getPaintProperty("projects", "line-opacity")),
  );
  expect(after).toBe("0");

  // And nothing is actually drawn. queryRenderedFeatures is the wrong instrument
  // — hit-testing ignores opacity, so it returns all 900-odd features either way
  // and an assertion on it passes without meaning anything. Compare the canvas
  // against the same canvas with the layer switched off instead: same camera,
  // same tiles, so identical bytes mean the layer contributed no pixels.
  await page.waitForTimeout(1200);
  const withLayer = await page.locator("#map").screenshot();
  await page.evaluate(() => {
    window._map?.setLayoutProperty("projects", "visibility", "none");
  });
  await page.waitForTimeout(1200);
  const without = await page.locator("#map").screenshot();
  expect(Buffer.compare(withLayer, without), "the layer still drew something").toBe(0);
});

test("a density estimate is not called a headcount by the slider either", async ({ page }) => {
  test.slow();
  await page.route("**/priorities_meta.json", async (route) => {
    const res = await route.fetch();
    const meta = (await res.json()) as { population?: Record<string, unknown> };
    meta.population = { ...(meta.population ?? {}), is_headcount: false };
    await route.fulfill({ response: res, json: meta });
  });
  await open(page);
  // The figure is withheld and the component row is marked, so the control that
  // weights the criterion must not be the one place it still says "residents".
  await expect(page.locator('label[for="w-cov"]')).toHaveText("Residents gaining access (estimated)");
  await page.locator(".row").first().click();
  await expect(page.locator("#d-rows")).toContainText("Residents gaining access (estimated)");

  await page.unroute("**/priorities_meta.json");
  await page.reload();
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('label[for="w-cov"]')).toHaveText("Residents gaining access");
});

test("a project the town filter excludes is not called an alternative", async ({ page }) => {
  test.slow();
  const { loaded } = await open(page);
  await page.locator(".row").first().click();
  await expect(page.locator("#d-rank")).toHaveText(/^Rank 1 of [\d,]+$/);
  const name = await page.locator("#d-name").textContent();

  // Filter to a town the open project is not in. It is off the list for a
  // different reason than sharing a gap with the row that is listed, and saying
  // "alternative" would be a claim about the data.
  const towns = await page.evaluate(() => {
    const pid = document.querySelector<HTMLElement>(".row.on")?.dataset["pid"];
    return { pid, towns: document.getElementById("d-where")?.textContent ?? "" };
  });
  const elsewhere = loaded.towns.find(
    (t) => t !== "" && !towns.towns.includes(t) && t !== "Somerville",
  );
  expect(elsewhere).toBeTruthy();
  await page.locator("#town").selectOption(elsewhere as string);

  await expect(page.locator("#d-name")).toHaveText(name ?? "");
  await expect(page.locator("#d-rank")).toHaveText(`Not in ${elsewhere as string} — showing it anyway`);
  await expect(page.locator("#d-rank")).not.toContainText("Alternative");
});

test("no inline style is allowed, and the map does not need one", async ({ page }) => {
  test.slow();
  // Separate test because the probe below deliberately trips the policy, and the
  // "no CSP refusals" test is about what the page does on its own.
  await open(page);
  await page.locator(".row").first().click();
  const refusals: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") refusals.push(m.text());
  });

  const probe = await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = "#rank-panel { display: none !important }";
    document.head.appendChild(st);
    const panel = document.getElementById("rank-panel");
    // an inline style attribute, the other half of the directive
    const el = document.createElement("div");
    el.setAttribute("style", "position:fixed;left:0;top:0;width:5px;height:5px");
    document.body.appendChild(el);
    return {
      styleApplied: panel !== null && getComputedStyle(panel).display === "none",
      attrApplied: getComputedStyle(el).position === "fixed",
    };
  });
  expect(probe.styleApplied, "an injected <style> element was applied").toBe(false);
  expect(probe.attrApplied, "an injected style attribute was applied").toBe(false);
  await expect.poll(() => refusals.some((r) => /style-src/.test(r))).toBe(true);

  // And the map works anyway: it positions its own furniture through the CSSOM,
  // which CSP does not govern. Asserting a marker merely *has* inline styles
  // could not fail — CSP never blocks element.style.x = y — so this checks the
  // marker is where the project is, which is what the styles are for.
  const placed = await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>(".maplibregl-marker");
    const map = window._map;
    if (!marker || !map) return null;
    const box = map.getCanvas().getBoundingClientRect();
    const r = marker.getBoundingClientRect();
    return {
      inside:
        r.width > 0 && r.height > 0 && r.left >= box.left - 60 && r.right <= box.right + 60,
      moved: marker.style.transform !== "",
    };
  });
  expect(placed).not.toBeNull();
  expect((placed as { inside: boolean }).inside, "the marker was not positioned").toBe(true);
  expect((placed as { moved: boolean }).moved).toBe(true);
});

test("a city page hands the workspace its own town", async ({ page }) => {
  test.slow();
  // The point of the link on a city page: a planner arrives at their own
  // ranking, not the region's with a filter to find.
  await page.goto("/somerville/");
  const link = page.locator('a[href*="build/"]');
  await expect(link).toHaveAttribute("href", "../build/?town=Somerville");
  await link.click();
  await page.waitForURL(/\/build\/\?town=Somerville$/);
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#town")).toHaveValue("Somerville");

  // and the ranking really is that town's
  const towns = await page.evaluate(async () => {
    const fc = (await (await fetch("../data/priorities.geojson")).json()) as {
      features: { properties: Record<string, unknown> }[];
    };
    const byPid = new Map<string, string>();
    for (const f of fc.features) {
      byPid.set(String(f.properties["pid"]), String(f.properties["towns"]));
    }
    return [...document.querySelectorAll<HTMLElement>(".row")]
      .slice(0, 25)
      .map((r) => byPid.get(r.dataset["pid"] ?? "") ?? "?");
  });
  expect(towns.length).toBeGreaterThan(0);
  for (const t of towns) {
    expect(t.split(",").map((x) => x.trim())).toContain("Somerville");
  }
});

test("a town in the URL that does not exist is ignored, not shown as empty", async ({ page }) => {
  test.slow();
  // The reader did not type this; a stale link did. An empty list would read as
  // "nothing to build here".
  await page.goto("/build/?town=Atlantis");
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#town")).toHaveValue("");
  await expect(page.locator("#empty")).toBeHidden();
  expect(await page.locator(".row").count()).toBeGreaterThan(200);
  // and the region's ranking is not passed off as that town's
  await expect(page.locator(".stale-link")).toContainText("Atlantis");
  await expect(page.locator(".stale-link")).toContainText("whole region");

  // The note quotes the link's own words back, so it stops being a place to put
  // arbitrary prose on a page cities read as ours.
  const long = "L".repeat(300);
  await page.goto(`/build/?town=${long}`);
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  const shown = (await page.locator(".stale-link").textContent()) ?? "";
  expect(shown.length).toBeLessThan(160);
  expect(shown).toContain("\u2026");
  expect(shown).not.toContain("L".repeat(60));

  // And it goes as soon as it would contradict the screen.
  await page.locator("#town").selectOption("Somerville");
  await expect(page.locator(".stale-link")).toHaveCount(0);
  await expect(page.locator("#town")).toHaveValue("Somerville");

  // A real town gets no such note.
  await page.goto("/build/?town=Somerville");
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".stale-link")).toHaveCount(0);
});

test("the first ranking a reader sees is the one the pipeline published", async ({ page }) => {
  test.slow();
  // Three surfaces rank the same candidates: the exported `score` field, the
  // app's own list, and this page. If they start from different weights they
  // disagree about which project is first, and a city gets two answers to one
  // question. This page starts from meta.model.weights, which is what `score`
  // was computed with — so at load the two must agree exactly.
  await open(page);
  await expect(page.locator("#v-sev")).toHaveText("40%");
  await expect(page.locator("#v-acc")).toHaveText("30%");
  await expect(page.locator("#v-crash")).toHaveText("15%");
  await expect(page.locator("#v-cov")).toHaveText("15%");

  const agreement = await page.evaluate(async () => {
    const [fc, meta] = (await Promise.all([
      (await fetch("../data/priorities.geojson")).json(),
      (await fetch("../data/priorities_meta.json")).json(),
    ])) as [
      { features: { properties: Record<string, number | string> }[] },
      { model?: { weights?: Record<string, number> } },
    ];
    const w = meta.model?.weights;
    if (!w) return { ok: false, why: "no weights in meta" };

    // the score the pipeline exported, reproduced from its own weights
    let worst = 0;
    for (const f of fc.features) {
      const p = f.properties;
      const s =
        w["severance"]! * Number(p["c_severance"]) +
        w["access"]! * Number(p["c_access"]) +
        w["crash"]! * Number(p["c_crash"]) +
        w["coverage"]! * Number(p["c_coverage"]);
      worst = Math.max(worst, Math.abs(s - Number(p["score"])));
    }

    // the pipeline's own ranking, deduped by gap the same way the page does
    const seen = new Set<string>();
    const pipelineTop = [...fc.features]
      .sort((a, b) => Number(b.properties["score"]) - Number(a.properties["score"]))
      .filter((f) => {
        const g = String(f.properties["group"]);
        if (seen.has(g)) return false;
        seen.add(g);
        return true;
      })
      .slice(0, 20)
      .map((f) => String(f.properties["pid"]));

    const onScreen = [...document.querySelectorAll<HTMLElement>(".row")]
      .slice(0, 20)
      .map((r) => r.dataset["pid"] ?? "");
    return { ok: true, worst, pipelineTop, onScreen };
  });

  expect(agreement.ok, agreement.why).toBe(true);
  // the exported score is reproducible from the published weights
  expect(agreement.worst).toBeLessThan(0.002);
  // and the page's opening order is that ranking, project for project
  expect(agreement.onScreen).toEqual(agreement.pipelineTop);

  // Reset returns to it after the reader has explored.
  await page.locator("#w-crash").fill("100");
  await page.locator("#w-crash").dispatchEvent("input");
  await expect(page.locator("#v-crash")).not.toHaveText("15%");
  await page.locator("#w-reset").click();
  await expect(page.locator("#v-crash")).toHaveText("15%");
  const afterReset = await page.locator(".row").evaluateAll((rs) =>
    rs.slice(0, 20).map((r) => (r as HTMLElement).dataset["pid"] ?? ""),
  );
  expect(afterReset).toEqual(agreement.pipelineTop);
});

test("the what-if is only as specific as the data supports", async ({ page }) => {
  test.slow();
  // Three states, and the shipped snapshot can only show one of them: the field
  // was added to the pipeline after this data was built. A test that checked only
  // the state in front of it would go quiet the week the field arrives — which is
  // exactly when the sentence starts making a stronger claim.
  const withFlag = async (value: boolean | undefined): Promise<string> => {
    await page.unroute("**/priorities.geojson").catch(() => undefined);
    if (value !== undefined) {
      await page.route("**/priorities.geojson", async (route) => {
        const res = await route.fetch();
        const fc = (await res.json()) as {
          features: { properties: Record<string, unknown> }[];
        };
        for (const f of fc.features) f.properties["joins_region"] = value;
        await route.fulfill({ response: res, json: fc });
      });
    }
    await page.goto("/build/");
    await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
    await page.locator(".row").first().click();
    return (await page.locator("#d-whatif").textContent()) ?? "";
  };

  // Field absent: the sentence says a network, and does not say which.
  const absent = await withFlag(undefined);
  expect(absent).toContain("the network on the other side of this gap");
  expect(absent).not.toContain("region");
  expect(absent).not.toContain("larger network");

  // Field true: the region-wide claim is made, because the pipeline made it.
  const region = await withFlag(true);
  expect(region).toContain("the region-wide kid-safe network");

  // Field false: a local join is not dressed up as a region-wide one.
  const local = await withFlag(false);
  expect(local).toContain("the larger network on the other side of this gap");
  expect(local).not.toContain("region-wide");

  // All three keep the two caveats that make the sentence honest.
  for (const text of [absent, region, local]) {
    expect(text).toContain("Modelled on the streets as mapped today");
    expect(text).toContain("the side that gains, not the two sides added together");
  }
});

test("the layout and the camera agree about where the panel is", async ({ page }) => {
  test.slow();
  // Exactly at the breakpoint. The stylesheet's `max-width: 900px` matches at
  // 900, so a 900 px window has the bottom sheet — while the camera code asked
  // whether the width was >= 900 and framed the project as if the panel were on
  // the right, padding 420 px of a 900 px canvas against a sheet that isn't there.
  await open(page, 900);
  await page.locator(".row").first().click();
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => {
    const map = window._map;
    const rank = document.getElementById("rank-panel");
    const pid = document.querySelector<HTMLElement>(".row.on")?.dataset["pid"] ?? "";
    const src = map?.getSource("projects") as unknown as {
      _data?: GeoJSON.FeatureCollection<GeoJSON.MultiLineString>;
    };
    const f = src._data?.features.find((x) => x.properties?.["pid"] === pid);
    const line = f?.geometry.coordinates.flat() as [number, number][] | undefined;
    const box = map?.getCanvas().getBoundingClientRect();
    if (!map || !line || !box || !rank) return null;
    const pts = line.map((c) => map.project(c));
    return {
      // the stylesheet put the ranking away, i.e. this is the phone layout
      sheetLayout: getComputedStyle(rank).display === "none",
      zoom: map.getZoom(),
      framedAbovePanel: pts.every((p) => p.y >= 0 && p.y <= box.height * 0.38),
    };
  });
  expect(state).not.toBeNull();
  const st = state as { sheetLayout: boolean; zoom: number; framedAbovePanel: boolean };
  expect(st.sheetLayout, "900px is the bottom-sheet layout").toBe(true);
  expect(st.zoom, "the camera never moved off the opening view").toBeGreaterThan(12.5);
  expect(st.framedAbovePanel, "framed as if the panel were on the right").toBe(true);
});

test("the town in the URL follows the town on the screen", async ({ page }) => {
  test.slow();
  // A planner who filters to their town and sends the link was sending the whole
  // region — the filter lived only in the DOM.
  await open(page);
  expect(new URL(page.url()).searchParams.get("town")).toBeNull();

  await page.locator("#town").selectOption("Somerville");
  await expect(page.locator(".row").first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get("town")).toBe("Somerville");

  // and reloading that URL lands on the same ranking
  const first = await page.locator(".row .what").first().textContent();
  await page.reload();
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#town")).toHaveValue("Somerville");
  await expect(page.locator(".row .what").first()).toHaveText(first ?? "");

  // clearing the filter clears the parameter rather than leaving a stale one
  await page.locator("#town").selectOption("");
  expect(new URL(page.url()).searchParams.get("town")).toBeNull();
});

test("closing a project takes its marker off the map", async ({ page }) => {
  test.slow();
  await open(page, 390);
  await page.locator(".row").first().click();
  expect(await page.locator(".maplibregl-marker").count()).toBe(1);

  // A pin left standing points at a project the reader has closed, on a map that
  // is showing the whole list again.
  await page.locator("#back-to-list").click();
  await expect(page.locator("#rank-panel")).toBeVisible();
  expect(await page.locator(".maplibregl-marker").count()).toBe(0);

  // and picking again brings back exactly one
  await page.locator(".row").nth(1).click();
  expect(await page.locator(".maplibregl-marker").count()).toBe(1);
});

test("the crash period comes from the data, not from a literal", async ({ page }) => {
  test.slow();
  // "since 2021" was the page's own guess. It was right for this build and would
  // have misdated the figure the year the pipeline's crash years changed.
  await page.route("**/priorities_meta.json", async (route) => {
    const res = await route.fetch();
    const meta = (await res.json()) as { model?: Record<string, unknown> };
    meta.model = { ...(meta.model ?? {}), crash_years: [2029, 2030] };
    await route.fulfill({ response: res, json: meta });
  });
  await page.route("**/priorities.geojson", async (route) => {
    const res = await route.fetch();
    const fc = (await res.json()) as { features: { properties: Record<string, unknown> }[] };
    for (const f of fc.features) f.properties["crashes"] = 2;
    await route.fulfill({ response: res, json: fc });
  });
  await open(page);
  await page.locator(".row").first().click();
  const labels = await page.locator(".figure .l").allTextContents();
  expect(labels).toContain("bike crashes here since 2029");
  expect(labels).not.toContain("bike crashes here since 2021");

  // With no period recorded, it does not invent one.
  await page.unroute("**/priorities_meta.json");
  await page.route("**/priorities_meta.json", async (route) => {
    const res = await route.fetch();
    const meta = (await res.json()) as { model?: Record<string, unknown> };
    if (meta.model) delete meta.model["crash_years"];
    await route.fulfill({ response: res, json: meta });
  });
  await page.reload();
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".row").first().click();
  const bare = await page.locator(".figure .l").allTextContents();
  expect(bare).toContain("bike crashes here on record");
  for (const l of bare) expect(l).not.toMatch(/since \d{4}/);
});
