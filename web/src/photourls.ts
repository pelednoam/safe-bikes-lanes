// Object URLs for photos read from the device, one per photo and let go when its
// report is. A hazard's photo lives in IndexedDB as a Blob; showing it needs an
// object URL, which the browser holds memory for until it is revoked. They were
// made on every mouse move, then once and kept for the page's life, and a read
// that failed was remembered as "no photo" for good, with its rejection
// unhandled.

export class PhotoUrls {
  private readonly urls = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly retryAt = new Map<string, number>();

  constructor(
    private readonly load: (id: string) => Promise<Blob | null>,
    private readonly opts: {
      now?: () => number;
      /** How long after a failed or empty read before it is tried again. */
      retryMs?: number;
      make?: (blob: Blob) => string;
      free?: (url: string) => void;
    } = {},
  ) {}

  /** The photo's URL, if it has been read. */
  get(id: string): string | null {
    return this.urls.get(id) ?? null;
  }

  /** Read the photo if it hasn't been and isn't being: true if a URL arrived,
   * so the card showing it should be drawn again. A read that fails, or finds
   * nothing, is tried again later (not on the next mouse move: a hover is
   * dozens of events), rather than being remembered as "no photo". */
  async ensure(id: string): Promise<boolean> {
    const now = (this.opts.now ?? Date.now)();
    if (this.urls.has(id) || this.pending.has(id)) return false;
    if (now < (this.retryAt.get(id) ?? 0)) return false;
    this.pending.add(id);
    try {
      const blob = await this.load(id);
      if (blob === null) {
        this.retryAt.set(id, now + (this.opts.retryMs ?? 5000));
        return false;
      }
      this.urls.set(id, (this.opts.make ?? ((b: Blob) => URL.createObjectURL(b)))(blob));
      this.retryAt.delete(id);
      return true;
    } catch {
      this.retryAt.set(id, now + (this.opts.retryMs ?? 5000));
      return false;
    } finally {
      this.pending.delete(id);
    }
  }

  /** Let go of every photo whose report is gone (deleted, or the list reloaded). */
  prune(keep: ReadonlySet<string>): void {
    const free = this.opts.free ?? ((u: string) => URL.revokeObjectURL(u));
    for (const [id, url] of this.urls) {
      if (keep.has(id)) continue;
      free(url);
      this.urls.delete(id);
    }
    for (const id of this.retryAt.keys()) if (!keep.has(id)) this.retryAt.delete(id);
  }
}
