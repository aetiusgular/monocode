import { recordingToWav } from "./wav";

/** A recording stops itself and transcribes after five minutes. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;
/** Shorter than this is a stray click: nothing is transcribed. */
export const MIN_RECORDING_MS = 300;

export type VoicePhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "transcribing" }
  | { kind: "error"; message: string };

/** Mono samples at the device rate. */
export type CapturedAudio = {
  chunks: Float32Array[];
  sampleRate: number;
};

/** A microphone that is open and collecting samples. */
export type AudioCapture = {
  /** Stop collecting, release the microphone, and hand back the audio. */
  finish: () => CapturedAudio;
  /** Stop collecting and release the microphone. */
  cancel: () => void;
};

export type OpenCapture = (maxSeconds: number) => Promise<AudioCapture>;

export type RecorderDeps = {
  open: OpenCapture;
  /** Text for a 16 kHz mono 16-bit WAV. */
  transcribe: (wav: Uint8Array) => Promise<string>;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  maxMs?: number;
};

const IDLE: VoicePhase = { kind: "idle" };

/**
 * Idle, starting (asking for the microphone), recording, transcribing, then
 * idle again with the text handed to `onText`. Cancel drops the audio or the
 * pending transcript from any phase. Each run carries a generation, so a
 * microphone or transcript that arrives after a cancel is discarded.
 */
export class VoiceRecorder {
  private phase: VoicePhase = IDLE;
  private listeners = new Set<() => void>();
  private capture: AudioCapture | null = null;
  private generation = 0;
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly maxMs: number;

  constructor(
    private readonly deps: RecorderDeps,
    private readonly onText: (text: string) => void,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer =
      deps.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms));
    this.clearTimer =
      deps.clearTimer ??
      ((timer) =>
        globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.maxMs = deps.maxMs ?? MAX_RECORDING_MS;
  }

  get state(): VoicePhase {
    return this.phase;
  }

  /** Whether a click, the shortcut or Escape has something to act on. */
  get active(): boolean {
    return (
      this.phase.kind === "starting" ||
      this.phase.kind === "recording" ||
      this.phase.kind === "transcribing"
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VoicePhase => this.phase;

  /** The mic button and the shortcut: start, or stop and transcribe. */
  toggle(): void {
    if (this.phase.kind === "recording") void this.stop();
    else if (this.phase.kind === "idle" || this.phase.kind === "error") {
      void this.start();
    }
  }

  async start(): Promise<void> {
    if (this.active) return;
    const generation = ++this.generation;
    this.set({ kind: "starting" });
    let capture: AudioCapture;
    try {
      capture = await this.deps.open(this.maxMs / 1000);
    } catch (error) {
      if (generation === this.generation) {
        this.set({ kind: "error", message: microphoneError(error) });
      }
      return;
    }
    if (generation !== this.generation) {
      capture.cancel();
      return;
    }
    this.capture = capture;
    this.timer = this.setTimer(() => {
      if (generation === this.generation) void this.stop();
    }, this.maxMs);
    this.set({ kind: "recording", startedAt: this.now() });
  }

  /** Stop recording and transcribe. Only acts while recording. */
  async stop(): Promise<void> {
    if (this.phase.kind !== "recording" || !this.capture) return;
    const elapsed = this.now() - this.phase.startedAt;
    const generation = this.generation;
    const audio = this.release()?.finish();
    if (!audio || elapsed < MIN_RECORDING_MS) {
      this.set(IDLE);
      return;
    }
    this.set({ kind: "transcribing" });
    try {
      const wav = recordingToWav(audio.chunks, audio.sampleRate);
      const text = (await this.deps.transcribe(wav)).trim();
      if (generation !== this.generation) return;
      this.set(IDLE);
      if (text) this.onText(text);
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ kind: "error", message: errorText(error) });
    }
  }

  /** Escape: drop the recording, or ignore the transcript still coming. */
  cancel(): void {
    this.generation += 1;
    this.release()?.cancel();
    if (this.phase.kind !== "idle") this.set(IDLE);
  }

  /** Clear an error without starting. */
  dismiss(): void {
    if (this.phase.kind === "error") this.set(IDLE);
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  private release(): AudioCapture | null {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    const capture = this.capture;
    this.capture = null;
    return capture;
  }

  private set(phase: VoicePhase) {
    this.phase = phase;
    for (const listener of [...this.listeners]) listener();
  }
}

function errorText(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return text.trim() || "Voice input failed.";
}

/** getUserMedia's DOMException names, in words someone can act on. */
export function microphoneError(error: unknown): string {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is off. Allow MonoCode in System Settings, Privacy & Security, Microphone.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone found.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone is in use by another app.";
  }
  return errorText(error);
}
