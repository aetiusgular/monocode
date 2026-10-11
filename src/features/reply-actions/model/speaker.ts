import { useSyncExternalStore } from "react";

/*
 * Reads a reply out with the Web Speech API. On macOS the webview hands the
 * text to the system's own voices, so nothing leaves the machine. There is
 * one speaker for the whole app: starting a reply stops the one before it.
 */

let speakingId: string | null = null;
/** Bumped on every start and stop, so a late event from an old run is ignored. */
let run = 0;
/** WebKit drops an utterance's events once it is collected; hold the queue. */
const held: SpeechSynthesisUtterance[] = [];
let unloadHooked = false;
/** How long the engine is given to drop one reply before the next is queued. */
export const RESTART_DELAY_MS = 80;
const listeners = new Set<() => void>();

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  if (typeof window.SpeechSynthesisUtterance !== "function") return null;
  return window.speechSynthesis ?? null;
}

/** False where the webview has no speech synthesis, as WebKitGTK often does not. */
export function speechAvailable(): boolean {
  return synth() !== null;
}

function setSpeaking(id: string | null) {
  if (speakingId === id) return;
  speakingId = id;
  for (const notify of listeners) notify();
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** The reply being read out, if any. */
export function currentSpeakingId(): string | null {
  return speakingId;
}

/** True while the reply with this id is the one being read out. */
export function useSpeaking(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => speakingId === id,
    () => false,
  );
}

/**
 * Reads the chunks out in order as the reply `id`, in place of whatever was
 * being read. Returns false when there is nothing to say or no way to say it.
 */
export function speak(id: string, chunks: readonly string[]): boolean {
  const engine = synth();
  const texts = chunks.filter((chunk) => chunk.trim());
  if (!engine || texts.length === 0) return false;

  run += 1;
  const mine = run;
  // An idle engine is left alone: WebKit can drop a speak() that comes right
  // after a cancel(), so the cancel is kept for when there is speech to stop.
  const interrupting = speakingId !== null || engine.speaking || engine.pending;
  if (interrupting) engine.cancel();
  if (!unloadHooked) {
    unloadHooked = true;
    // Speech outlives the page that started it unless it is told to stop.
    window.addEventListener("pagehide", () => stopSpeaking());
  }

  const utterances = texts.map((text, index) => {
    const utterance = new window.SpeechSynthesisUtterance(text);
    const over = () => {
      if (run === mine) stopSpeaking(id);
    };
    if (index === texts.length - 1) utterance.onend = over;
    // One failed piece ends the reading; the rest would start mid-thought.
    utterance.onerror = over;
    return utterance;
  });
  held.length = 0;
  held.push(...utterances);
  setSpeaking(id);
  const start = () => {
    if (run !== mine) return;
    for (const utterance of utterances) engine.speak(utterance);
  };
  // After a cancel the engine gets a moment to let go of the old queue.
  if (interrupting) window.setTimeout(start, RESTART_DELAY_MS);
  else start();
  return true;
}

/** Stops the reading. With an id, only if that reply is the one being read. */
export function stopSpeaking(id?: string): void {
  if (speakingId === null) return;
  if (id !== undefined && id !== speakingId) return;
  run += 1;
  held.length = 0;
  synth()?.cancel();
  setSpeaking(null);
}
