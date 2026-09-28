// What a ride needs from the page's lifecycle: the screen kept awake, and the
// page not reloaded out from under it.

/** The parts of a WakeLockSentinel used here. */
export interface LockSentinel {
  readonly released: boolean;
  release(): Promise<void>;
}

/** navigator.wakeLock, as far as it is used here. */
export interface WakeLockApi {
  request(type: "screen"): Promise<LockSentinel>;
}

/** Keeps the screen awake for as long as it is wanted.
 *
 * The browser drops a screen wake lock whenever the page is hidden — an app
 * switch, a notification pulled down, a phone call — and never gives it back. A
 * lock taken once at the start of a ride was therefore gone after the first
 * glance at a message, and the phone went to sleep mid-ride with the route and
 * the voice with it. This takes it again each time the page comes back.
 */
export class ScreenLock {
  private sentinel: LockSentinel | null = null;
  private wanted = false;

  constructor(
    private readonly api: () => WakeLockApi | undefined,
    private readonly visible: () => boolean,
  ) {}

  /** Keep the screen on from now until release(). */
  async acquire(): Promise<void> {
    this.wanted = true;
    await this.request();
  }

  /** Let the screen sleep again. */
  release(): void {
    this.wanted = false;
    const held = this.sentinel;
    this.sentinel = null;
    void held?.release().catch(() => undefined);
  }

  /** Call on every visibilitychange: coming back into view re-takes a lock
   * the system dropped while the page was hidden. */
  async onVisibilityChange(): Promise<void> {
    if (!this.wanted || !this.visible()) return;
    if (this.sentinel !== null && !this.sentinel.released) return;
    await this.request();
  }

  /** Whether the screen is being held awake right now. */
  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  private async request(): Promise<void> {
    const api = this.api();
    if (api === undefined) return; // unsupported: navigation still works
    try {
      const got = await api.request("screen");
      // The ride ended while the request was in flight, or another request
      // (the ride starting, and the page coming back into view) got there
      // first: this one would be held with nothing to release it, and the
      // screen would never sleep again.
      if (!this.wanted || this.held) {
        void got.release().catch(() => undefined);
        return;
      }
      this.sentinel = got;
    } catch {
      // Denied, or asked for while hidden: nothing to hold. Not a reason to
      // forget a lock another request did get, which would leave it held with
      // nothing to release it.
    }
  }
}

/** A reload that waits for the ride to end.
 *
 * A new service worker takes over as soon as it installs (skipWaiting +
 * clients.claim), and the page reloads itself to pick up the new build. Mid-ride
 * that reload threw away the route, the guidance and the camera without a word,
 * on a phone in a handlebar mount. It is held until the ride is over instead.
 */
export class DeferredReload {
  private pending = false;

  constructor(
    private readonly busy: () => boolean,
    private readonly reload: () => void,
  ) {}

  /** Reload now, or as soon as the page is no longer busy. */
  request(): void {
    if (this.busy()) {
      this.pending = true;
      return;
    }
    this.reload();
  }

  /** The busy spell is over: carry out a reload that was held back, if any. */
  idle(): void {
    if (!this.pending || this.busy()) return;
    this.pending = false;
    this.reload();
  }

  get waiting(): boolean {
    return this.pending;
  }
}
