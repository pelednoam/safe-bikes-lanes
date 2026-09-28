// The screen lock a ride holds, and the reload a ride holds back.
import { describe, expect, it } from "vitest";

import { DeferredReload, type LockSentinel, ScreenLock, type WakeLockApi } from "../src/lifecycle.js";

/** navigator.wakeLock the way a phone behaves: hiding the page releases the
 * lock, and a request while hidden is refused. */
class FakeWakeLock implements WakeLockApi {
  requests = 0;
  visible = true;
  live: { released: boolean }[] = [];
  async request(): Promise<LockSentinel> {
    this.requests++;
    if (!this.visible) throw new Error("NotAllowedError: document is hidden");
    const s = {
      released: false,
      release: async (): Promise<void> => {
        s.released = true;
      },
    };
    this.live.push(s);
    return s;
  }
  hide(): void {
    this.visible = false;
    for (const s of this.live) s.released = true; // what the system does
  }
  show(): void {
    this.visible = true;
  }
}

describe("ScreenLock", () => {
  it("takes the lock back when the page returns after being hidden", async () => {
    const api = new FakeWakeLock();
    const lock = new ScreenLock(() => api, () => api.visible);
    await lock.acquire();
    expect(lock.held).toBe(true);

    api.hide(); // a notification pulled down mid-ride
    await lock.onVisibilityChange();
    expect(lock.held).toBe(false);

    api.show();
    await lock.onVisibilityChange();
    expect(lock.held, "the phone would sleep for the rest of the ride").toBe(true);
    expect(api.requests).toBe(2);
  });

  it("does not ask again while the lock is still held", async () => {
    const api = new FakeWakeLock();
    const lock = new ScreenLock(() => api, () => api.visible);
    await lock.acquire();
    await lock.onVisibilityChange();
    expect(api.requests).toBe(1);
  });

  it("stays asleep once the ride is over", async () => {
    const api = new FakeWakeLock();
    const lock = new ScreenLock(() => api, () => api.visible);
    await lock.acquire();
    lock.release();
    expect(api.live[0]?.released).toBe(true);
    api.hide();
    api.show();
    await lock.onVisibilityChange();
    expect(api.requests).toBe(1);
    expect(lock.held).toBe(false);
  });

  it("gives back a lock that arrives after the ride ended", async () => {
    let resolve: ((s: LockSentinel) => void) | undefined;
    const sentinel = {
      released: false,
      release: async (): Promise<void> => {
        sentinel.released = true;
      },
    };
    const api: WakeLockApi = {
      request: () =>
        new Promise<LockSentinel>((r) => {
          resolve = r;
        }),
    };
    const lock = new ScreenLock(() => api, () => true);
    const pending = lock.acquire();
    lock.release();
    resolve?.(sentinel);
    await pending;
    expect(sentinel.released).toBe(true);
    expect(lock.held).toBe(false);
  });

  it("keeps one lock when two requests overlap, and lets the screen sleep after", async () => {
    // the ride starting and the page coming back into view at once: two
    // requests in flight, and the second used to leave the first held with
    // nothing to release it
    const resolvers: ((s: LockSentinel) => void)[] = [];
    const made: { released: boolean }[] = [];
    const api: WakeLockApi = {
      request: () =>
        new Promise<LockSentinel>((r) => {
          resolvers.push(r);
        }),
    };
    const lock = new ScreenLock(() => api, () => true);
    const first = lock.acquire();
    const second = lock.onVisibilityChange();
    for (const r of resolvers) {
      const s = {
        released: false,
        release: async (): Promise<void> => {
          s.released = true;
        },
      };
      made.push(s);
      r(s);
    }
    await Promise.all([first, second]);
    expect(made.length).toBe(2);
    expect(made.filter((m) => !m.released)).toHaveLength(1);
    lock.release();
    await Promise.resolve();
    expect(made.every((m) => m.released)).toBe(true);
  });

  it("keeps a lock it got when an overlapping request is refused", async () => {
    let n = 0;
    const got = {
      released: false,
      release: async (): Promise<void> => {
        got.released = true;
      },
    };
    const api: WakeLockApi = {
      request: async () => {
        n++;
        if (n === 2) throw new Error("NotAllowedError");
        return got;
      },
    };
    const lock = new ScreenLock(() => api, () => true);
    await Promise.all([lock.acquire(), lock.onVisibilityChange()]);
    expect(lock.held).toBe(true);
    lock.release();
    expect(got.released).toBe(true);
  });

  it("is harmless where the browser has no wake lock", async () => {
    const lock = new ScreenLock(() => undefined, () => true);
    await lock.acquire();
    await lock.onVisibilityChange();
    expect(lock.held).toBe(false);
  });
});

describe("DeferredReload", () => {
  it("reloads at once when nothing is going on", () => {
    let reloads = 0;
    const r = new DeferredReload(() => false, () => reloads++);
    r.request();
    expect(reloads).toBe(1);
  });

  it("holds a reload for the length of a ride, then does it", () => {
    let riding = true;
    let reloads = 0;
    const r = new DeferredReload(() => riding, () => reloads++);
    r.request();
    expect(reloads).toBe(0);
    expect(r.waiting).toBe(true);
    r.idle(); // still riding: not yet
    expect(reloads).toBe(0);
    riding = false;
    r.idle();
    expect(reloads).toBe(1);
    r.idle(); // and only once
    expect(reloads).toBe(1);
  });
});
