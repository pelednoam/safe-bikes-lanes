// The issues the reports are filed as, through GitHub's REST API.

export interface GitHub {
  /** The open or closed issue carrying this marker, if there is one. */
  find(marker: string): Promise<number | null>;
  create(title: string, body: string): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
  /** Reopened if it was closed: a fix that didn't hold is news. */
  reopen(issue: number): Promise<void>;
}

/** The label the issues are filed under. */
export const LABEL = "error report";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function github(repo: string, token: string, fetchFn: Fetch = fetch): GitHub {
  const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const resp = await fetchFn(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "safe-bikes-reports",
        "x-github-api-version": "2022-11-28",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    return resp;
  };
  const ok = async (resp: Response, what: string): Promise<Response> => {
    if (!resp.ok) throw new Error(`GitHub ${what}: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    return resp;
  };

  return {
    async find(marker) {
      const q = encodeURIComponent(`repo:${repo} is:issue in:body "${marker}"`);
      const resp = await ok(await api(`/search/issues?q=${q}&per_page=1`), "search");
      const found = (await resp.json()) as { items?: { number: number }[] };
      return found.items?.[0]?.number ?? null;
    },
    async create(title, body) {
      let resp = await api(`/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title, body, labels: [LABEL] }),
      });
      // a label the token can't create: file it without, rather than not at all
      if (resp.status === 422) {
        resp = await api(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
      }
      const made = (await (await ok(resp, "create")).json()) as { number: number };
      return made.number;
    },
    async comment(issue, body) {
      await ok(
        await api(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
        "comment",
      );
    },
    async reopen(issue) {
      const resp = await ok(await api(`/repos/${repo}/issues/${issue}`), "read");
      const state = ((await resp.json()) as { state?: string }).state;
      if (state === "closed") {
        await ok(
          await api(`/repos/${repo}/issues/${issue}`, { method: "PATCH", body: JSON.stringify({ state: "open" }) }),
          "reopen",
        );
      }
    },
  };
}
