import { describe, expect, it, vi } from "vitest";
import {
  MAX_RECORDING_MS,
  microphoneError,
  VoiceRecorder,
  type AudioCapture,
  type RecorderDeps,
} from "./recorder";
import { webAudioCapture } from "./webAudioCapture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake microphone: one second of a quiet tone at 48 kHz. */
function fakeCapture(): AudioCapture & {
  finished: number;
  canceled: number;
} {
  const capture = {
    finished: 0,
    canceled: 0,
    finish: () => {
      capture.finished += 1;
      return {
        chunks: [new Float32Array(48_000).fill(0.1)],
        sampleRate: 48_000,
      };
    },
    cancel: () => {
      capture.canceled += 1;
    },
  };
  return capture;
}

function setup(overrides: Partial<RecorderDeps> = {}) {
  let clock = 1_000;
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const capture = fakeCapture();
  const open = vi.fn(async () => capture as AudioCapture);
  const transcribe = vi.fn(async (_wav: Uint8Array) => " hello world ");
  const onText = vi.fn();
  const recorder = new VoiceRecorder(
    {
      open,
      transcribe,
      now: () => clock,
      setTimer: (run, ms) => {
        const timer = { run, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        (timer as { cleared: boolean }).cleared = true;
      },
      ...overrides,
    },
    onText,
  );
  const phases: string[] = [];
  recorder.subscribe(() => phases.push(recorder.state.kind));
  return {
    recorder,
    capture,
    open,
    transcribe,
    onText,
    timers,
    phases,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("VoiceRecorder", () => {
  it("records, transcribes 16 kHz WAV, and hands back the trimmed text", async () => {
    const t = setup();
    await t.recorder.start();
    expect(t.recorder.state).toEqual({ kind: "recording", startedAt: 1_000 });
    expect(t.open).toHaveBeenCalledWith(300);
    t.advance(1_000);
    await t.recorder.stop();
    expect(t.capture.finished).toBe(1);
    const wav = t.transcribe.mock.calls[0][0];
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
    expect(wav.length).toBe(44 + 16_000 * 2);
    expect(t.onText).toHaveBeenCalledWith("hello world");
    expect(t.phases).toEqual(["starting", "recording", "transcribing", "idle"]);
  });

  it("toggles: start when idle, stop when recording", async () => {
    const t = setup();
    t.recorder.toggle();
    await vi.waitFor(() => expect(t.recorder.state.kind).toBe("recording"));
    t.advance(500);
    t.recorder.toggle();
    await vi.waitFor(() => expect(t.onText).toHaveBeenCalled());
    expect(t.recorder.state.kind).toBe("idle");
  });

  it("stops itself at five minutes and transcribes", async () => {
    const t = setup();
    await t.recorder.start();
    expect(t.timers[0].ms).toBe(MAX_RECORDING_MS);
    t.advance(MAX_RECORDING_MS);
    t.timers[0].run();
    await vi.waitFor(() =>
      expect(t.onText).toHaveBeenCalledWith("hello world"),
    );
  });

  it("cancel drops the recording without transcribing", async () => {
    const t = setup();
    await t.recorder.start();
    t.advance(2_000);
    t.recorder.cancel();
    expect(t.capture.canceled).toBe(1);
    expect(t.capture.finished).toBe(0);
    expect(t.timers[0].cleared).toBe(true);
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.recorder.state.kind).toBe("idle");
  });

  it("cancel while transcribing discards the text that arrives later", async () => {
    const pending = deferred<string>();
    const t = setup({ transcribe: vi.fn(() => pending.promise) });
    await t.recorder.start();
    t.advance(1_000);
    const stopping = t.recorder.stop();
    expect(t.recorder.state.kind).toBe("transcribing");
    t.recorder.cancel();
    pending.resolve("too late");
    await stopping;
    expect(t.onText).not.toHaveBeenCalled();
    expect(t.recorder.state.kind).toBe("idle");
  });

  it("cancel while the microphone is opening releases it once it opens", async () => {
    const opening = deferred<AudioCapture>();
    const capture = fakeCapture();
    const t = setup({ open: vi.fn(() => opening.promise) });
    const starting = t.recorder.start();
    expect(t.recorder.state.kind).toBe("starting");
    t.recorder.cancel();
    opening.resolve(capture);
    await starting;
    expect(capture.canceled).toBe(1);
    expect(t.recorder.state.kind).toBe("idle");
  });

  it("ignores a stray click shorter than the minimum", async () => {
    const t = setup();
    await t.recorder.start();
    t.advance(100);
    await t.recorder.stop();
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.recorder.state.kind).toBe("idle");
  });

  it("inserts nothing for an empty transcript", async () => {
    const t = setup({ transcribe: vi.fn(async () => "  ") });
    await t.recorder.start();
    t.advance(1_000);
    await t.recorder.stop();
    expect(t.onText).not.toHaveBeenCalled();
    expect(t.recorder.state.kind).toBe("idle");
  });

  it("reports a denied microphone and a failed transcription", async () => {
    const denied = setup({
      open: vi.fn(async () => {
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      }),
    });
    await denied.recorder.start();
    expect(denied.recorder.state).toEqual({
      kind: "error",
      message:
        "Microphone access is off. Allow MonoCode in System Settings, Privacy & Security, Microphone.",
    });
    denied.recorder.dismiss();
    expect(denied.recorder.state.kind).toBe("idle");

    const failing = setup({
      transcribe: vi.fn(async () => {
        throw "whisper-cli not found. Install it with: brew install whisper-cpp";
      }),
    });
    await failing.recorder.start();
    failing.advance(1_000);
    await failing.recorder.stop();
    expect(failing.recorder.state).toEqual({
      kind: "error",
      message:
        "whisper-cli not found. Install it with: brew install whisper-cpp",
    });
  });

  it("does not open a second microphone while one is open", async () => {
    const t = setup();
    await t.recorder.start();
    await t.recorder.start();
    expect(t.open).toHaveBeenCalledTimes(1);
  });
});

describe("microphoneError", () => {
  it("names each getUserMedia failure", () => {
    expect(microphoneError({ name: "NotFoundError" })).toBe(
      "No microphone found.",
    );
    expect(microphoneError({ name: "NotReadableError" })).toBe(
      "The microphone is in use by another app.",
    );
    expect(microphoneError(new Error("odd"))).toBe("odd");
    expect(microphoneError(null)).toBe("Voice input failed.");
  });
});

/** A fake MediaStream and AudioContext, enough for webAudioCapture. */
function fakeWebAudio(options: { channels?: number; rate?: number } = {}) {
  const channels = options.channels ?? 1;
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const processor = {
    onaudioprocess: null as null | ((event: unknown) => void),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: options.rate ?? 48_000,
    state: "suspended",
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
  };
  const getUserMedia = vi.fn(async () => stream);
  const feed = (values: number[]) =>
    processor.onaudioprocess?.({
      inputBuffer: {
        numberOfChannels: channels,
        getChannelData: (c: number) =>
          new Float32Array(values.map((v) => v * (c + 1))),
      },
    });
  const capture = webAudioCapture({
    mediaDevices: { getUserMedia },
    createContext: () => context as unknown as AudioContext,
  });
  return { capture, getUserMedia, tracks, processor, source, context, feed };
}

describe("webAudioCapture", () => {
  it("asks for audio only, collects mono samples, and releases the microphone", async () => {
    const fake = fakeWebAudio({ channels: 2 });
    const capture = await fake.capture(10);
    expect(fake.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ channelCount: 1 }),
    });
    expect(fake.context.resume).toHaveBeenCalled();
    expect(fake.processor.connect).toHaveBeenCalledWith(
      fake.context.destination,
    );
    fake.feed([0.1, 0.2]);
    fake.feed([0.3]);
    const audio = capture.finish();
    expect(audio.sampleRate).toBe(48_000);
    // Two channels, the second twice the first: the mean is 1.5x.
    const heard = audio.chunks.flatMap((chunk) => Array.from(chunk));
    expect(audio.chunks).toHaveLength(2);
    [0.15, 0.3, 0.45].forEach((value, index) =>
      expect(heard[index]).toBeCloseTo(value, 5),
    );
    expect(fake.tracks[0].stop).toHaveBeenCalled();
    expect(fake.context.close).toHaveBeenCalled();
    expect(fake.processor.onaudioprocess).toBeNull();
    // Audio after release is ignored.
    fake.feed([0.9]);
    expect(audio.chunks).toHaveLength(2);
  });

  it("stops collecting at the cap", async () => {
    const fake = fakeWebAudio({ rate: 4 });
    const capture = await fake.capture(1);
    fake.feed([0.1, 0.1, 0.1]);
    fake.feed([0.1, 0.1, 0.1]);
    fake.feed([0.1]);
    const audio = capture.finish();
    expect(audio.chunks.reduce((n, chunk) => n + chunk.length, 0)).toBe(4);
  });

  it("cancel drops what it heard and stops the tracks", async () => {
    const fake = fakeWebAudio();
    const capture = await fake.capture(10);
    fake.feed([0.5]);
    capture.cancel();
    expect(fake.tracks[0].stop).toHaveBeenCalled();
    expect(capture.finish().chunks).toEqual([]);
  });

  it("fails clearly where there is no microphone API", async () => {
    const open = webAudioCapture({
      mediaDevices: undefined,
      createContext: () => {
        throw new Error("unused");
      },
    });
    await expect(open(1)).rejects.toThrow(
      "This window cannot use the microphone.",
    );
  });

  it("stops the tracks when the audio context cannot start", async () => {
    const stop = vi.fn();
    const open = webAudioCapture({
      mediaDevices: {
        getUserMedia: async () =>
          ({ getTracks: () => [{ stop }] }) as unknown as MediaStream,
      },
      createContext: () => {
        throw new Error("no audio");
      },
    });
    await expect(open(1)).rejects.toThrow("no audio");
    expect(stop).toHaveBeenCalled();
  });
});
