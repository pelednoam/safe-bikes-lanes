// The spoken-guidance queue: one line at a time, most urgent first.
//
// Extracted from app.ts so it can be tested with a fake engine and clock, which
// is how three timing bugs in it were found:
//
// - The belt-and-braces timer for an engine that never fires onend checked
//   whether *anything* was being spoken, not whether *its own* line had ended.
//   A finished line's timer could therefore land in the middle of the next line,
//   mark that one finished too, and start the one after on top of it.
// - The phone's native engine resolves its promise when the line has been
//   spoken, and the queue then waited the line's estimated duration again before
//   the next one — "turn left now" held back by about three seconds, fifteen
//   metres at a child's pace, behind a line that had already finished.
// - Clearing the queue (mute, the end of a ride) cancelled only the browser's
//   engine, so the native voice carried on talking after the rider muted it.
//
// And one constraint of iOS: Safari only lets a page speak after an utterance
// was started synchronously inside a tap, once per page load. Anything awaited
// first — the wake lock, the native check — and the gesture is gone and every
// turn after it is silent. So the browser path is synchronous all the way from
// speak() to the engine, and unlock() exists to be called at the top of a tap.

export type SpeakPriority = "safety" | "turn" | "chat";

const PRIORITY_RANK: Record<SpeakPriority, number> = { safety: 3, turn: 2, chat: 1 };
/** Roughly how long a spoken line takes, for the never-fires-onend fallback. */
const SPEECH_MS_PER_CHAR = 62;
const SPEECH_MIN_MS = 900;
/** An engine that is going to speak has started within this. */
const SILENT_AFTER_MS = 400;
/** Slack on top of the estimated duration before a line is given up on. */
const FALLBACK_SLACK_MS = 1500;

export function speechDuration(text: string): number {
  return Math.max(SPEECH_MIN_MS, text.length * SPEECH_MS_PER_CHAR);
}

/** One line for the browser's engine. `onEnd` is for the end of the line
 * however it came — finished, or failed. */
export interface WebLine {
  text: string;
  rate: number;
  volume: number;
  onEnd: () => void;
}

/** The browser's engine, as the queue needs it (speechSynthesis, adapted). */
export interface WebSynth {
  speak(line: WebLine): void;
  cancel(): void;
  readonly speaking: boolean;
}

export interface SpeechEngine {
  /** A native engine to try first (the Android app). */
  hasNative(): boolean;
  /** Speak natively. Resolves once the line has been spoken — true — or false
   * when the native engine could not say it and the browser should. */
  speakNative(text: string): Promise<boolean>;
  /** Silence the native engine mid-line. */
  stopNative(): void;
  /** The browser's engine, if the page has one. */
  web(): WebSynth | null;
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
}

interface Queued {
  text: string;
  priority: SpeakPriority;
}

export class SpeechQueue {
  private queue: Queued[] = [];
  /** Id of the line being spoken, or null. Every line gets a fresh id, and a
   * clear() retires the current one, so a late callback from a line that is no
   * longer current can never finish the one that is. */
  private current: number | null = null;
  private seq = 0;
  private unlocked = false;

  constructor(
    private readonly engine: SpeechEngine,
    private readonly clock: Clock,
    /** Called when a line was handed to an engine that said nothing. */
    private readonly onUnavailable: () => void,
  ) {}

  /** Queue a line. Safety beats navigation beats encouragement, and
   * encouragement is dropped outright when real guidance is waiting. */
  speak(text: string, priority: SpeakPriority = "turn"): void {
    if (priority === "chat" && this.queue.length > 0) return;
    if (this.queue.some((u) => u.text === text)) return;
    this.queue.push({ text, priority });
    this.queue = this.queue
      .map((u, i) => ({ u, i }))
      .sort((a, b) => PRIORITY_RANK[b.u.priority] - PRIORITY_RANK[a.u.priority] || a.i - b.i)
      .map(({ u }) => u);
    this.drain();
  }

  /** Abandon everything: queued lines, and the one being spoken, on every
   * engine. */
  clear(): void {
    this.queue = [];
    this.current = null;
    this.seq++;
    this.engine.web()?.cancel();
    if (this.engine.hasNative()) this.engine.stopNative();
  }

  /** Make the browser's engine usable for the rest of the page's life. Call it
   * synchronously from a tap handler, before anything is awaited: iOS lets a
   * page speak only once speech has been started inside a user gesture. */
  unlock(): void {
    if (this.unlocked || this.engine.hasNative()) return;
    const synth = this.engine.web();
    if (synth === null) return;
    synth.speak({ text: "", rate: 1, volume: 0, onEnd: () => undefined });
    this.unlocked = true;
  }

  /** Lines waiting, for tests and diagnostics. */
  get pending(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  private drain(): void {
    if (this.current !== null) return;
    const next = this.queue.shift();
    if (!next) return;
    const id = ++this.seq;
    this.current = id;
    const done = (): void => {
      if (this.current !== id) return; // cleared, or long since superseded
      this.current = null;
      this.drain();
    };
    if (!this.engine.hasNative()) {
      // synchronous, so a line queued inside a tap is spoken inside it
      this.speakWeb(id, next.text, done);
      return;
    }
    // A native line that never settles (a TTS engine that hangs, a plugin
    // call lost across an app switch) used to hold the queue for good: every
    // turn call and safety warning after it went unsaid. It gets as long as
    // the web path gives a line with no onend, and then the queue moves on.
    this.clock.setTimeout(() => {
      if (this.current === id) done();
    }, speechDuration(next.text) + FALLBACK_SLACK_MS);
    this.engine
      .speakNative(next.text)
      .then((spoken) => {
        if (this.current !== id) return;
        // resolved at the end of the line: the next one goes now, not after
        // another estimate of how long this one took
        if (spoken) done();
        else this.speakWeb(id, next.text, done);
      })
      .catch(done);
  }

  private speakWeb(id: number, text: string, done: () => void): void {
    const synth = this.engine.web();
    if (synth === null) {
      this.onUnavailable();
      this.clock.setTimeout(done, 0);
      return;
    }
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      done();
    };
    synth.speak({ text, rate: 1.05, volume: 1, onEnd: finish });
    // Android's WebView has speechSynthesis but ships no voices: speak()
    // returns without a sound, an error or an onend. Ask whether anything is
    // actually being said rather than counting voices, which browsers report
    // late on a cold start.
    this.clock.setTimeout(() => {
      if (!ended && this.current === id && synth.speaking !== true) this.onUnavailable();
    }, SILENT_AFTER_MS);
    // Some engines never fire onend. This line's own flag, not "is anything
    // speaking": by now that may well be the next line.
    this.clock.setTimeout(finish, speechDuration(text) + FALLBACK_SLACK_MS);
  }
}
