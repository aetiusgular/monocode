// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
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

import { VoiceSettings, type VoiceSettingsDeps } from "./VoiceSettings";
import { __setVoiceStatusReader } from "../model/voiceStatus";
import type { ModelProgress, VoiceStatus } from "../model/voiceCommands";

const STATUS: VoiceStatus = {
  whisperCli: null,
  modelPath: "/data/voice/ggml-base.en.bin",
  modelBytes: null,
  expectedModelBytes: 147_964_211,
  modelUrl:
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  modelSha256:
    "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
};

let container: HTMLDivElement;
let root: Root;
let status: VoiceStatus | null;

async function render(deps: Partial<VoiceSettingsDeps> = {}) {
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(VoiceSettings, {
          deps: { supported: true, micTestSeconds: 1, ...deps },
        }),
      ),
    ),
  );
}

const text = () => container.textContent ?? "";
const buttonNamed = (name: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  status = { ...STATUS };
  __setVoiceStatusReader(async () => status);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __setVoiceStatusReader(null);
  vi.unstubAllGlobals();
});

// 0.14: after the model download the row stayed on "Starting… Cancel" while
// the page said Ready. The app renders under StrictMode, whose extra
// unmount left the component's "mounted" flag false for good.
describe("VoiceSettings under StrictMode", () => {
  it("shows progress and settles on Downloaded when the download ends", async () => {
    let report!: (progress: ModelProgress) => void;
    let finish!: () => void;
    whisperReady();
    await render({
      download: () => new Promise<void>((resolve) => (finish = resolve)),
      onProgress: async (handler) => {
        report = handler;
        return () => {};
      },
    });
    await act(async () => buttonNamed("Download model")!.click());
    expect(text()).toContain("Starting…");
    await act(async () => report({ received: 50, total: 100 }));
    expect(text()).toContain("50%");
    status = { ...status!, modelBytes: STATUS.expectedModelBytes };
    await act(async () => finish());
    expect(text()).toContain("Ready.");
    expect(text()).not.toContain("Starting…");
    expect(buttonNamed("Cancel")).toBeUndefined();
    expect(text()).toContain("Downloaded");
  });

  it("leaves the running state when the download fails", async () => {
    await render({
      download: async () => {
        throw new Error("SHA-256 mismatch");
      },
      onProgress: async () => () => {},
    });
    await act(async () => buttonNamed("Download model")!.click());
    expect(text()).toContain("SHA-256 mismatch");
    expect(buttonNamed("Cancel")).toBeUndefined();
  });
});

function whisperReady() {
  status = { ...STATUS, whisperCli: "/opt/homebrew/bin/whisper-cli" };
}
