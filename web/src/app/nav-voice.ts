// Spoken guidance: the queue that says each instruction once and in order, the
// three voices it can use (the phone's own, the browser's, or none), the test
// button, and the buzz.

import { type SpeakPriority, SpeechQueue } from "../speech.js";
import { isNativeApp, lastNativeSpeechError, nativeSpeak, nativeStopSpeech, webVoiceCount } from "../native.js";
import { el } from "./dom.js";
import { distVoice } from "../units.js";
import { nav } from "./nav-state.js";
import { store } from "./store.js";
import { flashRideAlert } from "./nav-banner.js";

export function vibrate(pattern: number[]): void {
  if ("vibrate" in navigator) navigator.vibrate(pattern);
}

/** The spoken-guidance queue (see speech.ts). Safety beats navigation beats
 * encouragement — the old code called cancel() before every utterance, so
 * whichever line arrived second silenced the first, and the riders' logs showed
 * "busy street crossing. gather up." being eaten by turn calls (and vice versa)
 * dozens of times in one ride. */
export const speech = new SpeechQueue(
  {
    hasNative: isNativeApp,
    speakNative: nativeSpeak,
    stopNative: nativeStopSpeech,
    web: () => {
      // typed as always-present, but a WebView can leave it undefined
      const synth = window.speechSynthesis as SpeechSynthesis | undefined;
      if (!synth) return null;
      return {
        speak: (line): void => {
          const u = new SpeechSynthesisUtterance(line.text);
          u.rate = line.rate;
          u.volume = line.volume;
          u.onend = line.onEnd;
          u.onerror = line.onEnd;
          synth.speak(u);
        },
        cancel: (): void => synth.cancel(),
        get speaking(): boolean {
          return synth.speaking;
        },
      };
    },
  },
  { setTimeout: (fn, ms) => window.setTimeout(fn, ms) },
  () => noteVoiceUnavailable(),
);

/** Say a line and report which engine actually said it.
 *
 * "I can't hear it" has several causes that look identical from the saddle —
 * no engine installed, media volume down, audio on a Bluetooth device in a
 * pannier — and none of them announce themselves. This turns the question into
 * an answer before the ride rather than after it. */
function runVoiceTest(): void {
  const box = el<HTMLDivElement>("voice-status");
  const line = `Voice test. In ${distVoice(200)}, turn left onto the path.`;
  box.textContent = "testing…";
  if (!isNativeApp()) {
    browserVoiceTest(box, line);
    return;
  }
  void nativeVoiceTest(box, line);
}

/** In a browser, speak first and judge afterwards. iOS Safari speaks only when
 * the utterance is started inside the tap, and it reports no voices at all until
 * something has been spoken — so counting voices first, as this used to, told
 * every iPhone "this phone has no usable voice" and never tried. */
function browserVoiceTest(box: HTMLElement, line: string): void {
  const synth = window.speechSynthesis as SpeechSynthesis | undefined;
  if (!synth) {
    box.textContent = "✗ this browser has no voice — watch the screen for turns.";
    return;
  }
  const utter = new SpeechSynthesisUtterance(line);
  utter.rate = 1.05;
  let started = false;
  utter.onstart = (): void => {
    started = true;
  };
  synth.speak(utter);
  window.setTimeout(() => {
    const voices = webVoiceCount();
    box.textContent =
      started || synth.speaking
        ? `▶ spoken by the browser${voices > 0 ? ` (${voices} voices)` : ""}. ` +
          "A browser only talks while the screen is on, so keep this page open " +
          "on screen while you ride — navigating keeps the screen awake for you."
        : "✗ nothing was spoken. Check the phone isn't on silent and the media " +
          "volume is up, then test again.";
  }, 800);
}

async function nativeVoiceTest(box: HTMLElement, line: string): Promise<void> {
  if (await nativeSpeak(line)) {
    box.textContent =
      "✓ spoken by the phone's own voice engine — the one that keeps working " +
      "with the screen off. Heard nothing? Press volume-up while it plays " +
      "(that sets MEDIA volume), and check nothing is grabbing the audio over " +
      "Bluetooth.";
    return;
  }
  const err = lastNativeSpeechError();
  const voices = webVoiceCount();
  if (voices === 0) {
    box.textContent =
      `✗ this phone has no usable voice${err !== null ? ` (${err})` : ""}. ` +
      "Android: Settings → Accessibility → Text-to-speech output — install or " +
      "enable an engine and its English voice data. The app can't supply one.";
    return;
  }
  const utter = new SpeechSynthesisUtterance(line);
  utter.rate = 1.05;
  window.speechSynthesis.speak(utter);
  box.textContent =
    `▶ spoken by the browser engine (${voices} voices), but the app's own ` +
    `engine failed${err !== null ? `: ${err}` : ""} — that's the one that ` +
    "works with the screen off, so turns would go quiet in your pocket.";
}

function noteVoiceUnavailable(): void {
  if (nav.voiceWarned) return;
  nav.voiceWarned = true;
  const why = lastNativeSpeechError();
  console.warn("voice unavailable", why ?? "no voices");
  if (!store.navActive) return;
  // silence is the worst failure a spoken guide can have: a rider who thinks
  // the voice is coming stops watching the screen
  flashRideAlert("🔇 no voice on this phone — watch the screen for turns", "gps", 8000);
}

export function speak(text: string, priority: SpeakPriority = "turn"): void {
  if (nav.muted) return;
  speech.speak(text, priority);
}

/** Abandon anything queued or being said, on every engine (ride over, or
 * muted). */
export function clearSpeech(): void {
  speech.clear();
}

export function initNavVoice(): void {
  el<HTMLButtonElement>("voice-test").addEventListener("click", () => {
    runVoiceTest();
  });
}
