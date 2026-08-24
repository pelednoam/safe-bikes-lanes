// The scaling applied to every infrastructure wait in the browser suites.
//
// It exists because a CI runner that got 33% slower failed nine tests on a commit
// that had passed eleven days earlier — all of them map or route waits, all of them
// passing locally against the identical data. A slower machine looked exactly like a
// broken app, which is the most expensive kind of failure to read.
//
// Tested because it is the sort of helper that gets "simplified" into a constant,
// and because the local half is the promise that this changed nothing for anyone
// running the suite on their own machine.
import { afterEach, describe, expect, it } from "vitest";

import { budget } from "../tests-e2e/budget.js";

const saved = process.env["CI"];

afterEach(() => {
  if (saved === undefined) delete process.env["CI"];
  else process.env["CI"] = saved;
});

describe("the wait budget", () => {
  it("is the identity off CI, so a local run behaves exactly as it did", () => {
    // No cache-busting import: budget() reads the environment when it is called,
    // not when the module loads, so one import serves both cases. The query-string
    // version typechecked nowhere and broke the build — caught by CI, because I ran
    // the test after adding it and not the type-check beside it.
    delete process.env["CI"];
    expect(budget(45_000)).toBe(45_000);
    expect(budget(3_000)).toBe(3_000);
    expect(budget(1)).toBe(1);
  });

  it("gives a slower machine room, without changing what is being waited for", () => {
    process.env["CI"] = "true";
    expect(budget(45_000)).toBeGreaterThan(45_000);
    // enough for a runner a few times slower, and bounded so a genuinely stuck
    // test still fails inside the 300 s test timeout rather than hanging
    expect(budget(45_000)).toBeLessThanOrEqual(150_000);
    expect(budget(30_000)).toBeGreaterThan(30_000);
  });
});
