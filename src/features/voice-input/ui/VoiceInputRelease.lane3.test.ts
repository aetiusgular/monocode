// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../../platform/tauri/platform", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../platform/tauri/platform")
  >()),
  IS_MAC: true,
}));

import { VoiceInputButton } from "./VoiceInputButton";
import { __setVoiceStatusReader } from "../model/voiceStatus";
import type { VoiceStatus } from "../model/voiceCommands";
import type { AudioCapture } from "../model/recorder";

// #49: the quick entry panel bumps `releaseSignal` when it hides or loses
// focus. The microphone must not stay on out of sight.

const READY: VoiceStatus = {
  whisperCli: "/opt/homebrew/bin/whisper-cli",
  modelPath: "/data/voice/ggml-base.en.bin",
  modelBytes: 10,
  expectedModelBytes: 10,
  modelUrl: "https://example.invalid/model.bin",
  modelSha256: "0".repeat(64),
};

let container: HTMLDivElement;
let root: Root;
let textarea: HTMLTextAreaElement;
let canceled = 0;
let finished = 0;
const transcribe = vi.fn(async (_wav: Uint8Array) => "dictated text");
let openGate: Promise<void> = Promise.resolve();
const open = vi.fn(async (): Promise<AudioCapture> => {
  await openGate;
  return {
    finish: () => {
      finished += 1;
      return { chunks: [new Float32Array(16_000)], sampleRate: 16_000 };
    },
    cancel: () => {
      canceled += 1;
    },
  };
});

const ref = createRef<HTMLTextAreaElement>();

async function render(releaseSignal: number) {
  await act(async () =>
    root.render(
      createElement(
        "div",
        null,
        createElement("textarea", {
          ref,
          defaultValue: "Draft ",
          "aria-label": "Prompt",
        }),
        createElement(VoiceInputButton, {
          textareaRef: ref,
          releaseSignal,
          deps: { supported: true, open, transcribe },
        }),
      ),
    ),
  );
  textarea = ref.current!;
}

const phase = () =>
  container.querySelector<HTMLElement>("[data-voice-input]")?.dataset
    .voiceInput;
const button = () =>
  container.querySelector<HTMLButtonElement>("[data-voice-input] button");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  canceled = 0;
  finished = 0;
  openGate = Promise.resolve();
  transcribe.mockClear();
  open.mockClear();
  // Once per test: setting it resets the status, which hides the button.
  __setVoiceStatusReader(async () => READY);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __setVoiceStatusReader(null);
  vi.unstubAllGlobals();
});

describe("VoiceInputButton releaseSignal", () => {
  it("does nothing on first render or while idle", async () => {
    await render(0);
    await render(1);
    expect(phase()).toBe("idle");
    expect(open).not.toHaveBeenCalled();
  });

  it("stops a recording and keeps the words when the signal changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await render(0);
    await act(async () => button()!.click());
    expect(phase()).toBe("recording");
    // Longer than the shortest recording the recorder keeps.
    vi.setSystemTime(Date.now() + 2_000);
    await render(1);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(phase()).toBe("idle"));
    expect(finished).toBe(1);
    expect(canceled).toBe(0);
    expect(textarea.value).toBe("Draft dictated text");
    vi.useRealTimers();
  });

  it("lets go of a microphone that is still starting", async () => {
    let letOpen!: () => void;
    openGate = new Promise((resolve) => {
      letOpen = resolve;
    });
    await render(0);
    await act(async () => button()!.click());
    expect(phase()).toBe("starting");
    await render(1);
    await act(async () => {
      letOpen();
      await openGate;
      await Promise.resolve();
    });
    // The capture that arrived late is cancelled, never recorded.
    expect(canceled).toBe(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(phase()).toBe("idle");
  });

  it("does not stop a recording when the same signal renders again", async () => {
    await render(3);
    await act(async () => button()!.click());
    await render(3);
    expect(phase()).toBe("recording");
    expect(finished).toBe(0);
  });
});
