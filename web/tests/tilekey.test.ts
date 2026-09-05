// The service worker's tile cache key.
//
// Carto serves vector tiles from tiles-a…d and MapLibre picks one per tile, by
// coordinate — measured on the real app, an even split across all four. The
// offline download names tiles-a for every tile it stores, so unless the worker
// folds the four hosts onto one when it looks a tile up, roughly three quarters
// of a fully downloaded route is unfindable. The download still reports
// success; the map is just patchy an hour later on a road with no signal.
//
// sw.js cannot be imported: it is a service worker, and registering listeners
// on `self` at module scope throws under Node. So the function is read out of
// the file the browser actually gets, the same way offline-shell.test.ts checks
// the precache list against the import graph.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

function tileKeyFromSource(): (url: string) => string {
  const sw = readFileSync(join(WEB, "sw.js"), "utf8");
  const fn = /function tileKey\(requestUrl\) \{[\s\S]*?\n\}/.exec(sw);
  expect(fn?.[0], "could not find tileKey in sw.js").toBeTruthy();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${fn?.[0] ?? ""}; return tileKey;`)() as (url: string) => string;
}

const TILE = "/vectortiles/carto.streets/v1/14/4956/6057.mvt";

describe("the service worker's tile cache key", () => {
  const tileKey = tileKeyFromSource();

  it("folds Carto's four tile hosts onto the one the download stores", () => {
    const keys = ["a", "b", "c", "d"].map((s) =>
      tileKey(`https://tiles-${s}.basemaps.cartocdn.com${TILE}`),
    );
    expect(new Set(keys).size, "the four hosts must collapse to one key").toBe(1);
    expect(keys[0]).toBe(`https://tiles-a.basemaps.cartocdn.com${TILE}`);
  });

  it("keeps the tile's own path, so different tiles stay different", () => {
    const one = tileKey("https://tiles-b.basemaps.cartocdn.com/vectortiles/carto.streets/v1/14/1/2.mvt");
    const two = tileKey("https://tiles-c.basemaps.cartocdn.com/vectortiles/carto.streets/v1/14/1/3.mvt");
    expect(one).not.toBe(two);
    expect(one).toContain("/14/1/2.mvt");
  });

  it("leaves every other host alone", () => {
    // The same cache holds the aerial imagery and the styles; rewriting a host
    // that has no siblings would key them under something nothing asks for.
    for (const url of [
      "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      "https://tiles.basemaps.cartocdn.com/fonts/Noto%20Sans%20Regular/0-255.pbf",
      "https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/orthos2023/MapServer/tile/14/6057/4956",
    ]) {
      expect(tileKey(url)).toBe(url);
    }
  });

  it("does not rewrite a host that merely starts the same way", () => {
    // tiles-e, or a tiles-a… that is not one of Carto's four, is somebody
    // else's host and must keep its own identity.
    const other = `https://tiles-e.basemaps.cartocdn.com${TILE}`;
    expect(tileKey(other)).toBe(other);
    // tiles-a.example.com would pass whatever the rule did, since rewriting it
    // to itself changes nothing. tiles-b does the actual work of catching a
    // rule that keys on the prefix rather than on Carto.
    const elsewhere = `https://tiles-b.example.com${TILE}`;
    expect(tileKey(elsewhere)).toBe(elsewhere);
  });
});
