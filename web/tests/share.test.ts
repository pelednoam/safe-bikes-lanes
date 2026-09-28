// Downloads and the share sheet, the way WebKit runs them.
import { describe, expect, it } from "vitest";

import {
  downloadBlob,
  type DownloadEnv,
  PreparedImage,
  REVOKE_AFTER_MS,
  saveBlob,
  shareImage,
  type ShareEnv,
} from "../src/share.js";

describe("downloadBlob", () => {
  it("keeps the file's URL alive after the click, for WebKit to read", () => {
    const log: string[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const env: DownloadEnv = {
      createObjectURL: () => "blob:1",
      revokeObjectURL: (u) => log.push(`revoke ${u}`),
      click: (u, f) => log.push(`click ${u} ${f}`),
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
    };
    downloadBlob(new Blob(["<gpx/>"]), "route.gpx", env);
    // revoked on the next line, WebKit found nothing to download
    expect(log).toEqual(["click blob:1 route.gpx"]);
    expect(timers[0]?.ms).toBe(REVOKE_AFTER_MS);
    timers[0]?.fn();
    expect(log).toEqual(["click blob:1 route.gpx", "revoke blob:1"]);
  });
});

function env(over: Partial<ShareEnv> = {}): ShareEnv & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    canShare: () => true,
    share: async (d) => {
      log.push(`share ${d.files?.length ?? 0} file(s)`);
    },
    copy: async (t) => {
      log.push(`copy ${t}`);
    },
    download: (_b, f) => {
      log.push(`download ${f}`);
    },
    tell: (m) => log.push(`tell ${m}`),
    ...over,
  };
}

const drawn = async (): Promise<PreparedImage> => {
  const img = new PreparedImage(Promise.resolve(new Blob(["png"])));
  await img.ready;
  return img;
};

describe("shareImage", () => {
  it("calls the share sheet before anything is awaited, when the card is ready", async () => {
    const e = env();
    const img = await drawn();
    void shareImage("I rode 5 km", img, "ride.png", e);
    // synchronously: WebKit refuses share() once the tap is over
    expect(e.log).toEqual(["share 1 file(s)"]);
  });

  it("a refused share saves the picture and copies the text, and says so", async () => {
    const e = env({
      share: () => Promise.reject(new DOMException("not in a gesture", "NotAllowedError")),
    });
    await shareImage("I rode 5 km", await drawn(), "ride.png", e);
    expect(e.log).toEqual(["download ride.png", "copy I rode 5 km", "tell Picture saved, text copied"]);
  });

  it("cancelling the share sheet is left alone", async () => {
    const e = env({ share: () => Promise.reject(new DOMException("cancelled", "AbortError")) });
    await shareImage("x", await drawn(), "ride.png", e);
    expect(e.log).toEqual([]);
  });

  it("a card still being drawn falls back visibly instead of sharing late", async () => {
    let finish: ((b: Blob) => void) | undefined;
    const img = new PreparedImage(new Promise<Blob>((r) => (finish = r)));
    const e = env();
    const done = shareImage("x", img, "ride.png", e);
    finish?.(new Blob(["png"]));
    await done;
    expect(e.log).toEqual(["download ride.png", "copy x", "tell Picture saved, text copied"]);
  });

  it("with no share sheet at all, and no picture, the text is still copied", async () => {
    const e = env();
    delete e.share;
    delete e.canShare;
    const img = new PreparedImage(Promise.reject(new Error("no canvas")));
    await img.ready;
    await shareImage("x", img, "ride.png", e);
    expect(e.log).toEqual(["copy x", "tell Text copied"]);
  });
});

describe("sharing when the save is refused", () => {
  it("says the picture wasn't saved, and only that", async () => {
    // in the app a save can fail; "Picture saved" over it, then an error
    // flashed on top, left the button saying whichever came last
    const told: string[] = [];
    const image = new PreparedImage(Promise.resolve(new Blob(["png"])));
    await image.ready;
    await shareImage("12 km!", image, "card.png", {
      copy: async () => undefined,
      download: async () => ({ error: "Downloads refused the file" }),
      tell: (m) => told.push(m),
    });
    expect(told).toEqual(["Picture not saved (Downloads refused the file); text copied"]);
  });
});

describe("downloadBlob in a real browser", () => {
  it("clicks a download link for the blob, and revokes it only later", async () => {
    // The browser default — the one GPX, backup and share-card downloads use —
    // was never run by a test: every case above passes its own env. Node has
    // URL.createObjectURL but no DOM, so give it the two DOM pieces it touches.
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    const clicked: { href: string; download: string }[] = [];
    const anchor = {
      href: "",
      download: "",
      click(): void {
        clicked.push({ href: this.href, download: this.download });
      },
    };
    const g = globalThis as unknown as Record<string, unknown>;
    const had = { document: g["document"], window: g["window"] };
    g["document"] = { createElement: (tag: string) => (tag === "a" ? anchor : null) };
    g["window"] = globalThis;
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    try {
      downloadBlob(new Blob(["<gpx/>"]), "ride.gpx");
      expect(clicked).toHaveLength(1);
      expect(clicked[0]?.download).toBe("ride.gpx");
      expect(clicked[0]?.href).toMatch(/^blob:/);
      // still readable when WebKit gets round to it...
      vi.advanceTimersByTime(REVOKE_AFTER_MS - 1);
      expect(revoke).not.toHaveBeenCalled();
      // ...and released afterwards, not leaked
      vi.advanceTimersByTime(1);
      expect(revoke).toHaveBeenCalledWith(clicked[0]?.href);
    } finally {
      revoke.mockRestore();
      vi.useRealTimers();
      g["document"] = had.document;
      g["window"] = had.window;
    }
  });
});

describe("saving a file the page made", () => {
  const env = (): DownloadEnv & { clicked: string[] } => {
    const clicked: string[] = [];
    return {
      clicked,
      createObjectURL: () => "blob:x",
      revokeObjectURL: () => undefined,
      click: (_u, f) => clicked.push(f),
      setTimeout: () => undefined,
    };
  };
  const blob = new Blob(["<gpx/>"], { type: "application/gpx+xml" });

  it("downloads at once in a browser, inside the tap that asked", () => {
    // WebKit honours an <a download> only inside the tap: nothing may be
    // awaited before it
    const e = env();
    void saveBlob(blob, "route.gpx", { can: () => false, save: async () => null }, e);
    expect(e.clicked).toEqual(["route.gpx"]);
  });

  it("saves into Downloads in the app, and never through a blob: link", async () => {
    // the blob: link reached MainActivity's DownloadListener and crashed the app
    const e = env();
    const saved: string[] = [];
    const result = await saveBlob(
      blob,
      "route.gpx",
      { can: () => true, save: async (_b, name) => (saved.push(name), { saved: true }) },
      e,
    );
    expect(result).toEqual({ saved: true });
    expect(saved).toEqual(["route.gpx"]);
    expect(e.clicked).toEqual([]);
  });

  it("says why, when the app could not save it", async () => {
    const result = await saveBlob(
      blob,
      "route.gpx",
      { can: () => true, save: async () => ({ error: "Downloads refused the file" }) },
      env(),
    );
    expect(result).toEqual({ error: "Downloads refused the file" });
  });
});
