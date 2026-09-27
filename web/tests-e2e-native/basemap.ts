// The app reads its basemap from the website (SITE_BASEMAP in src/basemap.ts):
// the APK doesn't carry the 50 MB file. These tests answer that URL with the
// pinned test copy (test-data.json, npm run test-data) instead, a byte range at
// a time the way GitHub Pages does, so they neither depend on the live site nor
// draw whatever it happens to be serving this month.
import { readFileSync } from "node:fs";

type BrowserContext = import("@playwright/test").BrowserContext;

const SITE_BASEMAP = "https://pelednoam.github.io/safe-bikes-lanes/basemap.pmtiles";
let file: Buffer | undefined;

export async function serveBasemap(context: BrowserContext): Promise<void> {
  file ??= readFileSync("test-data/basemap.pmtiles");
  const body = file;
  await context.route(SITE_BASEMAP, async (route) => {
    const cors = { "access-control-allow-origin": "*", "accept-ranges": "bytes" };
    const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers()["range"] ?? "");
    if (range === null) {
      await route.fulfill({ status: 200, body, headers: cors });
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), body.length - 1);
    await route.fulfill({
      status: 206,
      body: body.subarray(start, end + 1),
      headers: { ...cors, "content-range": `bytes ${start}-${end}/${body.length}` },
    });
  });
}
