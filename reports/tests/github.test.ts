// The GitHub calls, against a fake fetch that records them.
import { describe, expect, it } from "vitest";

import { github, LABEL } from "../src/github.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

function fakeFetch(answers: Response[]): { calls: Call[]; fetchFn: (u: string, i: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetchFn: (url, init) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        auth: new Headers(init.headers).get("authorization"),
      });
      const next = answers.shift();
      return Promise.resolve(next ?? new Response("{}", { status: 500 }));
    },
  };
}

const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status });
const REPO = "pelednoam/safe-bikes-lanes";

describe("the issues", () => {
  it("finds one by its marker, in this repository only", async () => {
    const f = fakeFetch([json({ items: [{ number: 12 }] })]);
    expect(await github(REPO, "tok", f.fetchFn).find("fp-abc")).toBe(12);
    const q = decodeURIComponent(new URL(f.calls[0]?.url ?? "").searchParams.get("q") ?? "");
    expect(q).toBe(`repo:${REPO} is:issue in:body "fp-abc"`);
    expect(f.calls[0]?.auth).toBe("Bearer tok");
  });

  it("finds none", async () => {
    const f = fakeFetch([json({ items: [] })]);
    expect(await github(REPO, "tok", f.fetchFn).find("fp-abc")).toBeNull();
  });

  it("opens one under its label, and without it if the label can't be made", async () => {
    const f = fakeFetch([json({ number: 3 }, 201)]);
    expect(await github(REPO, "tok", f.fetchFn).create("t", "b")).toBe(3);
    expect(f.calls[0]).toMatchObject({ method: "POST", body: { title: "t", body: "b", labels: [LABEL] } });

    const g = fakeFetch([json({ message: "Validation Failed" }, 422), json({ number: 4 }, 201)]);
    expect(await github(REPO, "tok", g.fetchFn).create("t", "b")).toBe(4);
    expect(g.calls[1]?.body).toEqual({ title: "t", body: "b" });
  });

  it("reopens only a closed one", async () => {
    const closed = fakeFetch([json({ state: "closed" }), json({ state: "open" })]);
    await github(REPO, "tok", closed.fetchFn).reopen(9);
    expect(closed.calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(closed.calls[1]?.body).toEqual({ state: "open" });

    const open = fakeFetch([json({ state: "open" })]);
    await github(REPO, "tok", open.fetchFn).reopen(9);
    expect(open.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("says what failed, and how", async () => {
    const f = fakeFetch([new Response("Bad credentials", { status: 401 })]);
    await expect(github(REPO, "tok", f.fetchFn).comment(1, "x")).rejects.toThrow("GitHub comment: 401 Bad credentials");
  });
});
