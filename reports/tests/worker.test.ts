// The endpoint, and how a report becomes an issue or a count on one.
import { describe, expect, it, vi } from "vitest";

import { GitHubError, type GitHub } from "../src/github.js";
import { fingerprint, type Report } from "../src/report.js";
import { capOf, type Ctx, type Env, file, handle, readLimited, type Seen, type Store } from "../src/worker.js";
import { sample } from "./sample.js";

const SITE = "https://pelednoam.github.io";

function memoryStore(): Store & { data: Map<string, string>; ttl: Map<string, number | undefined> } {
  const data = new Map<string, string>();
  const ttl = new Map<string, number | undefined>();
  return {
    data,
    ttl,
    get: (k) => Promise.resolve(data.get(k) ?? null),
    put: (k, v, options) => {
      data.set(k, v);
      ttl.set(k, options?.expirationTtl);
      return Promise.resolve();
    },
    delete: (k) => {
      data.delete(k);
      ttl.delete(k);
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

function fakeGitHub(existing: number | null = null, reachable = true): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reachable: () => Promise.resolve(reachable),
    find: (m) => {
      calls.push(`find ${m}`);
      return Promise.resolve(existing);
    },
    create: (title) => {
      calls.push(`create ${title}`);
      return Promise.resolve({ number: 7, labelled: true });
    },
    comment: (n, body) => {
      calls.push(`comment ${n} ${body}`);
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
    // a comment, never a reopened issue: a fingerprint is public text
    expect(gh.calls.slice(2)).toEqual([
      "comment 7 Seen 3 more times since 2026-09-29, most recently on the `planner` page, `web`, build `app-v56 1234567`.",
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

  it("records an issue GitHub filed without its label, so a repeat doesn't file another", async () => {
    // a token without triage access has the label dropped from a 201: the issue
    // is public, and find() (labelled issues only) can never see it
    const e = env({ DAILY_NEW_CAP: "5" });
    const gh = { ...fakeGitHub(), create: () => Promise.resolve({ number: 42, labelled: false }) };
    await expect(file(sample(), e, gh, day1)).rejects.toThrow(/issue #42 was filed without the "error report" label/);
    // the issue is counted against the day, and remembered
    expect(await e.REPORTS.get("new:2026-09-29")).toBe("1");
    expect(await seen(e, sample())).toEqual({ issue: 42, day: "2026-09-29", pending: 0, unlabelled: true });
    // so the same error again is a repeat of #42, not a new issue
    const again = fakeGitHub();
    await file(sample(), e, again, day1);
    expect(again.calls).toEqual([]);
    expect((await seen(e, sample())).pending).toBe(1);
  });

  it("takes the day's slot before it makes the issue, so a burst can't all read the same count", async () => {
    const e = env({ DAILY_NEW_CAP: "2" });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const slow = {
      ...fakeGitHub(),
      create: async () => {
        await held;
        return { number: 1, labelled: true };
      },
    };
    const first = file(sample({ message: "a" }), e, slow, day1);
    const second = file(sample({ message: "b" }), e, slow, day1);
    // let both reach the create: the count the second reads is the first's slot
    await new Promise((r) => setTimeout(r, 20));
    expect(await e.REPORTS.get("new:2026-09-29")).toBe("2");
    release();
    await Promise.all([first, second]);
  });

  it("gives the slot back when GitHub plainly refused, by taking one off what is there now", async () => {
    // A's create is refused after B has taken a slot: writing back the count A
    // read (0) would erase B's. Taking one off the current count leaves B's.
    const e = env({ DAILY_NEW_CAP: "5" });
    let refuse: () => void = () => undefined;
    const refusing = new Promise<void>((_, no) => (refuse = () => no(new GitHubError("GitHub create: 422", 422))));
    const a = { ...fakeGitHub(), create: () => refusing.then(() => ({ number: 1, labelled: true })) };
    const aDone = file(sample({ message: "a" }), e, a, day1).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 10));
    expect(await e.REPORTS.get("new:2026-09-29")).toBe("1");
    // B takes a slot, and files, while A is still waiting on GitHub
    await file(sample({ message: "b" }), e, fakeGitHub(), day1);
    expect(await e.REPORTS.get("new:2026-09-29")).toBe("2");
    refuse();
    expect(await aDone).toBeInstanceOf(GitHubError);
    // 2 - 1: B's issue is still counted
    expect(await e.REPORTS.get("new:2026-09-29")).toBe("1");
  });

  it("keeps the slot when the outcome is unknown: a network failure or a 5xx may have filed it", async () => {
    const e = env({ DAILY_NEW_CAP: "5" });
    const down = { ...fakeGitHub(), create: () => Promise.reject(new TypeError("fetch failed")) };
    await expect(file(sample({ message: "one" }), e, down, day1)).rejects.toThrow("fetch failed");
    const broken = {
      ...fakeGitHub(),
      create: () => Promise.reject(new GitHubError("GitHub create: 502", 502)),
    };
    await expect(file(sample({ message: "two" }), e, broken, day1)).rejects.toThrow("502");
    expect(await e.REPORTS.get("new:2026-09-29")).toBe("2");
  });

  it("doesn't count a create that was refused against the day's new issues", async () => {
    const e = env({ DAILY_NEW_CAP: "1" });
    const refused = {
      ...fakeGitHub(),
      create: () => Promise.reject(new GitHubError("GitHub create: 422", 422)),
    };
    await expect(file(sample({ message: "one" }), e, refused, day1)).rejects.toThrow("422");
    await expect(file(sample({ message: "two" }), e, refused, day1)).rejects.toThrow("422");
    // the cap of one is still unspent when GitHub works again
    const gh = fakeGitHub();
    await file(sample({ message: "three" }), e, gh, day1);
    expect(gh.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });

  it("keeps an unlabelled issue's record from ever expiring through every later write of it", async () => {
    // creation wrote it without an expiry, and the repeats, same-day and next-day,
    // wrote it back with one: after which find() (labelled issues only) couldn't see
    // the issue and the error filed another
    const e = env({ DAILY_NEW_CAP: "5" });
    const store = e.REPORTS as ReturnType<typeof memoryStore>;
    const fp = `fp:${await fingerprint(sample())}`;
    const gh = { ...fakeGitHub(), create: () => Promise.resolve({ number: 42, labelled: false }) };
    await expect(file(sample(), e, gh, day1)).rejects.toThrow();
    expect(store.ttl.get(fp)).toBeUndefined();
    await file(sample(), e, fakeGitHub(), day1); // the same day: counted
    expect(store.ttl.get(fp), "still no expiry after a repeat the same day").toBeUndefined();
    const next = fakeGitHub();
    await file(sample(), e, next, day2); // the next day: commented on
    expect(next.calls[0]).toMatch(/^comment 42 /);
    expect(store.ttl.get(fp), "still no expiry after the comment").toBeUndefined();
    expect(JSON.parse(store.data.get(fp) ?? "{}")).toMatchObject({ issue: 42, unlabelled: true });
  });

  it("forgets the record of an issue that is gone, so the error is filed again instead of commented on for ever", async () => {
    const e = env({ DAILY_NEW_CAP: "5" });
    const gh1 = { ...fakeGitHub(), create: () => Promise.resolve({ number: 42, labelled: false }) };
    await expect(file(sample(), e, gh1, day1)).rejects.toThrow();
    // the maintainer deleted #42
    const gone = {
      ...fakeGitHub(),
      comment: () => Promise.reject(new GitHubError("GitHub comment: 404 Not Found", 404)),
    };
    await expect(file(sample(), e, gone, day2)).rejects.toBeInstanceOf(GitHubError);
    expect(await seen(e, sample())).toBeNull();
    // so the next report starts it again
    const again = fakeGitHub();
    await file(sample(), e, again, day2);
    expect(again.calls.at(-1)).toMatch(/^create /);
  });

  it("forgets the record of a locked issue too: GitHub answers a comment on one with a 403 that says so", async () => {
    const e = env();
    await file(sample(), e, fakeGitHub(), day1);
    const locked = {
      ...fakeGitHub(),
      comment: () =>
        Promise.reject(new GitHubError("GitHub comment: 403 Unable to create comment because issue is locked", 403)),
    };
    await expect(file(sample(), e, locked, day2)).rejects.toBeInstanceOf(GitHubError);
    expect(await seen(e, sample())).toBeNull();
  });

  it("keeps the record on any other 403, a rate limit or a bad token: that isn't the issue's fault", async () => {
    const e = env();
    await file(sample(), e, fakeGitHub(), day1);
    const limited = {
      ...fakeGitHub(),
      comment: () => Promise.reject(new GitHubError("GitHub comment: 403 API rate limit exceeded", 403)),
    };
    await expect(file(sample(), e, limited, day2)).rejects.toBeInstanceOf(GitHubError);
    expect((await seen(e, sample()))?.issue).toBe(7);
  });

  it("keeps the record when the 404 is the token losing the repository, which answers 404 for everything", async () => {
    const e = env();
    await file(sample(), e, fakeGitHub(), day1);
    const blind = {
      ...fakeGitHub(null, false), // the repository can't be read either
      comment: () => Promise.reject(new GitHubError("GitHub comment: 404 Not Found", 404)),
    };
    await expect(file(sample(), e, blind, day2)).rejects.toBeInstanceOf(GitHubError);
    expect((await seen(e, sample()))?.issue).toBe(7);
  });

  it("tries again to forget a record when KV refuses the delete, which it does within a second of a write", async () => {
    vi.useFakeTimers();
    try {
      const e = env();
      const store = e.REPORTS as ReturnType<typeof memoryStore>;
      await file(sample(), e, fakeGitHub(), day1);
      const realDelete = store.delete.bind(store);
      let refusals = 2;
      store.delete = (k) => (refusals-- > 0 ? Promise.reject(new Error("429 Too Many Requests")) : realDelete(k));
      const gone = {
        ...fakeGitHub(),
        comment: () => Promise.reject(new GitHubError("GitHub comment: 410 Gone", 410)),
      };
      const done = file(sample(), e, gone, day2).catch((err: unknown) => err);
      // the clock moves in steps, so that each second's wait is reached before it is
      // moved past (the Worker awaits a digest and the comment before the first one)
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1200);
      expect(await done).toBeInstanceOf(GitHubError);
      expect(await seen(e, sample())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the record when a comment fails for any other reason", async () => {
    const e = env();
    await file(sample(), e, fakeGitHub(), day1);
    const flaky = { ...fakeGitHub(), comment: () => Promise.reject(new GitHubError("GitHub comment: 502", 502)) };
    await expect(file(sample(), e, flaky, day2)).rejects.toBeInstanceOf(GitHubError);
    expect((await seen(e, sample()))?.issue).toBe(7);
  });

  it("reports GitHub's refusal, not a KV failure, when giving the slot back goes wrong", async () => {
    const e = env({ DAILY_NEW_CAP: "5" });
    const store = e.REPORTS as ReturnType<typeof memoryStore>;
    const realGet = store.get.bind(store);
    let failing = false;
    store.get = (k) => (failing && k.startsWith("new:") ? Promise.reject(new Error("KV unavailable")) : realGet(k));
    const refused = {
      ...fakeGitHub(),
      create: () => {
        failing = true; // from the moment GitHub is asked, reading the count back fails
        return Promise.reject(new GitHubError("GitHub create: 422", 422));
      },
    };
    await expect(file(sample(), e, refused, day1)).rejects.toThrow("GitHub create: 422");
  });

  it("never lets an unlabelled issue's record expire, so find() not seeing it can't file another", async () => {
    const e = env({ DAILY_NEW_CAP: "5" });
    const store = e.REPORTS as ReturnType<typeof memoryStore>;
    const gh = { ...fakeGitHub(), create: () => Promise.resolve({ number: 42, labelled: false }) };
    await expect(file(sample(), e, gh, day1)).rejects.toThrow(/Issues: Read and write/);
    const fp = `fp:${await fingerprint(sample())}`;
    expect(store.ttl.get(fp), "an unlabelled issue's record has no expiry").toBeUndefined();
    // a labelled one's does
    const labelled = fakeGitHub();
    await file(sample({ message: "another" }), e, labelled, day1);
    expect(store.ttl.get(`fp:${await fingerprint(sample({ message: "another" }))}`)).toBeGreaterThan(0);
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

describe("the caps", () => {
  it("fall back to their defaults when the setting is missing or isn't a number", () => {
    expect(capOf("50", 200)).toBe(50);
    expect(capOf("0", 200)).toBe(0);
    for (const bad of [undefined, "", "  ", "many", "-3", "NaN", "Infinity"]) expect(capOf(bad, 200)).toBe(200);
  });

  it("still limit a day when the setting is broken, instead of limiting nothing", async () => {
    const e = env({ DAILY_CAP: "lots", DAILY_NEW_CAP: "few" });
    const gh = fakeGitHub();
    for (let i = 0; i < 40; i++) await file(sample({ message: `error ${"x".repeat(i)}` }), e, gh, new Date("2026-09-29T12:00:00Z"));
    // the default of twenty new issues a day
    expect(gh.calls.filter((c) => c.startsWith("create"))).toHaveLength(20);
  });
});

describe("reading a body", () => {
  const chunked = (parts: string[]): Request =>
    new Request("https://r.example/report", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          for (const p of parts) c.enqueue(new TextEncoder().encode(p));
          c.close();
        },
      }),
      // @ts-expect-error: Node's fetch wants this for a streamed body
      duplex: "half",
    });

  it("returns the text, whole, when it fits", async () => {
    expect(await readLimited(chunked(["{\"a\":", "1}"]), 100)).toBe('{"a":1}');
    expect(await readLimited(new Request("https://r.example/", { method: "POST" }), 100)).toBe("");
  });

  it("gives up at the limit, without a Content-Length to tell it so", async () => {
    expect(await readLimited(chunked(["x".repeat(60), "x".repeat(60)]), 100)).toBeNull();
  });

  it("refuses an oversized streamed body at the endpoint", async () => {
    const big = new Request("https://r.example/report", {
      method: "POST",
      headers: { origin: SITE },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(20_000)));
          c.close();
        },
      }),
      // @ts-expect-error: Node's fetch wants this for a streamed body
      duplex: "half",
    });
    expect((await handle(big, env(), ctx(), { gh: fakeGitHub() })).status).toBe(413);
  });
});
