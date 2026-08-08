// The install page: the only route a stranger has from a link on social media
// to the app on their phone. If it's wrong, the launch quietly doesn't work.
import { expect, test } from "@playwright/test";

test("offers a real download, from the release rather than the site", async ({ page }) => {
  await page.goto("/install/");
  const get = page.locator("a.get");
  await expect(get).toBeVisible();
  const href = await get.getAttribute("href");
  // Pages allows ~100 GB a month and the APK is 90 MB — a thousand installs
  // served from the site would spend the month and take the site down with it.
  expect(href).toContain("github.com/pelednoam/safe-bikes-lanes/releases");
  expect(href).toContain("family-bike-router.apk");
  expect(href, "must not be the Pages mirror").not.toContain("github.io");
});

test("tells an iPhone owner the three taps, and names Safari", async ({ page }) => {
  await page.goto("/install/");
  // by heading, not by text: the Android card mentions iPhone too
  const ios = page
    .locator("section.path")
    .filter({ has: page.locator("h2", { hasText: "iPhone" }) });
  await expect(ios).toContainText("Safari");
  await expect(ios).toContainText("Add to Home Screen");
  // the icon is the one picture doing real work here: "the Share button" means
  // nothing to someone who has never gone looking for it
  await expect(ios.locator("svg.share-glyph")).toBeVisible();
  await expect(ios.locator("ol li")).toHaveCount(3);
});

test("is honest about the Android warning rather than pretending it away", async ({ page }) => {
  await page.goto("/install/");
  const android = page
    .locator("section.path")
    .filter({ has: page.locator("h2", { hasText: "Android" }) });
  await expect(android).toContainText(/Play Store/);
  await expect(android).toContainText(/90 MB/);
});

test("runs no script at all, and says so in its policy", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.push(r.url());
  });
  await page.goto("/install/");
  await page.waitForTimeout(400);
  expect(scripts).toHaveLength(0);
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(csp).toContain("default-src 'none'");
});

test("reads on a phone, which is where it will be opened", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/install/");
  // one column, and nothing spilling off the side
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the page must not scroll sideways on a phone").toBeLessThanOrEqual(1);
  await expect(page.locator("a.get")).toBeVisible();
});

test("the planner points people here", async ({ page }) => {
  await page.goto("/");
  await page.locator("#about-btn").click();
  const link = page.locator("#about a[href='install/']");
  await expect(link).toBeVisible();
});

test("the policy actually permits the download it advertises", async ({ page, request }) => {
  // The updater hands the APK to a hidden iframe, so frame-src governs it — and
  // GitHub redirects release downloads to a host of its own choosing
  // (objects.githubusercontent.com once, release-assets. now). Naming a single
  // host blocked the download outright, on the one code path a rider can't work
  // around. Check the policy against where the link really goes.
  await page.goto("/");
  const csp =
    (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")) ??
    "";
  const frameSrc = /frame-src ([^;]*)/.exec(csp)?.[1] ?? "";
  expect(frameSrc).toContain("github.com");

  let finalHost: string;
  try {
    const resp = await request.head(
      "https://github.com/pelednoam/safe-bikes-lanes/releases/latest/download/family-bike-router.apk",
      { maxRedirects: 5, timeout: 20_000 },
    );
    finalHost = new URL(resp.url()).host;
  } catch {
    test.skip(true, "no network for the live redirect check");
    return;
  }
  // the wildcard in the policy has to cover wherever that landed
  const allowed = frameSrc
    .split(/\s+/)
    .filter((s) => s.startsWith("https://"))
    .some((src) => {
      const pattern = src.replace("https://", "");
      return pattern.startsWith("*.")
        ? finalHost.endsWith(pattern.slice(1))
        : finalHost === pattern;
    });
  expect(allowed, `frame-src does not permit ${finalHost}`).toBe(true);
});
