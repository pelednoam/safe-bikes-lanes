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
 * with the screen off). Returns the watcher id, or null when unavailable.
 *
 * `requestPermissions` should be false once rideLocationState(true) has asked:
 * the plugin's own request runs alongside starting its foreground service
 * rather than before it, and on Android 14+ that start is refused without the
 * permission and never retried. It stays true only where AppShell is missing. */
export async function startBackgroundWatcher(notificationTitle, notificationMessage, onFix, onError, options = {}) {
    const plugin = bgPlugin();
    if (plugin === null)
        return null;
    try {
        return await plugin.addWatcher({
            backgroundTitle: notificationTitle,
            backgroundMessage: notificationMessage,
            requestPermissions: options.requestPermissions ?? true,
            stale: false,
            distanceFilter: 3,
        }, (position, error) => {
            if (error) {
                if (error.code === "NOT_AUTHORIZED") {
                    // The plugin says NOT_AUTHORIZED for a refused permission AND for the
                    // phone's location switch being off, so find out which before
                    // telling the rider what to do about it.
                    void explainNotAuthorized(plugin).then((advice) => onError(advice.text, advice.fix));
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
async function explainNotAuthorized(plugin) {
    const advice = locationAdvice(await rideLocationState(false));
    if (advice !== null)
        return advice;
    // No AppShell to ask, or it says all is well by now: name both causes. Neither
    // is "Allow all the time" — the ride's notification is what keeps GPS going
    // with the screen off, so background permission is not what is missing.
    return {
        text: "location is off or not allowed — turn it on, and allow it for this app",
        fix: () => void plugin.openSettings().catch(() => undefined),
    };
}
export async function stopBackgroundWatcher(id) {
    const plugin = bgPlugin();
    if (plugin === null)
        return;
    await plugin.removeWatcher({ id }).catch(() => undefined);
}
/** A registered native plugin, or null on the web or if registering throws. */
function nativePlugin(name) {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform())
        return null;
    try {
        return cap.registerPlugin(name);
    }
    catch {
        return null;
    }
}
/** Take over Android's Back button and gesture. Returns false where there is
 * no native App plugin (the website), so the caller keeps its web fallback.
 *
 * Without a listener, Capacitor hands Back to the WebView's history and, when
 * that is empty, to Android — which on Android 7–11 finishes the activity, and
 * with it the plugins keeping GPS and the voice alive mid-ride. The web code's
 * pushState guard never ran in the app at all. */
export function onAndroidBack(handler) {
    const plugin = nativePlugin("App");
    if (plugin === null || typeof plugin.addListener !== "function")
        return false;
    void plugin.addListener("backButton", () => handler()).catch(() => undefined);
    return true;
}
/** Send the app to the background, as Home would, rather than closing it. */
export function minimizeApp() {
    const plugin = nativePlugin("App");
    if (plugin === null || typeof plugin.minimizeApp !== "function")
        return;
    void plugin.minimizeApp().catch(() => undefined);
}
function appShell() {
    const plugin = nativePlugin("AppShell");
    return plugin !== null && typeof plugin.locationStatus === "function" ? plugin : null;
}
export function classifyLocation(status) {
    // permission first: while it is refused, the switch is not the thing to fix
    if (!status.precise)
        return status.approximate ? "approximate" : "denied";
    return status.enabled ? "ready" : "off";
}
/** What to tell the rider about a location state, or null when there is
 * nothing to tell. Never "Allow all the time": the ride runs as a foreground
 * service with its notification, which is what keeps GPS going with the screen
 * off, so the background permission is neither needed nor asked for. */
export function locationAdvice(state) {
    const shell = appShell();
    const open = (which) => () => {
        void shell?.[which]().catch(() => undefined);
    };
    switch (state) {
        case "off":
            return {
                text: "location is off on this phone — tap here to turn it on",
                fix: open("openLocationSettings"),
            };
        case "approximate":
            // Approximate is a circle kilometres across: the ride would snap to the
            // wrong street, and every turn would be called late or not at all.
            return {
                text: "turn-by-turn needs precise location — tap, then Location › Use precise location",
                fix: open("openAppSettings"),
            };
        case "denied":
            return {
                text: "location isn't allowed — tap, then Location › Allow only while using the app",
                fix: open("openAppSettings"),
            };
        case "ready":
        case "unknown":
            return null;
    }
}
/** Location for a ride, first asking for precise permission when `ask`.
 *
 * This is the one place a ride asks. The app used to ask at launch, with no
 * hint of why a bike map wants location before anyone has planned a trip, and
 * then again inside the watcher — too late for its foreground service. */
export async function rideLocationState(ask) {
    const shell = appShell();
    if (shell === null)
        return "unknown";
    try {
        return classifyLocation(ask ? await shell.requestLocation() : await shell.locationStatus());
    }
    catch {
        return "unknown";
    }
}
/** Precise location already allowed in the app: true/false, or null on the
 * website (where the Permissions API answers instead). Precise only, because
 * with approximate alone the WebView's geolocation asks again — at launch. */
export async function nativeLocationAllowed() {
    const shell = appShell();
    if (shell === null)
        return null;
    try {
        return (await shell.locationStatus()).precise;
    }
    catch {
        return null;
    }
}
/** Keep the phone's screen on — for the length of a ride, not the app's.
 *
 * The app used to hold the screen on whenever it was open, planning included.
 * The ride also asks for a Wake Lock, which is all the website has; in the app
 * this is the native window flag, which does not depend on the WebView
 * supporting that API. A no-op on the website. */
export function keepScreenOn(on) {
    const shell = nativePlugin("AppShell");
    if (shell === null || typeof shell.keepScreenOn !== "function")
        return;
    void shell.keepScreenOn({ on }).catch(() => undefined);
}
/** Ask for the notification permission (Android 13+) before a ride's watcher
 * starts: without it the "navigation is running" notification is hidden, and
 * that notification is the only sign the ride is still tracking once the app
 * is out of view. Asked only while Android has never been asked — a refusal is
 * respected, and the ride works without it. `explain` gets a line to show while
 * the system dialog is up; the line is returned, or null when nothing was asked. */
export async function askForRideNotifications(explain) {
    const shell = appShell();
    if (shell === null)
        return null;
    try {
        if ((await shell.locationStatus()).notifications !== "prompt")
            return null;
        const line = "allow notifications, so Android can show that navigation is running";
        explain(line);
        await shell.requestNotifications();
        return line;
    }
    catch {
        return null;
    }
}
/** Start a file download (the APK update).
 *
 * This used to go through the Capacitor Browser plugin, which opens a Chrome
 * Custom Tab — and Custom Tabs silently DROP file downloads, so tapping
 * "install" appeared to do nothing. Navigating the WebView instead trips the
 * DownloadListener registered in MainActivity, which hands the URL to the
 * system browser to download and offer for install. */
export function startDownload(url) {
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
        window.setTimeout(() => frame.remove(), 60000);
        return;
    }
    window.open(url, "_blank");
}
/** True when `latest` is a newer app-vN tag than `current`. */
export function isNewerAppVersion(current, latest) {
    const num = (v) => {
        const m = /^app-v(\d+)$/.exec(v.trim());
        return m ? Number(m[1]) : null;
    };
    const c = num(current);
    const l = num(latest);
    return c !== null && l !== null && l > c;
}
let lastTtsError = null;
/** Why the last native speak() failed, for the voice test to report. Silence is
 * the worst possible failure mode for spoken guidance, so it has to be
 * explainable rather than just absent. */
export function lastNativeSpeechError() {
    return lastTtsError;
}
/** Native text-to-speech (works with the screen off, unlike the WebView's
 * speechSynthesis). Returns false when unavailable so callers can fall back. */
export async function nativeSpeak(text) {
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
    }
    catch (err) {
        lastTtsError = err instanceof Error ? err.message : String(err);
        return false;
    }
}
/** Voices the WebView itself can offer. Zero on Android, which is the point. */
export function webVoiceCount() {
    if (!("speechSynthesis" in window))
        return 0;
    try {
        return window.speechSynthesis.getVoices().length;
    }
    catch {
        return 0;
    }
}
