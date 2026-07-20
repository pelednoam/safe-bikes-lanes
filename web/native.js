// Native (Capacitor) integrations, accessed through the runtime global so the
// same unbundled ES modules run on the website (where none of this exists)
// and inside the Android app. Every function degrades gracefully on the web.
export function isNativeApp() {
    return window.Capacitor?.isNativePlatform() ?? false;
}
function bgPlugin() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform())
        return null;
    try {
        return cap.registerPlugin("BackgroundGeolocation");
    }
    catch {
        return null;
    }
}
function ttsPlugin() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform())
        return null;
    try {
        return cap.registerPlugin("TextToSpeech");
    }
    catch {
        return null;
    }
}
/** Start a background location watcher (keeps a foreground service + GPS alive
 * with the screen off). Returns the watcher id, or null when unavailable. */
export async function startBackgroundWatcher(notificationTitle, notificationMessage, onFix, onError) {
    const plugin = bgPlugin();
    if (plugin === null)
        return null;
    try {
        return await plugin.addWatcher({
            backgroundTitle: notificationTitle,
            backgroundMessage: notificationMessage,
            requestPermissions: true,
            stale: false,
            distanceFilter: 3,
        }, (position, error) => {
            if (error) {
                if (error.code === "NOT_AUTHORIZED") {
                    onError('background location not allowed — set location to "Allow all the time"');
                    void plugin.openSettings().catch(() => undefined);
                }
                else {
                    onError(error.message ?? "location error");
                }
                return;
            }
            if (!position)
                return;
            onFix({
                lon: position.longitude,
                lat: position.latitude,
                accuracy: position.accuracy,
                heading: position.bearing,
                speed: position.speed,
            });
        });
    }
    catch {
        return null;
    }
}
export async function stopBackgroundWatcher(id) {
    const plugin = bgPlugin();
    if (plugin === null)
        return;
    await plugin.removeWatcher({ id }).catch(() => undefined);
}
/** Native text-to-speech (works with the screen off, unlike the WebView's
 * speechSynthesis). Returns false when unavailable so callers can fall back. */
export async function nativeSpeak(text) {
    const plugin = ttsPlugin();
    if (plugin === null)
        return false;
    try {
        await plugin.stop().catch(() => undefined);
        await plugin.speak({ text, rate: 1.05 });
        return true;
    }
    catch {
        return false;
    }
}
