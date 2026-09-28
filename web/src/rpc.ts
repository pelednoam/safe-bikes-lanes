// ---------------------------------------------------------------------------
// Calling an object that lives in a Web Worker as if it were here, but async.
//
// expose(api, endpoint) in the worker answers calls; wrap<Api>(endpoint) on the
// page returns an object whose every method returns a promise of the same
// result. Arguments and results cross by structured clone (so Maps, Sets and
// typed arrays are fine; class instances arrive as plain objects). A function
// passed as an argument is called back on the page: that is how tile loading
// reports progress.
//
// The worker handles one message at a time, and a synchronous method (every
// Router search) runs to completion before the next message is read. That is
// what keeps a what-if atomic (see withUpgraded): nothing else can route while
// a proposed lane is applied. An async method (tile loading) can interleave
// with others at its awaits, so none of them may leave shared state half-set.
// ---------------------------------------------------------------------------

/** Both a Worker and a worker's own global scope. */
export interface Endpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

/** A Worker, which can also fail: its script doesn't load, it runs out of
 * memory, or a message can't be read. */
export interface FallibleEndpoint extends Endpoint {
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (e: Event) => void): void;
}

/** What every call is rejected with once the worker has failed. */
export const WORKER_FAILED = "the route finder stopped working — reload the app to start it again";

/** `T`, with every method returning a promise. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

type Wire = { fn: number } | { value: unknown };

interface Call {
  kind: "call";
  id: number;
  method: string;
  args: Wire[];
}
interface Reply {
  kind: "reply";
  id: number;
  ok: boolean;
  value: unknown;
}
interface Callback {
  kind: "callback";
  id: number;
  fn: number;
  args: unknown[];
}
type Message = Call | Reply | Callback;

export function expose(api: object, ep: Endpoint): void {
  const methods = api as Record<string, (...args: unknown[]) => unknown>;
  ep.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as Message;
    if (msg.kind !== "call") return;
    const args = msg.args.map((a) =>
      "fn" in a
        ? (...cbArgs: unknown[]): void => {
            ep.postMessage({ kind: "callback", id: msg.id, fn: a.fn, args: cbArgs } satisfies Callback);
          }
        : a.value,
    );
    const reply = (ok: boolean, value: unknown): void => {
      ep.postMessage({ kind: "reply", id: msg.id, ok, value } satisfies Reply);
    };
    try {
      const method = methods[msg.method];
      if (typeof method !== "function") throw new Error(`no such method: ${msg.method}`);
      Promise.resolve(method.apply(api, args)).then(
        (value) => reply(true, value),
        (err: unknown) => reply(false, errorText(err)),
      );
    } catch (err) {
      reply(false, errorText(err));
    }
  });
}

/** An Error's message, which is what the page shows; an Error itself does
 * not survive the trip whole in every browser. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function wrap<T extends object>(ep: Endpoint | FallibleEndpoint): Remote<T> {
  let nextId = 0;
  /** Set once the worker has failed: it answers nothing from then on. */
  let failed: string | null = null;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; fns: ((...a: unknown[]) => void)[] }
  >();
  ep.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as Message;
    const call = pending.get(msg.id);
    if (call === undefined) return;
    if (msg.kind === "callback") {
      call.fns[msg.fn]?.(...msg.args);
    } else if (msg.kind === "reply") {
      pending.delete(msg.id);
      if (msg.ok) call.resolve(msg.value);
      else call.reject(new Error(String(msg.value)));
    }
  });
  // A worker that fails answers nothing, ever: without this, every call made
  // to it waited forever — a plan stuck on "Finding the safest way…" and, mid-
  // ride, a reroute that never came. Everything waiting is told now, and
  // everything asked later is told at once.
  const fail = (): void => {
    failed = WORKER_FAILED;
    for (const call of pending.values()) call.reject(new Error(WORKER_FAILED));
    pending.clear();
  };
  // (a MessagePort, as in the tests, never fires these; a Worker does)
  (ep as FallibleEndpoint).addEventListener("error", fail);
  (ep as FallibleEndpoint).addEventListener("messageerror", fail);
  return new Proxy({} as Remote<T>, {
    get(_target, method) {
      if (typeof method !== "string") return undefined;
      // not a thenable: `await remote` must not look like a pending call
      if (method === "then") return undefined;
      return (...args: unknown[]): Promise<unknown> =>
        new Promise((resolve, reject) => {
          if (failed !== null) {
            reject(new Error(failed));
            return;
          }
          const id = nextId++;
          const fns: ((...a: unknown[]) => void)[] = [];
          const wire = args.map((a): Wire => {
            if (typeof a !== "function") return { value: a };
            fns.push(a as (...a: unknown[]) => void);
            return { fn: fns.length - 1 };
          });
          pending.set(id, { resolve, reject, fns });
          ep.postMessage({ kind: "call", id, method, args: wire } satisfies Call);
        });
    },
  });
}
