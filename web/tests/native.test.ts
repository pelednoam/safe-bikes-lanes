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
