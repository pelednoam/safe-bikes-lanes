// Loading what the app cannot work without, again, until it arrives.
//
// The routing tile manifest and the display network's manifest are each
// fetched once at startup. When that fetch failed — a flaky connection, a
// captive portal, the site mid-deploy — the routing one left "loading map…"
// on screen for good beside an error nobody could act on, and the network one
// had no handler at all: every pan of the map after that raised another
// unhandled rejection and drew an empty network layer, silently.
/** Waits between attempts; the last one repeats for as long as it takes. */
export const RETRY_DELAYS_MS = [2000, 5000, 10000, 30000];
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Resolve with fn()'s result, trying again after each failure. It never
 * rejects: what it loads is something the app cannot start without. */
export async function withRetry(fn, opts = {}) {
    const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
    const sleep = opts.sleep ?? realSleep;
    for (let attempt = 1;; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 30000;
            opts.onRetry?.(err, attempt, delay);
            await sleep(delay);
        }
    }
}
