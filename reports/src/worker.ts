// The error-report endpoint: POST /report from the app, filed as GitHub issues.
//
// The answer goes back at once and the filing happens after (waitUntil): a
// report is sent as the page may be closing, and nothing the app does waits
// on it. Errors while filing are logged for `wrangler tail`, never returned.
import { type Created, type GitHub, GitHubError, github, LABEL } from "./github.js";
import {
  check,
  fingerprint,
  issueBody,
  issueTitle,
  LIMITS,
  marker,
  type Report,
  repeatComment,
  scrubbed,
} from "./report.js";

/** A cap from the environment, or its default if it is missing, not a number,
 * or negative. `filed >= Number(undefined)` is false for every count, so a cap
 * that failed to parse used to limit nothing: the setting that exists to stop a
 * flood failed open. */
export function capOf(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}
const DEFAULT_DAILY_CAP = 200;
const DEFAULT_DAILY_NEW_CAP = 20;

/** The request's body as text, or null if it is longer than `max` bytes. Read
 * a chunk at a time and given up on at the limit, since without a
 * Content-Length (a chunked upload) `req.text()` takes the whole of whatever
 * is sent into memory before anything can be checked. */
export async function readLimited(req: Request, max: number): Promise<string | null> {
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The parts of Workers KV used here. */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A Workers rate-limiting binding. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  REPORTS: Store;
  LIMITER: Limiter;
  /** A fine-grained token for this one repository, with Issues read and write. */
  GITHUB_TOKEN: string;
  /** owner/name */
  REPO: string;
  /** Comma-separated origins allowed to send reports. */
  ALLOWED_ORIGINS: string;
  /** Reports filed a day, across everyone, before the rest are dropped. */
  DAILY_CAP: string;
  /** New issues opened a day. Lower: the Origin check stops other sites'
   * pages, not a script that claims to be ours, and a new issue is the one
   * thing such a script could fill the repository with. */
  DAILY_NEW_CAP: string;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

/** What is kept per problem: its issue, and the repeats not yet commented. */
export interface Seen {
  /** The issue has no "error report" label (GitHub dropped it): find() can't see
   * it, so its record is all that stops a repeat filing another, and it must not
   * expire. Every write of the record has to keep it that way. */
  unlabelled?: boolean;
  issue: number;
  /** The day of the issue or of its last comment. */
  day: string;
  pending: number;
}

const SEEN_TTL_S = 180 * 24 * 3600;
/** How a problem's record is stored: a labelled issue's expires (find() will see it
 * again), an unlabelled one's doesn't (find() never will). */
const ttlOf = (seen: { unlabelled?: boolean }): { expirationTtl: number } | undefined =>
  seen.unlabelled === true ? undefined : { expirationTtl: SEEN_TTL_S };
const DAY_TTL_S = 3 * 24 * 3600;

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function cors(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function answer(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** Takes one off the day's count of new issues, from what the count is now: other
 * reports have taken slots since, and writing back the count read earlier would
 * erase theirs. A KV failure here is swallowed: it mustn't replace GitHub's error. */
async function giveBackSlot(env: Env, key: string): Promise<void> {
  try {
    const current = Number((await env.REPORTS.get(key)) ?? "1");
    await env.REPORTS.put(key, String(Math.max(0, current - 1)), { expirationTtl: DAY_TTL_S });
  } catch {
    // the slot stays taken: a flood limit that errs on the safe side
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Forgets a record. KV allows one write to a key a second and the record was
 * written a moment ago (the repeat path writes it before the comment), so a delete
 * can be refused: it is tried again after a second, a few times. A record that
 * can't be deleted is left, and said so: for an unlabelled issue it never expires. */
async function forget(env: Env, key: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await env.REPORTS.delete(key);
      return;
    } catch (err) {
      if (attempt === 3) {
        console.error(`could not forget the record of a gone issue (${key}):`, err instanceof Error ? err.message : err);
        return;
      }
      await sleep(1100);
    }
  }
}

/** An issue the Worker can no longer comment on because it is gone: deleted or
 * transferred (410, and a 404 while the repository is still readable: a token that
 * has lost access to the repository gets the same 404 and must not lose its
 * records), or locked (403, "locked": GitHub's own words). Anything else, a rate
 * limit or a bad token, is not the issue's fault. */
async function issueIsGone(err: unknown, gh: GitHub): Promise<boolean> {
  if (!(err instanceof GitHubError)) return false;
  if (err.status === 410) return true;
  if (err.status === 403) return /locked/i.test(err.message);
  return err.status === 404 && (await gh.reachable());
}

/** File one checked, scrubbed report: a new issue, or a count on its own. */
export async function file(r: Report, env: Env, gh: GitHub, now: Date): Promise<void> {
  const day = today(now);
  const dayKey = `day:${day}`;
  // Approximate: KV is eventually consistent, so a burst can pass the cap by a
  // few. It is there so a loop in the app can't file a thousand comments.
  const filed = Number((await env.REPORTS.get(dayKey)) ?? "0");
  if (filed >= capOf(env.DAILY_CAP, DEFAULT_DAILY_CAP)) return;
  await env.REPORTS.put(dayKey, String(filed + 1), { expirationTtl: DAY_TTL_S });

  const fp = await fingerprint(r);
  const key = `fp:${fp}`;
  const raw = await env.REPORTS.get(key);
  let seen: Seen;
  if (raw !== null) {
    seen = JSON.parse(raw) as Seen;
  } else {
    // The record may have expired, or been lost, while the issue lives on:
    // then this is a repeat, counted from today.
    const found = await gh.find(marker(fp));
    if (found === null) {
      const newKey = `new:${day}`;
      const opened = Number((await env.REPORTS.get(newKey)) ?? "0");
      if (opened >= capOf(env.DAILY_NEW_CAP, DEFAULT_DAILY_NEW_CAP)) return;
      // The slot is taken before the issue is made, so that the window between
      // reading the count and writing it isn't a round trip to GitHub (a crash right
      // after a deploy, across every rider, would all read the same count and file).
      // That narrows the window; it doesn't close it. KV has no atomic increment and
      // its reads can be a minute stale at another location, so the cap is a limit
      // on a flood, not an exact count (a Durable Object would make it exact).
      await env.REPORTS.put(newKey, String(opened + 1), { expirationTtl: DAY_TTL_S });
      let made: Created;
      try {
        made = await gh.create(issueTitle(r), issueBody(r, fp, day));
      } catch (err) {
        // Given back only when GitHub plainly refused (a 4xx: nothing was made).
        // A network failure or a 5xx may have filed the issue before it failed, and
        // then the slot is spent. And given back by taking one off what is there
        // now, not by writing back what was read: other reports have taken slots
        // since, and restoring the old count would erase theirs.
        if (err instanceof GitHubError && err.status >= 400 && err.status < 500) {
          await giveBackSlot(env, newKey);
        }
        throw err;
      }
      // Recorded whether or not it has its label: the issue is public, and without
      // a record the next report of the same error would file another, which nothing
      // finds (find() looks at labelled issues) and nothing counts. An unlabelled
      // issue's record doesn't expire: once it did, find() could never see the issue
      // again and the error would file a fresh one every SEEN_TTL_S.
      await env.REPORTS.put(
        key,
        JSON.stringify({ issue: made.number, day, pending: 0, ...(made.labelled ? {} : { unlabelled: true }) } satisfies Seen),
        ttlOf({ unlabelled: !made.labelled }),
      );
      if (!made.labelled) {
        throw new Error(
          `issue #${made.number} was filed without the "${LABEL}" label: the token needs Issues: Read and write on this repository (fine-grained), or triage access (classic)`,
        );
      }
      return;
    }
    seen = { issue: found, day, pending: 0 };
  }
  if (seen.day === day) {
    seen.pending += 1;
    await env.REPORTS.put(key, JSON.stringify(seen), ttlOf(seen));
    return;
  }
  // The record first, then the comment: if the comment fails the day's count is
  // lost, which is a smaller harm than the other order's, where a failed write
  // after a posted comment made the next report post it again. (A comment, and
  // not a reopened issue: anyone who sees a fingerprint, which is public, could
  // otherwise reopen a closed issue by sending one report.)
  const count = seen.pending + 1;
  const since = seen.day;
  await env.REPORTS.put(
    key,
    JSON.stringify({ issue: seen.issue, day, pending: 0, ...(seen.unlabelled === true ? { unlabelled: true } : {}) } satisfies Seen),
    ttlOf(seen),
  );
  try {
    await gh.comment(seen.issue, repeatComment(count, since, r));
  } catch (err) {
    // A record that never expires would otherwise comment on a gone issue for ever,
    // and the error would never be filed again: the record goes with the issue, so
    // the next report files it afresh.
    if (await issueIsGone(err, gh)) await forget(env, key);
    throw err;
  }
}

/** What the tests put in place of GitHub and the clock. */
export interface Deps {
  gh?: GitHub;
  now?: Date;
}

export async function handle(req: Request, env: Env, ctx: Ctx, deps: Deps = {}): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/report") return answer(404);
  const origin = req.headers.get("origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  if (!allowed.includes(origin)) return answer(403);
  if (req.method === "OPTIONS") return answer(204, cors(origin));
  if (req.method !== "POST") return answer(405, cors(origin));

  const who = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.LIMITER.limit({ key: who })).success) return answer(429, cors(origin));

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > LIMITS.body) return answer(413, cors(origin));
  const text = await readLimited(req, LIMITS.body);
  if (text === null) return answer(413, cors(origin));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, cors(origin));
  }
  const checked = check(body);
  if (!checked.ok) return answer(400, cors(origin));

  const report = scrubbed(checked.report);
  const gh = deps.gh ?? github(env.REPO, env.GITHUB_TOKEN);
  ctx.waitUntil(
    file(report, env, gh, deps.now ?? new Date()).catch((e: unknown) => {
      console.error("filing a report failed:", e instanceof Error ? e.message : e);
    }),
  );
  return answer(202, cors(origin));
}

export default {
  fetch: (req: Request, env: Env, ctx: Ctx): Promise<Response> => handle(req, env, ctx),
};
