// Handing a file to the rider: a download, or the phone's share sheet.
//
// Both went wrong in WebKit, which is every browser on an iPhone:
//
// - The download fallbacks (GPX, backup, share card) revoked the blob URL on
//   the line after a.click(). WebKit starts the download asynchronously, so by
//   the time it read the URL the blob was gone: an empty file, or nothing.
// - The share card was drawn (canvas.toBlob, which is asynchronous) after the
//   tap, and navigator.share was called once it was ready. WebKit only allows
//   share() inside the tap; afterwards it rejects with NotAllowedError, which
//   was caught and dropped — the button did nothing at all.
/** How long a blob URL outlives the click that downloads it. */
export const REVOKE_AFTER_MS = 60000;
function browserDownloadEnv() {
    return {
        createObjectURL: (b) => URL.createObjectURL(b),
        revokeObjectURL: (u) => URL.revokeObjectURL(u),
        click: (url, filename) => {
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
        },
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    };
}
/** Download a blob as a file, keeping its URL alive long enough for WebKit. */
export function downloadBlob(blob, filename, env = browserDownloadEnv()) {
    const url = env.createObjectURL(blob);
    env.click(url, filename);
    env.setTimeout(() => env.revokeObjectURL(url), REVOKE_AFTER_MS);
}
/** A picture being drawn for sharing, available synchronously once drawn —
 * so a tap that comes after it is ready can share inside the gesture. */
export class PreparedImage {
    constructor(drawing) {
        this.blob = null;
        this.ready = drawing.then((b) => {
            this.blob = b;
            return b;
        }, () => null);
    }
}
function isCancel(err) {
    return err instanceof Error && err.name === "AbortError";
}
/** Share a picture and its text from a tap. Everything up to share() is
 * synchronous, so it runs inside the gesture; when the share sheet is
 * unavailable, refused, or the picture is not drawn yet, the picture is saved
 * and the text copied — and the rider is told so, rather than nothing
 * happening. Cancelling the share sheet is an answer, not a failure. */
export function shareImage(text, image, filename, env) {
    const fallBack = async () => {
        const blob = image.blob ?? (await image.ready);
        if (blob !== null)
            env.download(blob, filename);
        await env.copy(text).catch(() => undefined);
        env.tell(blob !== null ? "Picture saved, text copied" : "Text copied");
    };
    const blob = image.blob;
    if (blob !== null && env.share !== undefined) {
        const payload = {
            text,
            files: [new File([blob], filename, { type: "image/png" })],
        };
        if (env.canShare?.(payload) === true) {
            return env.share(payload).catch((err) => (isCancel(err) ? undefined : fallBack()));
        }
    }
    return fallBack();
}
