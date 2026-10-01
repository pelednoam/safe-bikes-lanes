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

import { canSaveNative, type SaveResult, saveFileNative } from "./native.js";

/** How long a blob URL outlives the click that downloads it. */
export const REVOKE_AFTER_MS = 60_000;

export interface DownloadEnv {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Start the download of `url` as `filename` (an <a download> click). */
  click(url: string, filename: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

function browserDownloadEnv(): DownloadEnv {
  return {
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    click: (url, filename): void => {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  };
}

/** Download a blob as a file, keeping its URL alive long enough for WebKit. */
export function downloadBlob(blob: Blob, filename: string, env: DownloadEnv = browserDownloadEnv()): void {
  const url = env.createObjectURL(blob);
  env.click(url, filename);
  env.setTimeout(() => env.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/**
 * Save a blob as a file, wherever the page is running: into Downloads in the
 * Android app (see saveFileNative), as a download in a browser. Says what
 * happened, so the button that asked can tell the rider.
 *
 * The browser's download starts before anything is awaited: WebKit honours an
 * <a download> click only inside the tap that asked for it.
 */
export function saveBlob(
  blob: Blob,
  filename: string,
  app: { can: () => boolean; save: typeof saveFileNative } = { can: canSaveNative, save: saveFileNative },
  env?: DownloadEnv,
): Promise<SaveResult> {
  if (!app.can()) {
    downloadBlob(blob, filename, env);
    return Promise.resolve({ saved: true });
  }
  return app.save(blob, filename).then((r) => r ?? { error: "this version of the app can't save files" });
}

/** A picture being drawn for sharing, available synchronously once drawn —
 * so a tap that comes after it is ready can share inside the gesture. */
export class PreparedImage {
  blob: Blob | null = null;
  readonly ready: Promise<Blob | null>;

  constructor(drawing: Promise<Blob>) {
    this.ready = drawing.then(
      (b) => {
        this.blob = b;
        return b;
      },
      () => null,
    );
  }
}

export interface ShareEnv {
  canShare?: ((data: ShareData) => boolean) | undefined;
  share?: ((data: ShareData) => Promise<void>) | undefined;
  copy(text: string): Promise<void>;
  /** Save the picture; a result, where saving can fail (in the app). */
  download(blob: Blob, filename: string): void | Promise<SaveResult>;
  /** Say, visibly, what happened instead of the share sheet. `ok` is whether
   * what the rider asked for happened, so a refusal isn't dressed as a success. */
  tell(message: string, ok: boolean): void;
}

function isCancel(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Share a picture and its text from a tap. Everything up to share() is
 * synchronous, so it runs inside the gesture; when the share sheet is
 * unavailable, refused, or the picture is not drawn yet, the picture is saved
 * and the text copied — and the rider is told so, rather than nothing
 * happening. Cancelling the share sheet is an answer, not a failure. */
export function shareImage(
  text: string,
  image: PreparedImage,
  filename: string,
  env: ShareEnv,
): Promise<void> {
  const fallBack = async (): Promise<void> => {
    const blob = image.blob ?? (await image.ready);
    const saved = blob !== null ? await env.download(blob, filename) : undefined;
    // whether it really was copied: browsers refuse the clipboard as a matter of
    // course (no permission, the page not focused), and "text copied" over a
    // refusal is how a rider finds out later that they have nothing to paste
    const copied = await env.copy(text).then(
      () => true,
      () => false,
    );
    // one message, and a true one: "saved" over a refused save is the same trap
    if (blob === null) {
      if (copied) env.tell("Text copied", true);
      else env.tell("Couldn't copy the text", false);
    } else if (typeof saved === "object" && "error" in saved) {
      env.tell(`Picture not saved (${saved.error}); text ${copied ? "copied" : "not copied"}`, false);
    } else if (copied) {
      env.tell("Picture saved, text copied", true);
    } else {
      env.tell("Picture saved; couldn't copy the text", false);
    }
  };
  const blob = image.blob;
  if (blob !== null && env.share !== undefined) {
    const payload: ShareData = {
      text,
      files: [new File([blob], filename, { type: "image/png" })],
    };
    if (env.canShare?.(payload) === true) {
      return env.share(payload).catch((err: unknown) => (isCancel(err) ? undefined : fallBack()));
    }
  }
  return fallBack();
}
