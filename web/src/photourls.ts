// Object URLs for photos read from the device, one per photo and let go when its
// report is. A hazard's photo lives in IndexedDB as a Blob; showing it needs an
// object URL, which the browser holds memory for until it is revoked. They were
// made on every mouse move, then once and kept for the page's life, and a read
// that failed was remembered as "no photo" for good, with its rejection
// unhandled.

/** How long after a failed or empty read before it is tried again: not on the
 * next mouse move, a hover being dozens of events. */
export const RETRY_MS = 5000;

export class PhotoUrls {
  private readonly urls = new Map<string, string>();
  /** The read in flight for a photo, which every card asking for it waits on. */
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly retryAt = new Map<string, number>();
  /** Bumped for a photo whose report goes while it is being read, so the read,
   * finding it has been overtaken, leaves no URL behind. */
  private readonly epoch = new Map<string, number>();

  constructor(
    private readonly load: (id: string) => Promise<Blob | null>,
    private readonly opts: {
      now?: () => number;
      retryMs?: number;
      make?: (blob: Blob) => string;
      free?: (url: string) => void;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The photo's URL, if it has been read. */
  get(id: string): string | null {
    return this.urls.get(id) ?? null;
  }

  /** Read the photo if it hasn't been: resolves true if a URL arrived, so the
   * card showing it should be drawn again. A card shown while a read is already
   * under way waits on that read, rather than being told "nothing" and never
   * hearing it finish: the popup is made afresh as the pointer moves, and the one
   * that started the read is gone by the time it is done. A read that fails, or
   * finds nothing, is tried again later, not remembered as "no photo". */
  ensure(id: string): Promise<boolean> {
    if (this.urls.has(id)) return Promise.resolve(false);
    const inFlight = this.pending.get(id);
    if (inFlight !== undefined) return inFlight;
    if (this.now() < (this.retryAt.get(id) ?? 0)) return Promise.resolve(false);
    const read = this.read(id).finally(() => {
      if (this.pending.get(id) === read) this.pending.delete(id);
    });
    this.pending.set(id, read);
    return read;
  }

  private async read(id: string): Promise<boolean> {
    const started = this.epoch.get(id) ?? 0;
    const retryLater = (): void => {
      // from when it failed, not from when it began: a slow read would otherwise
      // have a retry window that was mostly over before it started
      this.retryAt.set(id, this.now() + (this.opts.retryMs ?? RETRY_MS));
    };
    let blob: Blob | null;
    try {
      blob = await this.load(id);
    } catch {
      blob = null;
    }
    if ((this.epoch.get(id) ?? 0) !== started) return false; // its report went meanwhile
    if (blob === null) {
      retryLater();
      return false;
    }
    this.urls.set(id, (this.opts.make ?? ((b: Blob) => URL.createObjectURL(b)))(blob));
    this.retryAt.delete(id);
    return true;
  }

  /** Let go of every photo whose report is gone (deleted, or the list reloaded),
   * and of any read still under way for one. */
  prune(keep: ReadonlySet<string>): void {
    const free = this.opts.free ?? ((u: string) => URL.revokeObjectURL(u));
    for (const [id, url] of this.urls) {
      if (keep.has(id)) continue;
      free(url);
      this.urls.delete(id);
    }
    for (const id of this.pending.keys()) {
      if (!keep.has(id)) this.epoch.set(id, (this.epoch.get(id) ?? 0) + 1);
    }
    for (const id of this.retryAt.keys()) if (!keep.has(id)) this.retryAt.delete(id);
  }
}
