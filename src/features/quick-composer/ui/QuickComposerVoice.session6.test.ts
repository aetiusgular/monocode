// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// 3.19: no mic in quick entry on the Mac, and quick entry opened on Cursor,
// which is not installed. The panel is a separate webview built ahead of
// time, so its voice status was read once, before the model was downloaded.

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  canceled: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      tauri.handlers.set(name, handler);
      return () => {};
    },
  ),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async () => () => {},
    startDragging: async () => {},
  }),
}));
vi.mock("../../../platform/tauri/platform", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../platform/tauri/platform")
  >()),
  IS_MAC: true,
}));
vi.mock("../../voice-input/model/webAudioCapture", () => ({
  webAudioCapture: () => async () => ({
    finish: () => ({ chunks: [new Float32Array(16_000)], sampleRate: 16_000 }),
    cancel: () => {
      tauri.canceled += 1;
    },
  }),
}));
vi.mock("../../voice-input/model/voiceCommands", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  transcribeWav: async () => "dictated words",
}));
vi.mock("./useQuickPickerMotion", () => ({ useQuickPickerMotion: () => {} }));
vi.mock("./QuickWorkspaceControls", () => ({
  QuickWorkspaceControls: () => null,
}));
vi.mock("./QuickProjectIcon", () => ({
  QuickProjectIcon: () => null,
  loadQuickProjectAppearance: () => ({}),
}));
vi.mock("./QuickModelSelector", () => ({ QuickModelSelector: () => null }));
vi.mock("./useQuickAttachments", () => ({
  useQuickAttachments: () => ({ files: [], clear: () => {} }),
}));
vi.mock("../model/quickComposer", async (actual) => ({
  ...(await actual<object>()),
  loadQuickProjects: () => ["/tmp/project"],
}));

import { QuickComposer } from "./QuickComposer";
import { __setVoiceStatusReader } from "../../voice-input/model/voiceStatus";
import type { VoiceStatus } from "../../voice-input/model/voiceCommands";
import {
  QUICK_COMPOSER_CATALOG_EVENT,
  QUICK_COMPOSER_SHOWN_EVENT,
} from "../model/quickComposer";

const MISSING: VoiceStatus = {
  whisperCli: "/opt/homebrew/bin/whisper-cli",
  modelPath: "/data/voice/ggml-base.en.bin",
  modelBytes: null,
  expectedModelBytes: 10,
  modelUrl: "https://example.invalid/model.bin",
  modelSha256: "0".repeat(64),
};
const READY: VoiceStatus = { ...MISSING, modelBytes: 10 };

let root: Root;
let container: HTMLDivElement;
let status: VoiceStatus;

const mic = () =>
  container.querySelector<HTMLButtonElement>("[data-voice-input] button");
const phase = () =>
  container.querySelector<HTMLElement>("[data-voice-input]")?.dataset
    .voiceInput;
const prompt = () => container.querySelector("textarea")!;

async function key(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

async function mount() {
  await act(async () =>
    root.render(createElement(QuickComposer, { onShown: () => {} })),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 0;
  });
  localStorage.clear();
  tauri.handlers.clear();
  tauri.canceled = 0;
  status = READY;
  __setVoiceStatusReader(async () => status);
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __setVoiceStatusReader(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("quick entry dictation (3.19)", () => {
  it("shows the mic after the permissions picker once Voice is ready", async () => {
    await mount();
    const button = mic();
    expect(button).not.toBeNull();
    const permissions = container.querySelector('button[title="Permissions"]');
    expect(permissions).not.toBeNull();
    expect(
      permissions!.compareDocumentPosition(button!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("asks for the voice status again each time the panel shows", async () => {
    status = MISSING;
    await mount();
    expect(mic()).toBeNull();
    // The model is downloaded in Settings while the panel stays built.
    status = READY;
    await act(async () =>
      tauri.handlers.get(QUICK_COMPOSER_SHOWN_EVENT)!({ payload: null }),
    );
    await vi.waitFor(() => expect(mic()).not.toBeNull());
  });

  it("Cmd+Shift+M records into the draft and never sends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await mount();
    const field = prompt();
    field.focus();
    const shortcut = { key: "m", code: "KeyM", metaKey: true, shiftKey: true };
    await key(field, shortcut);
    await vi.waitFor(() => expect(phase()).toBe("recording"));
    vi.setSystemTime(Date.now() + 1_000);
    await key(field, shortcut);
    await vi.waitFor(() => expect(prompt().value).toBe("dictated words"));
    expect(invoke).not.toHaveBeenCalledWith(
      "quick_composer_submit",
      expect.anything(),
    );
  });

  it("first Escape cancels the recording, the second closes the panel", async () => {
    await mount();
    await act(async () => mic()!.click());
    await vi.waitFor(() => expect(phase()).toBe("recording"));
    await key(prompt(), { key: "Escape" });
    expect(phase()).toBe("idle");
    expect(tauri.canceled).toBe(1);
    expect(invoke).not.toHaveBeenCalledWith("quick_composer_dismiss");
    await key(prompt(), { key: "Escape" });
    expect(invoke).toHaveBeenCalledWith("quick_composer_dismiss");
  });

  it("lets go of the microphone when the panel loses focus", async () => {
    await mount();
    await act(async () => mic()!.click());
    await vi.waitFor(() => expect(phase()).toBe("recording"));
    await act(async () => window.dispatchEvent(new Event("blur")));
    // Released: a very short take is dropped, a longer one transcribed.
    await vi.waitFor(() => expect(phase()).not.toBe("recording"));
  });
});

describe("quick entry default provider (3.19)", () => {
  it("moves off a provider whose CLI is not found once the catalog arrives", async () => {
    // Nothing saved, so the stored default is Cursor.
    await mount();
    const modelButton = () =>
      container.querySelector('button[title="Model (⌘.)"]')!.textContent;
    expect(modelButton()).toMatch(/Composer/);
    await act(async () =>
      tauri.handlers.get(QUICK_COMPOSER_CATALOG_EVENT)!({
        payload: { models: {}, availableHarnesses: ["claude", "codex"] },
      }),
    );
    expect(modelButton()).not.toMatch(/Composer/);
    expect(modelButton()).not.toBe("");
  });
});
