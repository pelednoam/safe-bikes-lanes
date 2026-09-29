// The endpoint, and how a report becomes an issue or a count on one.
import { describe, expect, it, vi } from "vitest";

import type { GitHub } from "../src/github.js";
import { fingerprint, type Report } from "../src/report.js";
import { type Ctx, type Env, file, handle, type Seen, type Store } from "../src/worker.js";
import { sample } from "./sample.js";

const SITE = "https://pelednoam.github.io";

function memoryStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => Promise.resolve(data.get(k) ?? null),
    put: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
  };
}

function env(over: Partial<Env> = {}): Env {
  return {
    REPORTS: memoryStore(),
    LIMITER: { limit: () => Promise.resolve({ success: true }) },
    GITHUB_TOKEN: "t",
    REPO: "pelednoam/safe-bikes-lanes",
    ALLOWED_ORIGINS: `${SITE}, https://localhost`,
    DAILY_CAP: "200",
    DAILY_NEW_CAP: "20",
    ...over,
  };
}

function fakeGitHub(existing: number | null = null): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    find: (m) => {
      calls.push(`find ${m}`);
      return Promise.resolve(existing);
    },
    create: (title) => {
      calls.push(`create ${title}`);
      return Promise.resolve(7);
    },
    comment: (n, body) => {
      calls.push(`comment ${n} ${body}`);
      return Promise.resolve();
    },
    reopen: (n) => {
      calls.push(`reopen ${n}`);
      return Promise.resolve();
    },
  };
}

function ctx(): Ctx & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (p) => pending.push(p) };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://reports.example.workers.dev/report", {
    method: "POST",
    headers: { origin: SITE, "content-type": "text/plain", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("the endpoint", () => {
  it("takes a report from the site, answers at once, and files it after", async () => {
    const c = ctx();
    const gh = fakeGitHub();
    const resp = await handle(post(sample()), env(), c, { gh });
    expect(resp.status).toBe(202);
    expect(resp.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(gh.calls).toEqual([]);
    await Promise.all(c.pending);
    expect(gh.calls.at(-1)).toMatch(/^create /);
  });

  it("files what it scrubbed, not what it was sent", async () => {
    const c = ctx();
    const gh = fakeGitHub();
    await handle(post(sample({ message: "no route to -71.0867,42.3626" })), env(), c, { gh });
    await Promise.all(c.pending);
    expect(gh.calls.at(-1)).toBe("create [error] no route to ‹n›,‹n›");
  });

  it("logs a GitHub that fails, and never throws it at the page", async () => {
    const c = ctx();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const gh = { ...fakeGitHub(), create: () => Promise.reject(new Error("GitHub create: 401")) };
    expect((await handle(post(sample()), env(), c, { gh })).status).toBe(202);
    await Promise.all(c.pending);
    expect(errors).toHaveBeenCalledWith("filing a report failed:", "GitHub create: 401");
    errors.mockRestore();
  });

  it("takes the app's reports too", async () => {
    const c = ctx();
    const report = post({ ...sample(), platform: "android" }, { origin: "https://localhost" });
    expect((await handle(report, env(), c, { gh: fakeGitHub() })).status).toBe(202);
  });

  it("refuses any other origin, or none", async () => {
    expect((await handle(post(sample(), { origin: "https://evil.example" }), env(), ctx(), { gh: fakeGitHub() })).status).toBe(403);
    const bare = new Request("https://r.example/report", { method: "POST", body: "{}" });
    expect((await handle(bare, env(), ctx(), { gh: fakeGitHub() })).status).toBe(403);
  });

  it("answers a preflight from the site", async () => {
    const pre = new Request("https://r.example/report", { method: "OPTIONS", headers: { origin: SITE } });
    const resp = await handle(pre, env(), ctx(), { gh: fakeGitHub() });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-methods")).toBe("POST");
  });

  it("knows only /report, and only POST", async () => {
    expect((await handle(new Request("https://r.example/"), env(), ctx(), { gh: fakeGitHub() })).status).toBe(404);
    const get = new Request("https://r.example/report", { headers: { origin: SITE } });
    expect((await handle(get, env(), ctx(), { gh: fakeGitHub() })).status).toBe(405);
  });

  it("refuses what isn't a report, and files nothing for it", async () => {
    const c = ctx();
    expect((await handle(post("not json"), env(), c, { gh: fakeGitHub() })).status).toBe(400);
    expect((await handle(post({ ...sample(), where: "home" }), env(), c, { gh: fakeGitHub() })).status).toBe(400);
    expect(c.pending).toHaveLength(0);
  });

  it("refuses a body over the limit", async () => {
    const big = JSON.stringify({ ...sample(), message: "x".repeat(20_000) });
    expect((await handle(post(big), env(), ctx(), { gh: fakeGitHub() })).status).toBe(413);
  });

  it("slows down a sender that sends too many", async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const resp = await handle(post(sample(), { "cf-connecting-ip": "203.0.113.9" }), env({ LIMITER: limiter }), ctx(), { gh: fakeGitHub() });
    expect(resp.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
  });
});

describe("filing", () => {
  const day1 = new Date("2026-09-29T12:00:00Z");
  const day2 = new Date("2026-09-30T08:00:00Z");

  async function seen(e: Env, r: Report): Promise<Seen> {
    const raw = await e.REPORTS.get(`fp:${await fingerprint(r)}`);
    return JSON.parse(raw ?? "null") as Seen;
  }

  it("opens an issue the first time", async () => {
    const e = env();
    const gh = fakeGitHub();
    await file(sample(), e, gh, day1);
    expect(gh.calls).toEqual([
      expect.stringMatching(/^find fp-[0-9a-f]{12}$/),
      "create [error] TypeError: Cannot read properties of undefined (reading 'lngLat')",
    ]);
    expect(await seen(e, sample())).toEqual({ issue: 7, day: "2026-09-29", pending: 0 });
  });

  it("counts repeats the same day without a word, then says how many the next day", async () => {
    const e = env();
    const gh = fakeGitHub();
    await file(sample(), e, gh, day1);
    await file(sample(), e, gh, day1);
    await file(sample(), e, gh, day1);
    expect(gh.calls).toHaveLength(2);
    expect((await seen(e, sample())).pending).toBe(2);

    await file(sample({ build: "app-v56 1234567" }), e, gh, day2);
    expect(gh.calls.slice(2)).toEqual([
      "comment 7 Seen 3 more times since 2026-09-29, most recently on the planner page · web · build app-v56 1234567.",
      "reopen 7",
    ]);
    expect(await seen(e, sample())).toEqual({ issue: 7, day: "2026-09-30", pending: 0 });
  });

  it("finds the issue again when its record is gone, instead of opening another", async () => {
    const e = env();
    const gh = fakeGitHub(31);
    await file(sample(), e, gh, day1);
    expect(gh.calls).toEqual([expect.stringMatching(/^find /)]);
    expect(await seen(e, sample())).toEqual({ issue: 31, day: "2026-09-29", pending: 1 });
  });

  it("opens only so many new issues a day, and still counts the ones it has", async () => {
    const e = env({ DAILY_NEW_CAP: "2" });
    const gh = fakeGitHub();
    for (const m of ["one", "two", "three", "four"]) await file(sample({ message: m }), e, gh, day1);
    expect(gh.calls.filter((c) => c.startsWith("create"))).toHaveLength(2);
    await file(sample({ message: "one" }), e, gh, day1);
    expect((await seen(e, sample({ message: "one" }))).pending).toBe(1);
  });

  it("stops for the day at the cap", async () => {
    const e = env({ DAILY_CAP: "2" });
    const gh = fakeGitHub();
    await file(sample(), e, gh, day1);
    await file(sample({ message: "another" }), e, gh, day1);
    await file(sample({ message: "a third" }), e, gh, day1);
    expect(gh.calls.filter((c) => c.startsWith("create"))).toHaveLength(2);
    // and starts again the next
    await file(sample({ message: "a third" }), e, gh, day2);
    expect(gh.calls.filter((c) => c.startsWith("create"))).toHaveLength(3);
  });
});
