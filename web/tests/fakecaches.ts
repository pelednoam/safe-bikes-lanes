// An in-memory CacheStorage for tests that run under Node, where there is none.
//
// Only the behaviour the app and its worker rely on: entries keyed by absolute
// URL, `keys()` in insertion order (a re-put moves an entry to the end, as the
// spec's "append after removing the match" does), bodies stored as bytes so a
// cached response can be read more than once.

const ORIGIN = "https://app.test/";

function urlOf(req: RequestInfo | URL): string {
  if (typeof req === "string") return new URL(req, ORIGIN).toString();
  if (req instanceof URL) return req.toString();
  return new URL(req.url, ORIGIN).toString();
}

interface Stored {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
  type: ResponseType;
}

export class FakeCache {
  readonly entries = new Map<string, Stored>();

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const hit = this.entries.get(urlOf(req));
    if (hit === undefined) return undefined;
    // A 0 status cannot be constructed; keep the rest of an opaque entry visible.
    return new Response(hit.body.slice(0), {
      status: hit.status === 0 ? 200 : hit.status,
      statusText: hit.statusText,
      headers: hit.headers,
    });
  }

  async put(req: RequestInfo | URL, resp: Response): Promise<void> {
    const body = await resp.arrayBuffer();
    const key = urlOf(req);
    this.entries.delete(key);
    this.entries.set(key, {
      body,
      status: resp.status,
      statusText: resp.statusText,
      headers: [...resp.headers.entries()],
      type: resp.type,
    });
  }

  async add(req: RequestInfo | URL): Promise<void> {
    const resp = await fetch(urlOf(req));
    await this.put(req, resp);
  }

  async addAll(reqs: (RequestInfo | URL)[]): Promise<void> {
    for (const r of reqs) await this.add(r);
  }

  async delete(req: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(urlOf(req));
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((u) => new Request(u));
  }

  urls(): string[] {
    return [...this.entries.keys()];
  }
}

export class FakeCacheStorage {
  readonly store = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.store.get(name);
    if (cache === undefined) {
      cache = new FakeCache();
      this.store.set(name, cache);
    }
    return cache;
  }

  async has(name: string): Promise<boolean> {
    return this.store.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.store.delete(name);
  }

  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    for (const cache of this.store.values()) {
      const hit = await cache.match(req);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** The same object, typed as the DOM's CacheStorage for code under test. */
  get asCacheStorage(): CacheStorage {
    return this as unknown as CacheStorage;
  }
}
