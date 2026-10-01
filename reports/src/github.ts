// The issues the reports are filed as, through GitHub's REST API.

export interface GitHub {
  /** The open or closed issue carrying this marker, if there is one. */
  find(marker: string): Promise<number | null>;
  /** File an issue. `labelled` is whether it carries the label find() looks for:
   * GitHub drops a label a token has no right to apply from a 201, so the issue
   * exists either way, and the caller has to know that it does. */
  create(title: string, body: string): Promise<Created>;
  comment(issue: number, body: string): Promise<void>;
}

export interface Created {
  number: number;
  labelled: boolean;
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
      // The label has to exist (the deploy creates it): GitHub refuses a label it
      // can't create with a 422, and that is an error, with no issue filed. But a
      // token without triage access has the label silently dropped from a 201,
      // and that issue is public already: it is reported as filed, unlabelled, so
      // that the caller records it rather than filing it again on the next report.
      const resp = await ok(
        await api(`/repos/${repo}/issues`, {
          method: "POST",
          body: JSON.stringify({ title, body, labels: [LABEL] }),
        }),
        "create",
      );
      const made = (await resp.json()) as { number: number; labels?: { name?: string }[] };
      return { number: made.number, labelled: made.labels?.some((l) => l.name === LABEL) === true };
    },
    async comment(issue, body) {
      await ok(
        await api(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
        "comment",
      );
    },
  };
}
