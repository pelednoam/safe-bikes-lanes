// The native bridge, including the speech path behind a real bug report: the
// app went silent on a ride because Android's engine rejected a speak() with no
// language and the WebView it fell back to has no voices at all. Only the
// emulated E2E suite exercised this; unit coverage saw none of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTts {
  speak: (o: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
}

function installCapacitor(tts: FakeTts | null, native = true): void {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    Capacitor: {
      isNativePlatform: () => native,
      registerPlugin: (name: string) => {
        if (name === "TextToSpeech") {
          if (tts === null) throw new Error("plugin missing");
          return tts;
        }
        return {};
      },
    },
  };
}

describe("isNativeApp", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("is false in a browser and true in the app", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    let mod = await import("../src/native.js");
    expect(mod.isNativeApp()).toBe(false);

    vi.resetModules();
    installCapacitor({ speak: async () => undefined, stop: async () => undefined });
    mod = await import("../src/native.js");
    expect(mod.isNativeApp()).toBe(true);
  });
});

describe("speaking on the phone", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("asks for a language and a volume, not just text", async () => {
    // omitting lang is what made Android reject the call on a device whose
    // default language had no voice data installed
    const calls: Record<string, unknown>[] = [];
    installCapacitor({
      speak: async (o) => {
        calls.push(o);
      },
      stop: async () => undefined,
    });
    const { nativeSpeak, lastNativeSpeechError } = await import("../src/native.js");
    expect(await nativeSpeak("turn left")).toBe(true);
    expect(calls[0]).toMatchObject({ text: "turn left", lang: "en-US" });
    expect(calls[0]?.["volume"]).toBeGreaterThan(0);
    expect(lastNativeSpeechError()).toBeNull();
  });

  it("reports the engine's own reason when it refuses", async () => {
    installCapacitor({
      speak: async () => {
        throw new Error("Language is not supported");
      },
      stop: async () => undefined,
    });
    const { nativeSpeak, lastNativeSpeechError } = await import("../src/native.js");
    expect(await nativeSpeak("turn left")).toBe(false);
    // the voice test quotes this back to the rider, so it has to be the real one
    expect(lastNativeSpeechError()).toContain("Language is not supported");
  });

  it("says there's no plugin rather than pretending it spoke", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    const { nativeSpeak, lastNativeSpeechError } = await import("../src/native.js");
    expect(await nativeSpeak("turn left")).toBe(false);
    expect(lastNativeSpeechError()).toMatch(/plugin/i);
  });

  it("survives a stop() that fails before speaking", async () => {
    let spoke = false;
    installCapacitor({
      speak: async () => {
        spoke = true;
      },
      stop: async () => {
        throw new Error("nothing to stop");
      },
    });
    const { nativeSpeak } = await import("../src/native.js");
    expect(await nativeSpeak("turn left")).toBe(true);
    expect(spoke).toBe(true);
  });
});

describe("counting the WebView's own voices", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is zero when speechSynthesis is missing or empty", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    let mod = await import("../src/native.js");
    expect(mod.webVoiceCount()).toBe(0);

    vi.resetModules();
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      speechSynthesis: { getVoices: () => [] },
    };
    mod = await import("../src/native.js");
    expect(mod.webVoiceCount()).toBe(0);
  });

  it("counts what a real browser offers, and survives a throwing engine", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      speechSynthesis: { getVoices: () => [{ name: "a" }, { name: "b" }] },
    };
    let mod = await import("../src/native.js");
    expect(mod.webVoiceCount()).toBe(2);

    vi.resetModules();
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      speechSynthesis: {
        getVoices: () => {
          throw new Error("engine died");
        },
      },
    };
    mod = await import("../src/native.js");
    expect(mod.webVoiceCount()).toBe(0);
  });
});

describe("version comparison for the in-app updater", () => {
  it("only offers a strictly newer build", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    const { isNewerAppVersion } = await import("../src/native.js");
    expect(isNewerAppVersion("app-v45", "app-v46")).toBe(true);
    expect(isNewerAppVersion("app-v46", "app-v46")).toBe(false);
    expect(isNewerAppVersion("app-v46", "app-v45")).toBe(false);
    // never offer an "update" from a version string we can't parse
    expect(isNewerAppVersion("dev", "app-v46")).toBe(false);
    expect(isNewerAppVersion("app-v46", "latest")).toBe(false);
  });
});

describe("the background watcher that keeps GPS alive with the screen off", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function withBg(bg: Record<string, unknown> | null): void {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      Capacitor: {
        isNativePlatform: () => true,
        registerPlugin: (name: string) => {
          if (name === "BackgroundGeolocation") {
            if (bg === null) throw new Error("no plugin");
            return bg;
          }
          return {};
        },
      },
    };
  }

  it("asks for a foreground notification, and hands fixes back", async () => {
    type Cb = (p?: unknown, e?: unknown) => void;
    const captured: { cb?: Cb } = {};
    let opts: Record<string, unknown> = {};
    withBg({
      addWatcher: async (o: Record<string, unknown>, c: Cb) => {
        opts = o;
        captured.cb = c;
        return "watcher-1";
      },
      removeWatcher: async () => undefined,
      openSettings: async () => undefined,
    });
    const { startBackgroundWatcher } = await import("../src/native.js");
    const fixes: unknown[] = [];
    const id = await startBackgroundWatcher("Title", "Message", (f) => fixes.push(f), () => undefined);
    expect(id).toBe("watcher-1");
    // Android requires the persistent notification for background location
    expect(opts["backgroundTitle"]).toBe("Title");
    expect(opts["backgroundMessage"]).toBe("Message");

    captured.cb?.({ latitude: 42.38, longitude: -71.1, accuracy: 5, speed: 3, bearing: 90 });
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ lat: 42.38, lon: -71.1 });
  });

  it("explains the Android permission that actually matters", async () => {
    type Cb2 = (p?: unknown, e?: unknown) => void;
    const captured2: { cb?: Cb2 } = {};
    let settingsOpened = false;
    withBg({
      addWatcher: async (_o: unknown, c: Cb2) => {
        captured2.cb = c;
        return "w";
      },
      removeWatcher: async () => undefined,
      openSettings: async () => {
        settingsOpened = true;
      },
    });
    const { startBackgroundWatcher } = await import("../src/native.js");
    const errors: string[] = [];
    await startBackgroundWatcher("t", "m", () => undefined, (msg) => errors.push(msg));

    captured2.cb?.(undefined, { code: "NOT_AUTHORIZED", message: "denied" });
    // "Allow all the time" is the specific setting, and saying so is the fix
    expect(errors[0]).toMatch(/Allow all the time/);
    expect(settingsOpened).toBe(true);

    captured2.cb?.(undefined, { code: "OTHER", message: "gps unavailable" });
    expect(errors[1]).toBe("gps unavailable");
  });

  it("returns null instead of throwing when the plugin isn't there", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    const { startBackgroundWatcher, stopBackgroundWatcher } = await import("../src/native.js");
    expect(await startBackgroundWatcher("t", "m", () => undefined, () => undefined)).toBeNull();
    // stopping something that never started must not throw mid-ride
    await expect(stopBackgroundWatcher("nope")).resolves.toBeUndefined();
  });

  it("stops the watcher it started", async () => {
    const removed: string[] = [];
    withBg({
      addWatcher: async () => "w9",
      removeWatcher: async (o: { id: string }) => {
        removed.push(o.id);
      },
      openSettings: async () => undefined,
    });
    const { stopBackgroundWatcher } = await import("../src/native.js");
    await stopBackgroundWatcher("w9");
    expect(removed).toEqual(["w9"]);
  });

  it("survives a watcher that fails to start", async () => {
    withBg({
      addWatcher: async () => {
        throw new Error("permission denied");
      },
      removeWatcher: async () => undefined,
      openSettings: async () => undefined,
    });
    const { startBackgroundWatcher } = await import("../src/native.js");
    expect(await startBackgroundWatcher("t", "m", () => undefined, () => undefined)).toBeNull();
  });
});

describe("starting an APK download", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses a hidden iframe in the app, so the page survives", async () => {
    // A top-level navigation to a binary would leave the rider staring at a
    // blank WebView if the DownloadListener ever didn't fire.
    const appended: Record<string, unknown>[] = [];
    const frame: Record<string, unknown> = { style: {}, remove: () => undefined };
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      Capacitor: { isNativePlatform: () => true, registerPlugin: () => ({}) },
      setTimeout: () => 0,
      open: () => {
        throw new Error("must not navigate the top document");
      },
    };
    (globalThis as unknown as { document: Record<string, unknown> }).document = {
      createElement: () => frame,
      body: { appendChild: (f: Record<string, unknown>) => appended.push(f) },
    };
    const { startDownload } = await import("../src/native.js");
    startDownload("https://example.test/app.apk");
    expect(appended).toHaveLength(1);
    expect(frame["src"]).toBe("https://example.test/app.apk");
    expect((frame["style"] as Record<string, unknown>)["display"]).toBe("none");
  });

  it("opens a tab in a browser", async () => {
    const opened: string[] = [];
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      open: (u: string) => opened.push(u),
    };
    const { startDownload } = await import("../src/native.js");
    startDownload("https://example.test/app.apk");
    expect(opened).toEqual(["https://example.test/app.apk"]);
  });
});
