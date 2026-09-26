// Startup data that failed to load is tried again, with growing waits.
import { describe, expect, it } from "vitest";

import { withRetry } from "../src/retry.js";

describe("withRetry", () => {
  it("tries again after each failure, backing off, until it loads", async () => {
    let calls = 0;
    const slept: number[] = [];
    const told: string[] = [];
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new Error(`offline ${calls}`);
        return "manifest";
      },
      {
        delaysMs: [100, 200],
        sleep: async (ms) => {
          slept.push(ms);
        },
        onRetry: (err, attempt, ms) => told.push(`${attempt}:${(err as Error).message}:${ms}`),
      },
    );
    expect(out).toBe("manifest");
    expect(calls).toBe(4);
    // the last wait repeats rather than giving up
    expect(slept).toEqual([100, 200, 200]);
    expect(told).toEqual(["1:offline 1:100", "2:offline 2:200", "3:offline 3:200"]);
  });

  it("does not wait at all when the first try works", async () => {
    const slept: number[] = [];
    await withRetry(async () => 1, { sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([]);
  });
});

describe("withRetry with its own clock", () => {
  it("really waits between attempts when no clock is injected", async () => {
    // Every case above passes a fake sleep, so the real one — the only one the
    // app ever uses — never ran. Zero-length delays keep it fast while still
    // going through setTimeout.
    let calls = 0;
    const started = Date.now();
    const value = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("offline");
        return "manifest";
      },
      { delaysMs: [0] },
    );
    expect(value).toBe("manifest");
    expect(calls).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
