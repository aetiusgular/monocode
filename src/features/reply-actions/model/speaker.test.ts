// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESTART_DELAY_MS,
  currentSpeakingId,
  speak,
  speechAvailable,
  stopSpeaking,
} from "./speaker";

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

/** The webview's speech engine, as far as the speaker uses it. */
function fakeEngine() {
  const engine = {
    speaking: false,
    pending: false,
    queued: [] as FakeUtterance[],
    speak: vi.fn((utterance: FakeUtterance) => {
      engine.queued.push(utterance);
      engine.speaking = true;
    }),
    cancel: vi.fn(() => {
      engine.queued = [];
      engine.speaking = false;
    }),
    /** Finishes the piece at the head of the queue. */
    finishOne() {
      const utterance = engine.queued.shift();
      engine.speaking = engine.queued.length > 0;
      utterance?.onend?.();
    },
  };
  return engine;
}

let engine: ReturnType<typeof fakeEngine>;

beforeEach(() => {
  vi.useFakeTimers();
  engine = fakeEngine();
  vi.stubGlobal("speechSynthesis", engine);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  stopSpeaking();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the speaker", () => {
  it("queues every piece at once and names the reply being read", () => {
    expect(speak("a", ["One.", "Two.", "Three."])).toBe(true);
    expect(engine.queued.map((utterance) => utterance.text)).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
    expect(currentSpeakingId()).toBe("a");
    // Nothing was playing, so the engine was not cancelled first.
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it("is done only when the last piece has been read", () => {
    speak("a", ["One.", "Two."]);
    engine.finishOne();
    expect(currentSpeakingId()).toBe("a");
    engine.finishOne();
    expect(currentSpeakingId()).toBeNull();
  });

  it("stops on request and empties the engine's queue", () => {
    speak("a", ["One.", "Two."]);
    stopSpeaking("a");
    expect(engine.cancel).toHaveBeenCalledTimes(1);
    expect(engine.queued).toEqual([]);
    expect(currentSpeakingId()).toBeNull();
  });

  it("leaves another reply's reading alone when asked to stop by id", () => {
    speak("a", ["One."]);
    stopSpeaking("b");
    expect(engine.cancel).not.toHaveBeenCalled();
    expect(currentSpeakingId()).toBe("a");
  });

  it("reads one reply at a time: a second start replaces the first", () => {
    speak("a", ["One.", "Two."]);
    const first = [...engine.queued];
    speak("b", ["Other."]);
    expect(engine.cancel).toHaveBeenCalledTimes(1);
    expect(currentSpeakingId()).toBe("b");
    // The engine is given a moment after the cancel before the new queue.
    expect(engine.queued).toEqual([]);
    vi.advanceTimersByTime(RESTART_DELAY_MS);
    expect(engine.queued.map((utterance) => utterance.text)).toEqual([
      "Other.",
    ]);
    // WebKit reports the cancelled pieces late. They must not end "b".
    first[0].onerror?.();
    first[1].onend?.();
    expect(currentSpeakingId()).toBe("b");
  });

  it("does not start a replaced reading that was stopped while it waited", () => {
    speak("a", ["One."]);
    speak("b", ["Other."]);
    stopSpeaking("b");
    vi.advanceTimersByTime(RESTART_DELAY_MS);
    expect(engine.queued).toEqual([]);
    expect(currentSpeakingId()).toBeNull();
  });

  it("clears speech left over from before, such as after a reload", () => {
    engine.speaking = true;
    speak("a", ["One."]);
    expect(engine.cancel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RESTART_DELAY_MS);
    expect(engine.queued).toHaveLength(1);
  });

  it("ends the reading when a piece fails", () => {
    speak("a", ["One.", "Two."]);
    engine.queued[0].onerror?.();
    expect(currentSpeakingId()).toBeNull();
    expect(engine.queued).toEqual([]);
  });

  it("stops when the page goes away", () => {
    speak("a", ["One."]);
    window.dispatchEvent(new Event("pagehide"));
    expect(currentSpeakingId()).toBeNull();
    expect(engine.cancel).toHaveBeenCalled();
  });

  it("has nothing to do with no text", () => {
    expect(speak("a", [])).toBe(false);
    expect(speak("a", ["  "])).toBe(false);
    expect(engine.speak).not.toHaveBeenCalled();
    expect(currentSpeakingId()).toBeNull();
  });

  it("is unavailable where the webview has no speech synthesis", () => {
    expect(speechAvailable()).toBe(true);
    vi.stubGlobal("speechSynthesis", undefined);
    expect(speechAvailable()).toBe(false);
    expect(speak("a", ["One."])).toBe(false);
    expect(currentSpeakingId()).toBeNull();
    vi.stubGlobal("speechSynthesis", engine);
    vi.stubGlobal("SpeechSynthesisUtterance", undefined);
    expect(speechAvailable()).toBe(false);
  });
});
