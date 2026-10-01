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
  it("finds one by its marker, among this repository's labelled issues only", async () => {
    const f = fakeFetch([json({ items: [{ number: 12 }] })]);
    expect(await github(REPO, "tok", f.fetchFn).find("fp-abc")).toBe(12);
    const q = decodeURIComponent(new URL(f.calls[0]?.url ?? "").searchParams.get("q") ?? "");
    expect(q).toBe(`repo:${REPO} is:issue label:"${LABEL}" in:body "fp-abc"`);
    expect(f.calls[0]?.auth).toBe("Bearer tok");
  });

  it("finds none", async () => {
    const f = fakeFetch([json({ items: [] })]);
    expect(await github(REPO, "tok", f.fetchFn).find("fp-abc")).toBeNull();
  });

  it("opens one under its label", async () => {
    const f = fakeFetch([json({ number: 3 }, 201)]);
    expect(await github(REPO, "tok", f.fetchFn).create("t", "b")).toBe(3);
    expect(f.calls[0]).toMatchObject({ method: "POST", body: { title: "t", body: "b", labels: [LABEL] } });
  });

  it("doesn't fall back to an issue without the label, which find() could never see again", async () => {
    const f = fakeFetch([json({ message: "Validation Failed" }, 422)]);
    await expect(github(REPO, "tok", f.fetchFn).create("t", "b")).rejects.toThrow("GitHub create: 422");
    expect(f.calls).toHaveLength(1);
  });

  it("says what failed, and how", async () => {
    const f = fakeFetch([new Response("Bad credentials", { status: 401 })]);
    await expect(github(REPO, "tok", f.fetchFn).comment(1, "x")).rejects.toThrow("GitHub comment: 401 Bad credentials");
  });
});
