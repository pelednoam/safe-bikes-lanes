// The Android shell's JS side: Back, and location for a ride — asked in the
// right order, and explained by what is actually wrong. The native plugins are
// fakes that record their calls; what Android does with them is for a phone.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LocationStatus } from "../src/native.js";

type Plugins = Record<string, Record<string, unknown>>;

function installApp(plugins: Plugins, native = true): void {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    Capacitor: {
      isNativePlatform: () => native,
      registerPlugin: (name: string) => plugins[name] ?? {},
    },
  };
}

function status(overrides: Partial<LocationStatus> = {}): LocationStatus {
  return { precise: true, approximate: true, enabled: true, notifications: "granted", ...overrides };
}

/** An AppShell fake reporting `now`, and recording every call. */
function shell(now: LocationStatus, calls: string[], afterRequest: LocationStatus = now): Plugins {
  const rec =
    (name: string, value: unknown = undefined) =>
    async (): Promise<unknown> => {
      calls.push(name);
      return value;
    };
  return {
    AppShell: {
      locationStatus: rec("locationStatus", now),
      requestLocation: rec("requestLocation", afterRequest),
      requestNotifications: rec("requestNotifications", { notifications: "granted" }),
      openLocationSettings: rec("openLocationSettings"),
      openAppSettings: rec("openAppSettings"),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("what a location state means for a ride", () => {
  it("tells the switch being off from a refused permission, and approximate from both", async () => {
    installApp({});
    const { classifyLocation } = await import("../src/native.js");
    expect(classifyLocation(status())).toBe("ready");
    expect(classifyLocation(status({ enabled: false }))).toBe("off");
    // Android 12+'s "Approximate": coarse granted, fine not
    expect(classifyLocation(status({ precise: false, approximate: true }))).toBe("approximate");
    expect(classifyLocation(status({ precise: false, approximate: false }))).toBe("denied");
    // refused AND switched off: the permission is what to fix first
    expect(classifyLocation(status({ precise: false, approximate: false, enabled: false }))).toBe(
      "denied",
    );
  });

  it("sends each problem to the screen that fixes it, and never to 'all the time'", async () => {
    const calls: string[] = [];
    installApp(shell(status(), calls));
    const { locationAdvice } = await import("../src/native.js");
    expect(locationAdvice("ready")).toBeNull();
    expect(locationAdvice("unknown")).toBeNull();

    const off = locationAdvice("off");
    expect(off?.text).toMatch(/location is off/i);
    off?.fix?.();
    const approx = locationAdvice("approximate");
    expect(approx?.text).toMatch(/precise location/i);
    approx?.fix?.();
    const denied = locationAdvice("denied");
    expect(denied?.text).toMatch(/while using the app/i);
    denied?.fix?.();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual(["openLocationSettings", "openAppSettings", "openAppSettings"]);

    for (const advice of [off, approx, denied]) {
      expect(advice?.text).not.toMatch(/all the time/i);
    }
  });
});

describe("asking for location when a ride starts", () => {
  it("asks only when told to, and reports what came back", async () => {
    const calls: string[] = [];
    installApp(
      shell(status({ precise: false, approximate: false }), calls, status({ precise: false })),
    );
    const { rideLocationState } = await import("../src/native.js");
    // looking does not ask
    expect(await rideLocationState(false)).toBe("denied");
    expect(calls).toEqual(["locationStatus"]);
    // asking: the rider picked "Approximate" in the dialog
    expect(await rideLocationState(true)).toBe("approximate");
    expect(calls).toEqual(["locationStatus", "requestLocation"]);
  });

  it("is 'unknown' without the AppShell plugin, so the old path still runs", async () => {
    installApp({});
    const { rideLocationState, nativeLocationAllowed } = await import("../src/native.js");
    expect(await rideLocationState(true)).toBe("unknown");
    expect(await nativeLocationAllowed()).toBeNull();
  });

  it("is 'unknown' when the plugin call fails, rather than throwing mid-start", async () => {
    installApp({
      AppShell: {
        locationStatus: async () => {
          throw new Error("not implemented");
        },
        requestLocation: async () => {
          throw new Error("not implemented");
        },
      },
    });
    const { rideLocationState } = await import("../src/native.js");
    expect(await rideLocationState(true)).toBe("unknown");
  });

  it("counts only precise location as already allowed at launch", async () => {
    // with approximate alone, the WebView's geolocation would raise Android's
    // permission dialog — at launch, which is what stopped happening
    installApp(shell(status({ precise: false, approximate: true }), []));
    const { nativeLocationAllowed } = await import("../src/native.js");
    expect(await nativeLocationAllowed()).toBe(false);
    vi.resetModules();
    installApp(shell(status(), []));
    const again = await import("../src/native.js");
    expect(await again.nativeLocationAllowed()).toBe(true);
  });

  it("the watcher does not ask again once permission has been sorted", async () => {
    let asked: unknown;
    installApp({
      BackgroundGeolocation: {
        addWatcher: async (o: { requestPermissions: boolean }) => {
          asked = o.requestPermissions;
          return "w";
        },
      },
    });
    const { startBackgroundWatcher } = await import("../src/native.js");
    await startBackgroundWatcher("t", "m", () => undefined, () => undefined, {
      requestPermissions: false,
    });
    expect(asked).toBe(false);
  });

  it("explains a NOT_AUTHORIZED from the watcher by what is actually wrong", async () => {
    type Cb = (p?: unknown, e?: unknown) => void;
    const got: { cb?: Cb } = {};
    const calls: string[] = [];
    installApp({
      ...shell(status({ enabled: false }), calls),
      BackgroundGeolocation: {
        addWatcher: async (_o: unknown, cb: Cb) => {
          got.cb = cb;
          return "w";
        },
        openSettings: async () => {
          calls.push("appSettingsFromWatcher");
        },
      },
    });
    const { startBackgroundWatcher } = await import("../src/native.js");
    const said: { msg: string; fix?: () => void }[] = [];
    await startBackgroundWatcher(
      "t",
      "m",
      () => undefined,
      (msg, fix) => said.push(fix === undefined ? { msg } : { msg, fix }),
    );
    got.cb?.(undefined, { code: "NOT_AUTHORIZED", message: "Location services disabled." });
    await vi.waitFor(() => expect(said).toHaveLength(1));
    expect(said[0]?.msg).toMatch(/location is off/i);
    said[0]?.fix?.();
    await vi.waitFor(() => expect(calls).toContain("openLocationSettings"));
    expect(calls).not.toContain("appSettingsFromWatcher");
  });
});

describe("the notification permission a ride needs", () => {
  it("is asked once, with a line saying why, while Android has never asked", async () => {
    const calls: string[] = [];
    installApp(shell(status({ notifications: "prompt" }), calls));
    const { askForRideNotifications } = await import("../src/native.js");
    const shown: string[] = [];
    const line = await askForRideNotifications((l) => shown.push(l));
    expect(calls).toEqual(["locationStatus", "requestNotifications"]);
    expect(shown).toHaveLength(1);
    expect(line).toBe(shown[0]);
    expect(line).toMatch(/navigation is running/);
  });

  it("is not asked again after an answer, or below Android 13", async () => {
    for (const state of ["granted", "denied", "prompt-with-rationale"]) {
      vi.resetModules();
      const calls: string[] = [];
      installApp(shell(status({ notifications: state }), calls));
      const { askForRideNotifications } = await import("../src/native.js");
      const shown: string[] = [];
      expect(await askForRideNotifications((l) => shown.push(l))).toBeNull();
      expect(calls, state).toEqual(["locationStatus"]);
      expect(shown, state).toEqual([]);
    }
  });
});

describe("Android's Back", () => {
  it("is taken over in the app, and left alone on the website", async () => {
    let listener: (() => void) | undefined;
    const calls: string[] = [];
    installApp({
      App: {
        addListener: async (event: string, cb: () => void) => {
          if (event === "backButton") listener = cb;
          return { remove: async () => undefined };
        },
        minimizeApp: async () => {
          calls.push("minimizeApp");
        },
      },
    });
    const { onAndroidBack, minimizeApp } = await import("../src/native.js");
    let pressed = 0;
    expect(onAndroidBack(() => pressed++)).toBe(true);
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.();
    expect(pressed).toBe(1);
    minimizeApp();
    await vi.waitFor(() => expect(calls).toEqual(["minimizeApp"]));

    vi.resetModules();
    installApp({}, false);
    const web = await import("../src/native.js");
    expect(web.onAndroidBack(() => undefined)).toBe(false);
    expect(() => web.minimizeApp()).not.toThrow();
  });
});

describe("keeping the screen on", () => {
  it("asks the app's window, and does nothing on the website", async () => {
    const got: unknown[] = [];
    installApp({
      AppShell: {
        keepScreenOn: async (o: unknown) => {
          got.push(o);
        },
      },
    });
    const { keepScreenOn } = await import("../src/native.js");
    keepScreenOn(true);
    keepScreenOn(false);
    await vi.waitFor(() => expect(got).toEqual([{ on: true }, { on: false }]));

    vi.resetModules();
    installApp({}, false);
    const web = await import("../src/native.js");
    expect(() => web.keepScreenOn(true)).not.toThrow();
  });
});
