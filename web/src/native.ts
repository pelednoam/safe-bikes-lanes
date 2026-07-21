// Native (Capacitor) integrations, accessed through the runtime global so the
// same unbundled ES modules run on the website (where none of this exists)
// and inside the Android app. Every function degrades gracefully on the web.

export interface NativeFix {
  lon: number;
  lat: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
}

interface BgLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  bearing: number | null;
  speed: number | null;
}

interface BgError {
  code?: string;
  message?: string;
}

interface BgWatcherOptions {
  backgroundMessage: string;
  backgroundTitle: string;
  requestPermissions: boolean;
  stale: boolean;
  distanceFilter: number;
}

interface BgPlugin {
  addWatcher(
    options: BgWatcherOptions,
    callback: (position?: BgLocation, error?: BgError) => void,
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}

interface TtsPlugin {
  speak(options: { text: string; rate?: number }): Promise<void>;
  stop(): Promise<void>;
}

interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform(): boolean;
  registerPlugin<T>(name: string): T;
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
  }
}

export function isNativeApp(): boolean {
  return window.Capacitor?.isNativePlatform() ?? false;
}

function bgPlugin(): BgPlugin | null {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform()) return null;
  try {
    return cap.registerPlugin<BgPlugin>("BackgroundGeolocation");
  } catch {
    return null;
  }
}

function ttsPlugin(): TtsPlugin | null {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform()) return null;
  try {
    return cap.registerPlugin<TtsPlugin>("TextToSpeech");
  } catch {
    return null;
  }
}

/** Start a background location watcher (keeps a foreground service + GPS alive
 * with the screen off). Returns the watcher id, or null when unavailable. */
export async function startBackgroundWatcher(
  notificationTitle: string,
  notificationMessage: string,
  onFix: (fix: NativeFix) => void,
  onError: (message: string) => void,
): Promise<string | null> {
  const plugin = bgPlugin();
  if (plugin === null) return null;
  try {
    return await plugin.addWatcher(
      {
        backgroundTitle: notificationTitle,
        backgroundMessage: notificationMessage,
        requestPermissions: true,
        stale: false,
        distanceFilter: 3,
      },
      (position?: BgLocation, error?: BgError) => {
        if (error) {
          if (error.code === "NOT_AUTHORIZED") {
            onError('background location not allowed — set location to "Allow all the time"');
            void plugin.openSettings().catch(() => undefined);
          } else {
            onError(error.message ?? "location error");
          }
          return;
        }
        if (!position) return;
        onFix({
          lon: position.longitude,
          lat: position.latitude,
          accuracy: position.accuracy,
          heading: position.bearing,
          speed: position.speed,
        });
      },
    );
  } catch {
    return null;
  }
}

export async function stopBackgroundWatcher(id: string): Promise<void> {
  const plugin = bgPlugin();
  if (plugin === null) return;
  await plugin.removeWatcher({ id }).catch(() => undefined);
}

/** Open a URL in the system browser (Chrome Custom Tab) — needed for APK
 * downloads, which the WebView itself won't handle. False when unavailable. */
export async function openExternal(url: string): Promise<boolean> {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform()) return false;
  try {
    await cap.registerPlugin<BrowserPlugin>("Browser").open({ url });
    return true;
  } catch {
    return false;
  }
}

/** True when `latest` is a newer app-vN tag than `current`. */
export function isNewerAppVersion(current: string, latest: string): boolean {
  const num = (v: string): number | null => {
    const m = /^app-v(\d+)$/.exec(v.trim());
    return m ? Number(m[1]) : null;
  };
  const c = num(current);
  const l = num(latest);
  return c !== null && l !== null && l > c;
}

/** Native text-to-speech (works with the screen off, unlike the WebView's
 * speechSynthesis). Returns false when unavailable so callers can fall back. */
export async function nativeSpeak(text: string): Promise<boolean> {
  const plugin = ttsPlugin();
  if (plugin === null) return false;
  try {
    await plugin.stop().catch(() => undefined);
    await plugin.speak({ text, rate: 1.05 });
    return true;
  } catch {
    return false;
  }
}
