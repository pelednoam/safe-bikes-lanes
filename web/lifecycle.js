// What a ride needs from the page's lifecycle: the screen kept awake, and the
// page not reloaded out from under it.
/** Keeps the screen awake for as long as it is wanted.
 *
 * The browser drops a screen wake lock whenever the page is hidden — an app
 * switch, a notification pulled down, a phone call — and never gives it back. A
 * lock taken once at the start of a ride was therefore gone after the first
 * glance at a message, and the phone went to sleep mid-ride with the route and
 * the voice with it. This takes it again each time the page comes back.
 */
export class ScreenLock {
    constructor(api, visible) {
        this.api = api;
        this.visible = visible;
        this.sentinel = null;
        this.wanted = false;
    }
    /** Keep the screen on from now until release(). */
    async acquire() {
        this.wanted = true;
        await this.request();
    }
    /** Let the screen sleep again. */
    release() {
        this.wanted = false;
        const held = this.sentinel;
        this.sentinel = null;
        void held?.release().catch(() => undefined);
    }
    /** Call on every visibilitychange: coming back into view re-takes a lock
     * the system dropped while the page was hidden. */
    async onVisibilityChange() {
        if (!this.wanted || !this.visible())
            return;
        if (this.sentinel !== null && !this.sentinel.released)
            return;
        await this.request();
    }
    /** Whether the screen is being held awake right now. */
    get held() {
        return this.sentinel !== null && !this.sentinel.released;
    }
    async request() {
        const api = this.api();
        if (api === undefined)
            return; // unsupported: navigation still works
        try {
            const got = await api.request("screen");
            if (!this.wanted) {
                // the ride ended while the request was in flight
                void got.release().catch(() => undefined);
                return;
            }
            this.sentinel = got;
        }
        catch {
            this.sentinel = null; // denied, or asked for while hidden
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
    constructor(busy, reload) {
        this.busy = busy;
        this.reload = reload;
        this.pending = false;
    }
    /** Reload now, or as soon as the page is no longer busy. */
    request() {
        if (this.busy()) {
            this.pending = true;
            return;
        }
        this.reload();
    }
    /** The busy spell is over: carry out a reload that was held back, if any. */
    idle() {
        if (!this.pending || this.busy())
            return;
        this.pending = false;
        this.reload();
    }
    get waiting() {
        return this.pending;
    }
}
