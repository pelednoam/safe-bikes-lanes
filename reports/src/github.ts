// The issues the reports are filed as, through GitHub's REST API.

export interface GitHub {
  /** The open or closed issue carrying this marker, if there is one. */
  find(marker: string): Promise<number | null>;
  create(title: string, body: string): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
}

/** The label the issues are filed under. Searching only issues that carry it
 * means a fingerprint typed into someone else's issue (they are public text)
 * can't stand in for ours: only people who can label issues can add it. */
export const LABEL = "error report";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function github(repo: string, token: string, fetchFn: Fetch = fetch): GitHub {
  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetchFn(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "safe-bikes-reports",
        "x-github-api-version": "2022-11-28",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
  const ok = async (resp: Response, what: string): Promise<Response> => {
    if (!resp.ok) throw new Error(`GitHub ${what}: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    return resp;
  };

  return {
    async find(marker) {
      const q = encodeURIComponent(`repo:${repo} is:issue label:"${LABEL}" in:body "${marker}"`);
      const resp = await ok(await api(`/search/issues?q=${q}&per_page=1`), "search");
      const found = (await resp.json()) as { items?: { number: number }[] };
      return found.items?.[0]?.number ?? null;
    },
    async create(title, body) {
      // The label must exist (reports/README.md): an issue filed without it
      // could never be found again by find(), so it is a failure, not a fallback.
      const resp = await ok(
        await api(`/repos/${repo}/issues`, {
          method: "POST",
          body: JSON.stringify({ title, body, labels: [LABEL] }),
        }),
        "create",
      );
      return ((await resp.json()) as { number: number }).number;
    },
    async comment(issue, body) {
      await ok(
        await api(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
        "comment",
      );
    },
  };
}
