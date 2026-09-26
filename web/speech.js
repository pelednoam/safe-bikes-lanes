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
const PRIORITY_RANK = { safety: 3, turn: 2, chat: 1 };
/** Roughly how long a spoken line takes, for the never-fires-onend fallback. */
const SPEECH_MS_PER_CHAR = 62;
const SPEECH_MIN_MS = 900;
/** An engine that is going to speak has started within this. */
const SILENT_AFTER_MS = 400;
/** Slack on top of the estimated duration before a line is given up on. */
const FALLBACK_SLACK_MS = 1500;
export function speechDuration(text) {
    return Math.max(SPEECH_MIN_MS, text.length * SPEECH_MS_PER_CHAR);
}
export class SpeechQueue {
    constructor(engine, clock, 
    /** Called when a line was handed to an engine that said nothing. */
    onUnavailable) {
        this.engine = engine;
        this.clock = clock;
        this.onUnavailable = onUnavailable;
        this.queue = [];
        /** Id of the line being spoken, or null. Every line gets a fresh id, and a
         * clear() retires the current one, so a late callback from a line that is no
         * longer current can never finish the one that is. */
        this.current = null;
        this.seq = 0;
        this.unlocked = false;
    }
    /** Queue a line. Safety beats navigation beats encouragement, and
     * encouragement is dropped outright when real guidance is waiting. */
    speak(text, priority = "turn") {
        if (priority === "chat" && this.queue.length > 0)
            return;
        if (this.queue.some((u) => u.text === text))
            return;
        this.queue.push({ text, priority });
        this.queue = this.queue
            .map((u, i) => ({ u, i }))
            .sort((a, b) => PRIORITY_RANK[b.u.priority] - PRIORITY_RANK[a.u.priority] || a.i - b.i)
            .map(({ u }) => u);
        this.drain();
    }
    /** Abandon everything: queued lines, and the one being spoken, on every
     * engine. */
    clear() {
        this.queue = [];
        this.current = null;
        this.seq++;
        this.engine.web()?.cancel();
        if (this.engine.hasNative())
            this.engine.stopNative();
    }
    /** Make the browser's engine usable for the rest of the page's life. Call it
     * synchronously from a tap handler, before anything is awaited: iOS lets a
     * page speak only once speech has been started inside a user gesture. */
    unlock() {
        if (this.unlocked || this.engine.hasNative())
            return;
        const synth = this.engine.web();
        if (synth === null)
            return;
        synth.speak({ text: "", rate: 1, volume: 0, onEnd: () => undefined });
        this.unlocked = true;
    }
    /** Lines waiting, for tests and diagnostics. */
    get pending() {
        return this.queue.length;
    }
    get busy() {
        return this.current !== null;
    }
    drain() {
        if (this.current !== null)
            return;
        const next = this.queue.shift();
        if (!next)
            return;
        const id = ++this.seq;
        this.current = id;
        const done = () => {
            if (this.current !== id)
                return; // cleared, or long since superseded
            this.current = null;
            this.drain();
        };
        if (!this.engine.hasNative()) {
            // synchronous, so a line queued inside a tap is spoken inside it
            this.speakWeb(id, next.text, done);
            return;
        }
        this.engine
            .speakNative(next.text)
            .then((spoken) => {
            if (this.current !== id)
                return;
            // resolved at the end of the line: the next one goes now, not after
            // another estimate of how long this one took
            if (spoken)
                done();
            else
                this.speakWeb(id, next.text, done);
        })
            .catch(done);
    }
    speakWeb(id, text, done) {
        const synth = this.engine.web();
        if (synth === null) {
            this.onUnavailable();
            this.clock.setTimeout(done, 0);
            return;
        }
        let ended = false;
        const finish = () => {
            if (ended)
                return;
            ended = true;
            done();
        };
        synth.speak({ text, rate: 1.05, volume: 1, onEnd: finish });
        // Android's WebView has speechSynthesis but ships no voices: speak()
        // returns without a sound, an error or an onend. Ask whether anything is
        // actually being said rather than counting voices, which browsers report
        // late on a cold start.
        this.clock.setTimeout(() => {
            if (!ended && this.current === id && synth.speaking !== true)
                this.onUnavailable();
        }, SILENT_AFTER_MS);
        // Some engines never fire onend. This line's own flag, not "is anything
        // speaking": by now that may well be the next line.
        this.clock.setTimeout(finish, speechDuration(text) + FALLBACK_SLACK_MS);
    }
}
