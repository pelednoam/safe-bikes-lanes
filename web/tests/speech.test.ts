// The spoken-guidance queue, against a fake engine and a fake clock, so the
// order and timing of what a rider hears can be asserted exactly.
import { describe, expect, it } from "vitest";

import {
  type Clock,
  type SpeechEngine,
  SpeechQueue,
  speechDuration,
  type WebLine,
  type WebSynth,
} from "../src/speech.js";

class FakeClock implements Clock {
  now = 0;
  private timers: { at: number; fn: () => void }[] = [];
  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.push({ at: this.now + ms, fn });
    return this.timers.length;
  }
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers[0];
      if (!t || t.at > until) break;
      this.timers.shift();
      this.now = t.at;
      t.fn();
    }
    this.now = until;
  }
}

/** A browser engine that records what it was asked to say. `autoEnd` false
 * models an engine that never fires onend. */
class FakeSynth implements WebSynth {
  said: string[] = [];
  live: WebLine[] = [];
  cancelled = 0;
  speaking = false;
  speak(u: WebLine): void {
    this.said.push(u.text);
    this.live.push(u);
    this.speaking = true;
  }
  cancel(): void {
    this.cancelled++;
    this.live = [];
    this.speaking = false;
  }
  /** The engine reaches the end of a line it was given. */
  end(text: string): void {
    const u = this.live.find((x) => x.text === text);
    if (!u) throw new Error(`nothing speaking "${text}"`);
    this.live = this.live.filter((x) => x !== u);
    this.speaking = this.live.length > 0;
    u.onEnd();
  }
}

function engine(
  synth: FakeSynth | null,
  native: {
    speak: (t: string) => Promise<boolean>;
    stops: number;
  } | null = null,
): SpeechEngine {
  return {
    hasNative: () => native !== null,
    speakNative: (t) => (native ? native.speak(t) : Promise.resolve(false)),
    stopNative: () => {
      if (native) native.stops++;
    },
    web: () => synth,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("SpeechQueue on the browser engine", () => {
  it("speaks one line at a time, in priority order", () => {
    const synth = new FakeSynth();
    const q = new SpeechQueue(engine(synth), new FakeClock(), () => undefined);
    q.speak("in 100 meters, turn left");
    q.speak("halfway there!", "chat"); // dropped: guidance is waiting
    q.speak("turn right now");
    q.speak("busy street crossing. gather up.", "safety");
    expect(synth.said).toEqual(["in 100 meters, turn left"]);
    synth.end("in 100 meters, turn left");
    expect(synth.said[1]).toBe("busy street crossing. gather up.");
    synth.end("busy street crossing. gather up.");
    expect(synth.said).toEqual([
      "in 100 meters, turn left",
      "busy street crossing. gather up.",
      "turn right now",
    ]);
  });

  it("a finished line's fallback timer cannot cut the next line short", () => {
    // The fallback checked "is anything speaking?" instead of "did MY line
    // end?". Line A ends normally; B starts; A's timer fires while B is still
    // going, took B for A, and started C over the top of it.
    const synth = new FakeSynth();
    const clock = new FakeClock();
    const q = new SpeechQueue(engine(synth), clock, () => undefined);
    const a = "go";
    const b = "in two hundred meters, turn left onto the community path, then turn right";
    q.speak(a);
    q.speak(b);
    q.speak("c");
    clock.advance(100);
    synth.end(a); // B starts at t=100 and is long
    expect(synth.said).toEqual([a, b]);
    // A's fallback fires at speechDuration(a) + 1500, well inside B
    clock.advance(speechDuration(a) + 1500);
    expect(speechDuration(b) + 1500).toBeGreaterThan(speechDuration(a) + 1500);
    expect(synth.said, "C started while B was still being spoken").toEqual([a, b]);
    synth.end(b);
    expect(synth.said).toEqual([a, b, "c"]);
  });

  it("gives up on a line whose onend never comes, and moves on", () => {
    const synth = new FakeSynth();
    const clock = new FakeClock();
    const q = new SpeechQueue(engine(synth), clock, () => undefined);
    q.speak("first");
    q.speak("second");
    clock.advance(speechDuration("first") + 1499);
    expect(synth.said).toEqual(["first"]);
    clock.advance(1);
    expect(synth.said).toEqual(["first", "second"]);
  });

  it("speaks synchronously, so a line queued in a tap is spoken inside it", () => {
    const synth = new FakeSynth();
    const q = new SpeechQueue(engine(synth), new FakeClock(), () => undefined);
    q.speak("navigation started", "chat");
    expect(synth.said).toEqual(["navigation started"]); // no await in between
  });

  it("unlock speaks inside the tap once, silently, and never on a native app", () => {
    const synth = new FakeSynth();
    const q = new SpeechQueue(engine(synth), new FakeClock(), () => undefined);
    q.unlock();
    q.unlock();
    expect(synth.said).toEqual([""]);
    expect(synth.live[0]?.volume).toBe(0);

    const nativeSynth = new FakeSynth();
    const nq = new SpeechQueue(
      engine(nativeSynth, { speak: async () => true, stops: 0 }),
      new FakeClock(),
      () => undefined,
    );
    nq.unlock();
    expect(nativeSynth.said).toEqual([]);
  });

  it("reports an engine that takes a line and says nothing", () => {
    const synth = new FakeSynth();
    synth.speak = (u: WebLine): void => {
      synth.said.push(u.text); // Android's WebView: accepted, never spoken
    };
    const clock = new FakeClock();
    let warned = 0;
    const q = new SpeechQueue(engine(synth), clock, () => warned++);
    q.speak("turn left");
    clock.advance(400);
    expect(warned).toBe(1);
  });

  it("with no engine at all, says so and keeps the queue moving", () => {
    const clock = new FakeClock();
    let warned = 0;
    const q = new SpeechQueue(engine(null), clock, () => warned++);
    q.speak("one");
    q.speak("two");
    clock.advance(1);
    expect(warned).toBe(2);
    expect(q.busy).toBe(false);
  });

  it("clear cancels the line being spoken and forgets the rest", () => {
    const synth = new FakeSynth();
    const clock = new FakeClock();
    const q = new SpeechQueue(engine(synth), clock, () => undefined);
    q.speak("one");
    q.speak("two");
    q.clear();
    expect(synth.cancelled).toBe(1);
    expect(q.pending).toBe(0);
    // a line after a clear is spoken at once, and the old line's timers are inert
    q.speak("ride saved. 4.2 kilometers.", "chat");
    expect(synth.said).toEqual(["one", "ride saved. 4.2 kilometers."]);
    clock.advance(speechDuration("one") + 1500);
    q.speak("three");
    expect(synth.said).toHaveLength(2); // still speaking "ride saved"
  });
});

describe("SpeechQueue on the native engine", () => {
  it("starts the next line as soon as the native one has been spoken", async () => {
    // The plugin resolves when the line ENDS. Waiting its estimated duration on
    // top put every call a line-length late: "turn left now" three seconds —
    // fifteen metres at a child's pace — after it was due.
    const ends: (() => void)[] = [];
    const spoken: string[] = [];
    const native = {
      stops: 0,
      speak: (t: string): Promise<boolean> =>
        new Promise((resolve) => {
          spoken.push(t);
          ends.push(() => resolve(true));
        }),
    };
    const clock = new FakeClock();
    const q = new SpeechQueue(engine(new FakeSynth(), native), clock, () => undefined);
    q.speak("in 100 meters, turn left onto Elm Street");
    q.speak("turn left now");
    await flush();
    expect(spoken).toEqual(["in 100 meters, turn left onto Elm Street"]);
    ends[0]?.(); // the engine finished the line
    await flush();
    expect(spoken, "the next line waited for a timer after the first had ended").toEqual([
      "in 100 meters, turn left onto Elm Street",
      "turn left now",
    ]);
  });

  it("moves on from a native line that never finishes, so a warning is still said", async () => {
    // a TTS engine that hangs, or a plugin call lost across an app switch:
    // the queue waited on it for good, and everything after went unsaid
    const spoken: string[] = [];
    const native = {
      stops: 0,
      speak: (t: string): Promise<boolean> => {
        spoken.push(t);
        return new Promise<boolean>(() => undefined); // never settles
      },
    };
    const clock = new FakeClock();
    const q = new SpeechQueue(engine(new FakeSynth(), native), clock, () => undefined);
    q.speak("in 100 meters, turn left onto Elm Street");
    q.speak("busy street crossing. gather up.", "safety");
    await flush();
    expect(spoken).toEqual(["in 100 meters, turn left onto Elm Street"]);
    clock.advance(30_000);
    await flush();
    expect(spoken).toEqual(["in 100 meters, turn left onto Elm Street", "busy street crossing. gather up."]);
  });

  it("doesn't let a native line's fallback timer cut the next line short", async () => {
    const ends: (() => void)[] = [];
    const spoken: string[] = [];
    const native = {
      stops: 0,
      speak: (t: string): Promise<boolean> =>
        new Promise((resolve) => {
          spoken.push(t);
          ends.push(() => resolve(true));
        }),
    };
    const clock = new FakeClock();
    const q = new SpeechQueue(engine(new FakeSynth(), native), clock, () => undefined);
    q.speak("turn left");
    q.speak("then right onto a very long street name that takes a while to say");
    q.speak("halfway there!");
    await flush();
    ends[0]?.(); // the first line ends at once; its timer is still pending
    await flush();
    expect(spoken).toHaveLength(2);
    clock.advance(5_000); // the first line's fallback fires, mid second line
    await flush();
    expect(spoken, "the first line's timer finished the second one").toHaveLength(2);
  });

  it("falls back to the browser when the native engine cannot speak", async () => {
    const synth = new FakeSynth();
    const q = new SpeechQueue(
      engine(synth, { speak: async () => false, stops: 0 }),
      new FakeClock(),
      () => undefined,
    );
    q.speak("turn left");
    await flush();
    expect(synth.said).toEqual(["turn left"]);
  });

  it("clear stops the native voice, not just the browser's", async () => {
    const native = { stops: 0, speak: (): Promise<boolean> => new Promise(() => undefined) };
    const synth = new FakeSynth();
    const q = new SpeechQueue(engine(synth, native), new FakeClock(), () => undefined);
    q.speak("in 200 meters, turn right");
    await flush();
    q.clear(); // the rider pressed mute
    expect(native.stops, "muting left the native engine talking").toBe(1);
    expect(synth.cancelled).toBe(1);
  });

  it("a line that finishes after a clear does not start anything", async () => {
    let finish: (() => void) | undefined;
    const spoken: string[] = [];
    const native = {
      stops: 0,
      speak: (t: string): Promise<boolean> =>
        new Promise((resolve) => {
          spoken.push(t);
          finish = () => resolve(true);
        }),
    };
    const q = new SpeechQueue(engine(new FakeSynth(), native), new FakeClock(), () => undefined);
    q.speak("one");
    await flush();
    q.clear();
    const stale = finish;
    q.speak("two");
    await flush();
    stale?.(); // "one" reports that it ended — after it was cleared
    await flush();
    q.speak("three");
    await flush();
    expect(spoken).toEqual(["one", "two"]); // "three" waits for "two"
  });
});
