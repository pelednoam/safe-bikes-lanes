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
  speak(options: {
    text: string;
    rate?: number;
    lang?: string;
    volume?: number;
    pitch?: number;
  }): Promise<void>;
  stop(): Promise<void>;
  getSupportedVoices?(): Promise<{ voices: unknown[] }>;
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

/** Start a file download (the APK update).
 *
 * This used to go through the Capacitor Browser plugin, which opens a Chrome
 * Custom Tab — and Custom Tabs silently DROP file downloads, so tapping
 * "install" appeared to do nothing. Navigating the WebView instead trips the
 * DownloadListener registered in MainActivity, which hands the URL to the
 * system browser to download and offer for install. */
export function startDownload(url: string): void {
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform()) {
    // Loaded in a hidden iframe rather than by navigating the top document:
    // the DownloadListener fires either way, but if it ever doesn't, a
    // top-level navigation to a binary would leave the rider staring at a
    // blank WebView — this way the app page survives.
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.src = url;
    document.body.appendChild(frame);
    window.setTimeout(() => frame.remove(), 60_000);
    return;
  }
  window.open(url, "_blank");
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

let lastTtsError: string | null = null;

/** Why the last native speak() failed, for the voice test to report. Silence is
 * the worst possible failure mode for spoken guidance, so it has to be
 * explainable rather than just absent. */
export function lastNativeSpeechError(): string | null {
  return lastTtsError;
}

/** Native text-to-speech (works with the screen off, unlike the WebView's
 * speechSynthesis). Returns false when unavailable so callers can fall back. */
export async function nativeSpeak(text: string): Promise<boolean> {
  const plugin = ttsPlugin();
  if (plugin === null) {
    lastTtsError = "no native speech plugin";
    return false;
  }
  try {
    await plugin.stop().catch(() => undefined);
    // lang and volume are explicit: the Android engine rejects speak() when the
    // device's default language has no voice data installed, and that rejection
    // used to drop us to the WebView — which has no voices at all on Android,
    // so the ride simply went quiet with nothing said about it.
    await plugin.speak({ text, rate: 1.05, lang: "en-US", volume: 1.0 });
    lastTtsError = null;
    return true;
  } catch (err) {
    lastTtsError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/** Voices the WebView itself can offer. Zero on Android, which is the point. */
export function webVoiceCount(): number {
  if (!("speechSynthesis" in window)) return 0;
  try {
    return window.speechSynthesis.getVoices().length;
  } catch {
    return 0;
  }
}
