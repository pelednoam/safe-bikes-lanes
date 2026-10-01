// The error-report endpoint: POST /report from the app, filed as GitHub issues.
//
// The answer goes back at once and the filing happens after (waitUntil): a
// report is sent as the page may be closing, and nothing the app does waits
// on it. Errors while filing are logged for `wrangler tail`, never returned.
import { type GitHub, github } from "./github.js";
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
  issue: number;
  /** The day of the issue or of its last comment. */
  day: string;
  pending: number;
}

const SEEN_TTL_S = 180 * 24 * 3600;
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
      await env.REPORTS.put(newKey, String(opened + 1), { expirationTtl: DAY_TTL_S });
      const issue = await gh.create(issueTitle(r), issueBody(r, fp, day));
      await env.REPORTS.put(key, JSON.stringify({ issue, day, pending: 0 } satisfies Seen), {
        expirationTtl: SEEN_TTL_S,
      });
      return;
    }
    seen = { issue: found, day, pending: 0 };
  }
  if (seen.day === day) {
    seen.pending += 1;
    await env.REPORTS.put(key, JSON.stringify(seen), { expirationTtl: SEEN_TTL_S });
    return;
  }
  // The record first, then the comment: if the comment fails the day's count is
  // lost, which is a smaller harm than the other order's, where a failed write
  // after a posted comment made the next report post it again. (A comment, and
  // not a reopened issue: anyone who sees a fingerprint, which is public, could
  // otherwise reopen a closed issue by sending one report.)
  const count = seen.pending + 1;
  const since = seen.day;
  await env.REPORTS.put(key, JSON.stringify({ issue: seen.issue, day, pending: 0 } satisfies Seen), {
    expirationTtl: SEEN_TTL_S,
  });
  await gh.comment(seen.issue, repeatComment(count, since, r));
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
