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

import { formatElapsed, VoiceInputButton } from "./VoiceInputButton";
import { __setVoiceStatusReader } from "../model/voiceStatus";
import type { VoiceStatus } from "../model/voiceCommands";
import type { AudioCapture } from "../model/recorder";

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
const transcribe = vi.fn(async (_wav: Uint8Array) => "dictated text");
const open = vi.fn(async (): Promise<AudioCapture> => ({
  finish: () => ({
    chunks: [new Float32Array(16_000)],
    sampleRate: 16_000,
  }),
  cancel: () => {
    canceled += 1;
  },
}));

async function render(
  status: VoiceStatus | null,
  props: { supported?: boolean; disabled?: boolean } = {},
) {
  __setVoiceStatusReader(async () => status);
  const ref = createRef<HTMLTextAreaElement>();
  await act(async () =>
    root.render(
      createElement(
        "div",
        null,
        createElement("textarea", {
          ref,
          defaultValue: "Fix ",
          "aria-label": "Message",
        }),
        createElement(VoiceInputButton, {
          textareaRef: ref,
          disabled: props.disabled,
          deps: { supported: props.supported ?? true, open, transcribe },
        }),
      ),
    ),
  );
  textarea = ref.current!;
}

const button = () =>
  container.querySelector<HTMLButtonElement>("[data-voice-input] button");
const phase = () =>
  container.querySelector<HTMLElement>("[data-voice-input]")?.dataset
    .voiceInput;

async function click() {
  await act(async () => button()!.click());
}

async function press(init: KeyboardEventInit) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, ...init }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  canceled = 0;
  transcribe.mockClear();
  open.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __setVoiceStatusReader(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("VoiceInputButton", () => {
  it("is hidden until whisper-cli and the model are both present", async () => {
    await render({ ...READY, whisperCli: null });
    expect(button()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ ...READY, modelBytes: null });
    expect(button()).toBeNull();
  });

  it("is hidden off macOS and never asks the app there", async () => {
    const read = vi.fn(async () => READY);
    __setVoiceStatusReader(read);
    const ref = createRef<HTMLTextAreaElement>();
    await act(async () =>
      root.render(
        createElement(VoiceInputButton, {
          textareaRef: ref,
          deps: { supported: false },
        }),
      ),
    );
    expect(button()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("records, shows elapsed time, transcribes and inserts at the caret", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await render(READY);
    expect(button()!.getAttribute("aria-label")).toBe("Voice input");
    textarea.focus();
    textarea.setSelectionRange(4, 4);
    await click();
    expect(phase()).toBe("recording");
    expect(button()!.getAttribute("aria-label")).toBe("Stop and transcribe");
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(container.querySelector('[role="timer"]')?.textContent).toBe("0:03");
    await click();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(phase()).toBe("idle"));
    expect(textarea.value).toBe("Fix dictated text");
  });

  it("shows a spinner while transcribing", async () => {
    let finish!: (text: string) => void;
    transcribe.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    await render(READY);
    await click();
    vi.setSystemTime(Date.now() + 1_000);
    await click();
    expect(phase()).toBe("transcribing");
    expect(button()!.disabled).toBe(true);
    expect(button()!.getAttribute("aria-label")).toBe("Transcribing");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    await act(async () => finish("ok"));
    expect(phase()).toBe("idle");
  });

  it("Escape cancels a recording without transcribing", async () => {
    await render(READY);
    await click();
    expect(phase()).toBe("recording");
    await press({ key: "Escape" });
    expect(phase()).toBe("idle");
    expect(canceled).toBe(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Fix ");
  });

  it("Cmd+Shift+M starts and stops from the focused composer only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await render(READY);
    const shortcut = {
      key: "m",
      code: "KeyM",
      metaKey: true,
      shiftKey: true,
    };
    // Focus elsewhere: another composer's shortcut, not this one's.
    await press(shortcut);
    expect(phase()).toBe("idle");
    textarea.focus();
    await press(shortcut);
    expect(phase()).toBe("recording");
    vi.setSystemTime(Date.now() + 1_000);
    await press(shortcut);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  });

  it("shows why it failed, then clears", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    open.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    await render(READY);
    await click();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Microphone access is off",
    );
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(phase()).toBe("idle");
  });

  it("is disabled with the composer", async () => {
    await render(READY, { disabled: true });
    expect(button()!.disabled).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("reads as minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_400)).toBe("1:05");
    expect(formatElapsed(300_000)).toBe("5:00");
  });
});
