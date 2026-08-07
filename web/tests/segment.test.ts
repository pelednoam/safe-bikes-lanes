// The street card and its photo lookup, shared by the route planner and the
// per-city pages. It states what a street is like for a child, so the two pages
// must not be able to describe the same street differently — that's why it's
// one module, and why its wording is pinned here.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classGrade,
  fetchSegmentPhoto,
  fillSegmentPhoto,
  nearestMapillary,
  segmentHtml,
} from "../src/segment.js";

describe("the street card", () => {
  it("grades a street on the same scale as a whole route", () => {
    expect(classGrade("path")).toBe("A");
    expect(classGrade("separated")).toBe("A");
    expect(classGrade("buffered")).toBe("B");
    expect(classGrade("lane")).toBe("C");
    expect(classGrade("sharrow")).toBe("D");
    expect(classGrade("busy_street")).toBe("F");
  });

  it("says what the street is, and what that means for a child", () => {
    const html = segmentHtml({ cls: "lane", name: "Cedar Street" });
    expect(html).toContain("Cedar Street");
    expect(html).toContain("painted lane");
    // the plain-words meaning is the point: "painted lane" alone tells a parent
    // nothing about whether to take a seven-year-old down it
    expect(html).toContain("paint only, directly beside moving traffic");
    expect(html).toContain("kid-stress ×3");
    expect(html).toContain(">C<"); // the grade badge
  });

  it("names crashes only when there are some, and counts them correctly", () => {
    expect(segmentHtml({ cls: "busy_street", crashes: 0 })).not.toContain("crash");
    expect(segmentHtml({ cls: "busy_street", crashes: null })).not.toContain("crash");
    expect(segmentHtml({ cls: "busy_street", crashes: 1 })).toContain("1 bike crash recorded");
    expect(segmentHtml({ cls: "busy_street", crashes: 4 })).toContain("4 bike crashes recorded");
  });

  it("flags a facility only OpenStreetMap knows about", () => {
    // a lane the city's own layer doesn't list is a weaker claim, and the card
    // should say so rather than presenting it as confirmed
    expect(segmentHtml({ cls: "separated", source: "osm" })).toContain("OSM only");
    expect(segmentHtml({ cls: "separated", source: "cambridge" })).not.toContain("OSM only");
    // an unprotected road isn't a facility, so the caveat doesn't apply
    expect(segmentHtml({ cls: "busy_street", source: "osm" })).not.toContain("OSM only");
  });

  it("copes with a street it knows nothing about", () => {
    const html = segmentHtml({});
    expect(html).toContain("unnamed");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("only leaves a photo slot when there's a token to fill it", () => {
    expect(segmentHtml({ cls: "lane" }, { photo: true })).toContain("data-seg-photo");
    expect(segmentHtml({ cls: "lane" }, { photo: false })).not.toContain("data-seg-photo");
  });
});

describe("finding a street-level photo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // dxM metres east of `lon`. Each test uses its own point: the lookup caches
  // per ~55 m cell, so two nearby points would answer from the first's cache.
  const at = (lon: number, dxM: number, id: string, captured = 1_600_000_000_000): unknown => ({
    thumb_256_url: `https://img/${id}`,
    captured_at: captured,
    computed_geometry: { coordinates: [lon + dxM / 82_000, 42.38] },
  });

  function stub(images: unknown[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: images }), { status: 200 })),
    );
  }

  it("shows the nearest photo, not the newest", async () => {
    // the old lookup took the newest inside a small box, which could prefer a
    // picture further away than one right beside you
    stub([at(-71.1, 50, "far", 1_700_000_000_000), at(-71.1, 8, "near", 1_500_000_000_000)]);
    const got = await fetchSegmentPhoto(-71.1, 42.38, "token");
    expect(got.url).toBe("https://img/near");
  });

  it("refuses a photo too far away to be this street", async () => {
    // better no picture than a picture of somewhere else
    stub([at(-71.12, 140, "next-street-over")]);
    expect((await fetchSegmentPhoto(-71.12, 42.38, "token")).url).toBeNull();
  });

  it("has no photo without a token, and doesn't call out", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await fetchSegmentPhoto(-71.2, 42.4, "")).url).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("survives a failing or malformed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect((await fetchSegmentPhoto(-71.3, 42.41, "token")).url).toBeNull();

    // a 200 whose body is missing the array it promised
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect((await fetchSegmentPhoto(-71.31, 42.42, "token")).url).toBeNull();

    // and a refusal from the API
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
    expect((await fetchSegmentPhoto(-71.32, 42.43, "token")).url).toBeNull();
  });

  it("asks once per patch of street", async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ data: [at(-71.5, 5, "x")] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", f);
    await fetchSegmentPhoto(-71.5, 42.5, "token");
    await fetchSegmentPhoto(-71.5, 42.5, "token");
    // hovering a street fires this per pixel; it must not be a request per pixel
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("putting the photo into a card that's already on screen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The bit of a card the photo lands in. No jsdom here, so it's by hand — the
   * function only needs a slot to find and something to write into. */
  function fakeCard(opts: { connected?: boolean; hasSlot?: boolean } = {}): {
    owner: HTMLElement;
    slot: { innerHTML: string; isConnected: boolean };
  } {
    const slot = { innerHTML: "", isConnected: opts.connected ?? true };
    const owner = {
      querySelector: (): unknown => (opts.hasSlot === false ? null : slot),
    } as unknown as HTMLElement;
    return { owner, slot };
  }

  function stubPhoto(images: unknown[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: images }), { status: 200 })),
    );
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("shows the picture, with when it was taken", async () => {
    stubPhoto([
      {
        thumb_256_url: "https://img/here",
        captured_at: Date.UTC(2023, 4, 17),
        computed_geometry: { coordinates: [-71.2, 42.38] },
      },
    ]);
    const { owner, slot } = fakeCard();
    fillSegmentPhoto(owner, -71.2, 42.38, "token", () => true);
    await settle();
    expect(slot.innerHTML).toContain("https://img/here");
    expect(slot.innerHTML).toContain("2023"); // a 2015 photo is weaker evidence
  });

  it("says plainly when there's no photo, rather than leaving a hole", async () => {
    stubPhoto([]);
    const { owner, slot } = fakeCard();
    fillSegmentPhoto(owner, -71.21, 42.38, "token", () => true);
    await settle();
    expect(slot.innerHTML).toContain("no street-level photo here");
  });

  it("drops the photo if the pointer has moved on", async () => {
    stubPhoto([
      { thumb_256_url: "https://img/stale", computed_geometry: { coordinates: [-71.22, 42.38] } },
    ]);
    const { owner, slot } = fakeCard();
    // hovering across a map fires these faster than they resolve; a late answer
    // must not paint a photo of the street you already left
    fillSegmentPhoto(owner, -71.22, 42.38, "token", () => false);
    await settle();
    expect(slot.innerHTML).toBe("");
  });

  it("does nothing when there's no card, no slot, or no token", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    fillSegmentPhoto(null, -71.23, 42.38, "token", () => true);
    fillSegmentPhoto(fakeCard().owner, -71.24, 42.38, "", () => true);
    await settle();
    expect(f).not.toHaveBeenCalled();

    stubPhoto([
      { thumb_256_url: "https://img/x", computed_geometry: { coordinates: [-71.25, 42.38] } },
    ]);
    const gone = fakeCard({ connected: false });
    fillSegmentPhoto(gone.owner, -71.25, 42.38, "token", () => true);
    const slotless = fakeCard({ hasSlot: false });
    fillSegmentPhoto(slotless.owner, -71.26, 42.38, "token", () => true);
    await settle();
    expect(gone.slot.innerHTML).toBe(""); // the card was closed mid-flight
  });
});

describe("a street whose class we don't recognise", () => {
  // a page can be a build behind the data it fetches, so this is reachable
  it("says so, instead of grading it the worst", () => {
    for (const cls of ["", "trolley_portal", undefined]) {
      const html = segmentHtml({ cls: cls as never, name: "Mystery Ave" });
      expect(html).toContain("Mystery Ave");
      expect(html).toContain("type unknown");
      expect(html).not.toContain(">F<"); // an F is a claim; we don't have one
      expect(html).not.toContain("kid-stress");
      expect(html).not.toContain("undefined");
    }
    expect(classGrade("" as never)).toBeNull();
  });

  it("still reports what it does know about it", () => {
    const html = segmentHtml({ cls: "" as never, crashes: 3, source: "osm" });
    expect(html).toContain("3 bike crashes recorded");
    // but not a facility caveat about a facility we can't name
    expect(html).not.toContain("OSM only");
  });
});

describe("a street name that came from OpenStreetMap", () => {
  // anyone can edit OSM, and both pages render this card through MapLibre's
  // setHTML — i.e. innerHTML, on the origin holding the rider's saved routes
  it("cannot smuggle markup into the card", () => {
    const html = segmentHtml({
      cls: "lane",
      name: '<img src=x onerror="alert(1)">',
    });
    // the payload survives as visible text, which is fine; what must not
    // survive is a tag boundary or an attribute quote to hang a handler on
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;");
  });

  it("still reads correctly when the name merely contains punctuation", () => {
    expect(segmentHtml({ cls: "lane", name: "Mass. Ave & Beacon" })).toContain(
      "Mass. Ave &amp; Beacon",
    );
  });

  it("escapes an unrecognised class label too", () => {
    // the label falls back to the raw class string, which is also data
    const html = segmentHtml({ cls: "<b>x</b>" as never, name: "A St" });
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("the shared nearest-photo lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets a caller ask for a bigger image and still applies the distance cap", async () => {
    // the settings preview wants thumb_1024_url; it used to keep its own copy of
    // this search and kept the narrow-box, newest-wins version after the card
    // was fixed
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            data: [
              {
                thumb_1024_url: "https://img/big-far",
                computed_geometry: { coordinates: [-71.4 + 150 / 82_000, 42.38] },
              },
              {
                thumb_1024_url: "https://img/big-near",
                computed_geometry: { coordinates: [-71.4 + 10 / 82_000, 42.38] },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const got = await nearestMapillary(
      -71.4,
      42.38,
      "token",
      "id,thumb_1024_url,captured_at,computed_geometry",
    );
    expect(got?.thumb_1024_url).toBe("https://img/big-near");
    const [firstCall] = fetchMock.mock.calls;
    expect(String(firstCall?.[0] ?? "")).toContain("thumb_1024_url");
  });

  it("has nothing to say without a token, and never calls out", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await nearestMapillary(-71.4, 42.38, "")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("lets a refusal reach the caller rather than reporting no photo", async () => {
    // fetchSegmentPhoto turns this into "no photo"; the preview opens Mapillary
    // in a tab instead, and it can only tell the difference if this throws
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
    await expect(nearestMapillary(-71.4, 42.38, "token")).rejects.toThrow(/429/);
  });
});
