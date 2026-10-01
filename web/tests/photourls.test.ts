// The photos on hazard cards: read once, tried again after a failure, and
// released with their report.
import { describe, expect, it } from "vitest";

import { PhotoUrls } from "../src/photourls.js";

function setup(loads: (id: string, n: number) => Promise<Blob | null>) {
  let t = 1000;
  const reads: string[] = [];
  const made: string[] = [];
  const freed: string[] = [];
  const photos = new PhotoUrls(
    (id) => {
      reads.push(id);
      return loads(id, reads.filter((r) => r === id).length);
    },
    {
      now: () => t,
      retryMs: 5000,
      make: () => {
        const url = `blob:${made.length}`;
        made.push(url);
        return url;
      },
      free: (u) => freed.push(u),
    },
  );
  return { photos, reads, made, freed, advance: (ms: number) => (t += ms) };
}

const blob = new Blob(["jpeg"]);

describe("a hazard's photo", () => {
  it("is read once, however often the card is shown", async () => {
    const s = setup(async () => blob);
    expect(await s.photos.ensure("a")).toBe(true);
    expect(await s.photos.ensure("a")).toBe(false);
    expect(await s.photos.ensure("a")).toBe(false);
    expect(s.reads).toEqual(["a"]);
    expect(s.photos.get("a")).toBe("blob:0");
    expect(s.made).toHaveLength(1);
  });

  it("isn't read twice at once, and every card waiting on it hears when it arrives", async () => {
    // the popup is made afresh as the pointer moves: the card that started the
    // read is gone when it finishes, and the card there then must be told
    let finish: (b: Blob) => void = () => undefined;
    const s = setup(() => new Promise<Blob>((r) => (finish = r)));
    const first = s.photos.ensure("a");
    const second = s.photos.ensure("a");
    finish(blob);
    expect([await first, await second]).toEqual([true, true]);
    expect(s.reads).toEqual(["a"]);
  });

  it("leaves no URL behind for a report that went while its photo was being read", async () => {
    let finish: (b: Blob) => void = () => undefined;
    const s = setup((_id, n) => (n === 1 ? new Promise<Blob>((r) => (finish = r)) : Promise.resolve(blob)));
    const read = s.photos.ensure("a");
    s.photos.prune(new Set()); // the report is deleted mid-read
    finish(blob);
    expect(await read).toBe(false);
    expect(s.made).toEqual([]);
    expect(s.photos.get("a")).toBeNull();
    // and a report that comes back is read afresh
    expect(await s.photos.ensure("a")).toBe(true);
  });

  it("starts a fresh read when a report comes back while the cut-off one is still under way", async () => {
    // the first read is overtaken (its report went), and the report returns before it
    // settles: the card asking now must not be handed that read, which will say "nothing"
    const resolvers: ((b: Blob) => void)[] = [];
    const s = setup(() => new Promise<Blob>((r) => resolvers.push(r)));
    const stale = s.photos.ensure("a");
    s.photos.prune(new Set());
    const fresh = s.photos.ensure("a");
    expect(s.reads).toEqual(["a", "a"]);
    resolvers[1]?.(blob);
    expect(await fresh).toBe(true);
    resolvers[0]?.(blob);
    expect(await stale).toBe(false);
    expect(s.made).toHaveLength(1);
    expect(s.photos.get("a")).toBe("blob:0");
  });

  it("is tried again when making the URL fails, and says nothing out loud", async () => {
    let t = 1000;
    let failMake = true;
    const photos = new PhotoUrls(async () => blob, {
      now: () => t,
      make: () => {
        if (failMake) throw new Error("out of memory");
        return "blob:ok";
      },
      free: () => undefined,
    });
    expect(await photos.ensure("a")).toBe(false);
    failMake = false;
    t += 6000;
    expect(await photos.ensure("a")).toBe(true);
    expect(photos.get("a")).toBe("blob:ok");
  });

  it("counts the wait before trying again from when the read failed, not from when it began", async () => {
    let fail: () => void = () => undefined;
    const s = setup((_id, n) => (n === 1 ? new Promise<Blob>((_, no) => (fail = () => no(new Error("busy")))) : Promise.resolve(blob)));
    const first = s.photos.ensure("a");
    s.advance(4000); // a slow read
    fail();
    expect(await first).toBe(false);
    s.advance(4000); // 4 s since it failed: too soon, though 8 since it began
    expect(await s.photos.ensure("a")).toBe(false);
    s.advance(1500);
    expect(await s.photos.ensure("a")).toBe(true);
  });

  it("is tried again after a failed read, though not on the very next mouse move", async () => {
    // it was remembered as 'no photo' for the rest of the session, and the
    // rejection went unhandled
    const s = setup(async (_id, n) => {
      if (n === 1) throw new Error("IndexedDB is busy");
      return blob;
    });
    expect(await s.photos.ensure("a")).toBe(false);
    expect(await s.photos.ensure("a")).toBe(false); // too soon: no second read
    expect(s.reads).toHaveLength(1);
    s.advance(5001);
    expect(await s.photos.ensure("a")).toBe(true);
    expect(s.photos.get("a")).toBe("blob:0");
  });

  it("is tried again when the read found nothing, which may be a photo not yet written", async () => {
    const s = setup(async (_id, n) => (n === 1 ? null : blob));
    expect(await s.photos.ensure("a")).toBe(false);
    s.advance(6000);
    expect(await s.photos.ensure("a")).toBe(true);
  });

  it("is let go of with its report, and only then", async () => {
    const s = setup(async () => blob);
    await s.photos.ensure("a");
    await s.photos.ensure("b");
    s.photos.prune(new Set(["b"]));
    expect(s.freed).toEqual(["blob:0"]);
    expect(s.photos.get("a")).toBeNull();
    expect(s.photos.get("b")).toBe("blob:1");
    // and read again if its report comes back
    expect(await s.photos.ensure("a")).toBe(true);
    expect(s.reads).toEqual(["a", "b", "a"]);
  });
});
