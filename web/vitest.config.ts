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
      exclude: ["src/app.ts", "src/types.ts"],
      // Set just under what the suite achieves today, so this ratchets rather
      // than blocks: raise them when the number rises, never lower them to pass.
      thresholds: {
        statements: 78,
        branches: 68,
        functions: 74,
        lines: 82,
      },
    },
  },
});
