import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests-e2e/**", "node_modules/**"],
    coverage: {
      // src/app.ts is deliberately absent: it is the DOM and map wiring, has no
      // unit tests, and is covered by the Playwright suites instead — counting
      // it here would report a number that means nothing either way. What a
      // representative browser session executes of it is measurable with
      // page.coverage (about half; the full suites exercise more).
      include: ["src/**/*.ts"],
      // Page entry points, not modules: each runs on import (they build a map and
      // fetch data), so a unit test cannot import one without a browser. app.ts is
      // covered by the browser/ride/native suites, city.ts by
      // tests-e2e/city.spec.ts, build.ts by tests-e2e/build-page.spec.ts.
      // Counting them here would report a number that means nothing either way —
      // npm run coverage:app measures app.js for real.
      //
      // build.ts was missing from this list from the day it was written, which
      // put a 0%-covered 800-line file into the global number and left every
      // threshold failing. Nothing noticed, because the deploy gate runs
      // `npm test` and the thresholds only apply under --coverage.
      exclude: ["src/app.ts", "src/build.ts", "src/city.ts", "src/types.ts"],
      // Set just under what the suite achieves today, so this ratchets rather
      // than blocks: raise them when the number rises, never lower them to pass.
      thresholds: {
        statements: 91,
        branches: 79,
        functions: 90,
        lines: 94.5,
      },
    },
  },
});
