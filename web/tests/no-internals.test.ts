// The browser tests talk to MapLibre through its public API and to the app
// through its declared test hooks (window.__*, window._map), never through
// private fields.
//
// Twice a private field changed under the tests and they kept passing on
// nothing. MapLibre 6 wrapped GeoJSONSource._data, and 25 reads of it
// silently returned empty, so a check like "the route didn't change" compared
// nothing with nothing. A leak test counted map._listeners, which the next
// upgrade could empty the same way. Reads now go through getData() and an app
// hook, and this keeps a new one from creeping back.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = ["tests-e2e", "tests-e2e-ride", "tests-e2e-native"];

it("no browser test reads a private field", () => {
  const found: string[] = [];
  for (const dir of SUITES) {
    for (const name of readdirSync(join(WEB, dir)).filter((f) => f.endsWith(".ts"))) {
      readFileSync(join(WEB, dir, name), "utf8")
        .split("\n")
        .forEach((line, i) => {
          // `x._y`, `x?._y`, `)._y` and `]._y`, but not on window (the tests'
          // own variables and the app's hooks live there)
          for (const m of line.matchAll(/([\w$)\]]+)\??\._([A-Za-z]\w*)/g)) {
            if (/(^|\W)window$/.test(m[1] ?? "")) continue;
            if (m[2] === "map") continue; // the app's hook, even when reached through a cast
            found.push(`${dir}/${name}:${i + 1}: ${m[0]}`);
          }
        });
    }
  }
  expect(found, "use MapLibre's public API or an app test hook instead").toEqual([]);
});
