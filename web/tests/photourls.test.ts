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

  it("isn't read twice at once, by a card hovered again before the first answered", async () => {
    let finish: (b: Blob) => void = () => undefined;
    const s = setup(() => new Promise<Blob>((r) => (finish = r)));
    const first = s.photos.ensure("a");
    expect(await s.photos.ensure("a")).toBe(false);
    finish(blob);
    expect(await first).toBe(true);
    expect(s.reads).toEqual(["a"]);
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
