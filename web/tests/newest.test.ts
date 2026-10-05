import { describe, expect, it } from "vitest";

import { newestWins } from "../src/newest.js";

/** A job whose finish the test controls. */
function gate(): { done: () => void; promise: Promise<void> } {
  let done = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { done, promise };
}

describe("newestWins", () => {
  it("runs a single call as it would be run", async () => {
    const applied: number[] = [];
    const refresh = newestWins(async (isCurrent) => {
      if (isCurrent()) applied.push(1);
    });
    await refresh();
    expect(applied).toEqual([1]);
  });

  it("applies only the newest read when an older one finishes last", async () => {
    const applied: string[] = [];
    const slow = gate();
    const reads = [slow, { done: () => undefined, promise: Promise.resolve() }];
    let n = 0;
    const refresh = newestWins(async (isCurrent) => {
      const label = n === 0 ? "old" : "new";
      await reads[n++]?.promise;
      if (isCurrent()) applied.push(label);
    });
    const first = refresh(); // slow: started first
    const second = refresh(); // fast: overtakes it
    await second;
    expect(applied).toEqual(["new"]);
    slow.done();
    await first;
    expect(applied).toEqual(["new"]); // the old read finished last and applied nothing
  });

  it("does not release an overtaken call until the newest has been applied", async () => {
    const applied: string[] = [];
    const first = gate();
    const second = gate();
    const gates = [first, second];
    let n = 0;
    const refresh = newestWins(async (isCurrent) => {
      const i = n++;
      await gates[i]?.promise;
      if (isCurrent()) applied.push(`read ${i + 1}`);
    });
    let released = false;
    const older = refresh().then(() => {
      released = true;
    });
    void refresh();
    first.done(); // the older read comes back, overtaken, and applies nothing
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    // someone waiting on the older call is not told "the data is in": the newer has not landed
    expect(released).toBe(false);
    second.done();
    await older;
    expect(released).toBe(true);
    expect(applied).toEqual(["read 2"]);
  });

  it("is not held for ever by an older read that never finishes, once a newer one has landed", async () => {
    const applied: string[] = [];
    let n = 0;
    const refresh = newestWins(async (isCurrent) => {
      const i = n++;
      if (i === 0) await new Promise(() => undefined); // a device store that hangs
      if (isCurrent()) applied.push(`read ${i + 1}`);
    });
    const hung = refresh();
    const newer = refresh();
    await newer;
    expect(applied).toEqual(["read 2"]);
    // the call that started the hung read is released too, by the newer one finishing
    await expect(Promise.race([hung, new Promise((r) => setTimeout(() => r("held"), 50))])).resolves.toBeUndefined();
  });

  it("does not crash on an overtaken read that fails, and tells the caller of the newest one's failure", async () => {
    let n = 0;
    const refresh = newestWins(async () => {
      const i = n++;
      if (i === 0) throw new Error("old read failed");
    });
    const first = refresh();
    const second = refresh(); // the first, overtaken, has failed; nobody asked about it
    await expect(second).resolves.toBeUndefined();
    await expect(first).resolves.toBeUndefined();
    const failing = newestWins(async () => {
      throw new Error("newest read failed");
    });
    await expect(failing()).rejects.toThrow("newest read failed");
  });

  it("follows a chain of overtakes to the last", async () => {
    const applied: number[] = [];
    const gates = [gate(), gate(), gate()];
    let n = 0;
    const refresh = newestWins(async (isCurrent) => {
      const i = n++;
      await gates[i]?.promise;
      if (isCurrent()) applied.push(i + 1);
    });
    const calls = [refresh(), refresh(), refresh()];
    gates[0]?.done();
    gates[1]?.done();
    await new Promise((r) => setTimeout(r, 0));
    gates[2]?.done();
    await Promise.all(calls);
    expect(applied).toEqual([3]);
  });
});
