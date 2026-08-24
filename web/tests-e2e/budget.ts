/** How long to wait for infrastructure, scaled for the machine doing the waiting.
 *
 * The failure this exists for: on 2026-08-24 the deploy gate failed nine tests on a
 * commit that had passed eleven days earlier, with no code change and a data
 * snapshot of the same size. Every one of them was a map or route wait timing out —
 * and all nine passed locally against that exact snapshot. The runner had simply
 * got slower: the same suite went from 24 to 32 minutes.
 *
 * The overall test timeout was already scaled for CI. The waits inside the tests
 * were not, so they failed while the test still had budget left, and a slower
 * runner looked exactly like a broken app.
 *
 * Only for waits on slow infrastructure — booting a WebGL map, computing a route
 * across two cities. NOT for waits that assert something is fast: "the local search
 * answers within three seconds" is a claim about the code, and stretching it on CI
 * would quietly stop testing it.
 */
export function budget(ms: number): number {
  return process.env["CI"] === undefined ? ms : ms * 3;
}
