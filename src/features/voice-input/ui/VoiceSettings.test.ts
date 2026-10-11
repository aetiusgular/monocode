// @vitest-environment happy-dom
import { act, createElement } from "react";
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
      createElement(VoiceSettings, {
        deps: { supported: true, micTestSeconds: 1, ...deps },
      }),
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

describe("VoiceSettings", () => {
  it("shows what is missing and how to install it", async () => {
    await render();
    expect(text()).toContain(
      "Install whisper-cli and download the model to show the mic button in the composer.",
    );
    expect(text()).toContain("Not found");
    expect(text()).toContain("brew install whisper-cpp");
    expect(text()).toContain("Not downloaded. 141.1 MB.");
    expect(text()).toContain("/data/voice/ggml-base.en.bin");
    expect(buttonNamed("Download model")).toBeDefined();
    // The manual route: the exact commands, the hash and the size.
    expect(text()).toContain(
      "curl -L --fail -o '/data/voice/ggml-base.en.bin' https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    );
    expect(text()).toContain(STATUS.modelSha256);
    expect(text()).toContain("147,964,211 bytes");
  });

  it("reads ready when both are installed", async () => {
    status = {
      ...STATUS,
      whisperCli: "/opt/homebrew/bin/whisper-cli",
      modelBytes: STATUS.expectedModelBytes,
    };
    await render();
    expect(text()).toContain("Ready. Use the mic button in the composer");
    expect(text()).toContain("/opt/homebrew/bin/whisper-cli");
    expect(text()).toContain("Installed");
    expect(text()).toContain("Downloaded, 141.1 MB.");
    expect(buttonNamed("Download model")).toBeUndefined();
    expect(text()).not.toContain("Download it yourself");
  });

  it("offers to download again when the file is the wrong size", async () => {
    status = { ...STATUS, modelBytes: 1_048_576 };
    await render();
    expect(text()).toContain("The file is 1.0 MB, not 141.1 MB.");
    expect(buttonNamed("Download again")).toBeDefined();
  });

  it("finds whisper-cli after Check again", async () => {
    await render();
    status = { ...STATUS, whisperCli: "/usr/local/bin/whisper-cli" };
    await act(async () => buttonNamed("Check again")!.click());
    expect(text()).toContain("/usr/local/bin/whisper-cli");
  });

  it("downloads with progress, can cancel, and checks the status after", async () => {
    let report!: (progress: ModelProgress) => void;
    let finish!: () => void;
    const stopListening = vi.fn();
    const download = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const cancelDownload = vi.fn(async () => undefined);
    await render({
      download,
      cancelDownload,
      onProgress: async (handler) => {
        report = handler;
        return stopListening;
      },
    });
    await act(async () => buttonNamed("Download model")!.click());
    expect(download).toHaveBeenCalled();
    await act(async () => report({ received: 73_982_105, total: 147_964_211 }));
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("49");
    expect(text()).toContain("70.6 MB of 141.1 MB");
    await act(async () => buttonNamed("Cancel")!.click());
    expect(cancelDownload).toHaveBeenCalled();
    status = { ...STATUS, modelBytes: STATUS.expectedModelBytes };
    await act(async () => finish());
    expect(stopListening).toHaveBeenCalled();
    expect(text()).toContain("Downloaded, 141.1 MB.");
  });

  it("shows a failed download, such as a hash mismatch", async () => {
    await render({
      download: async () => {
        throw "Downloaded model does not match its published SHA-256.";
      },
      onProgress: async () => () => {},
    });
    await act(async () => buttonNamed("Download model")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Downloaded model does not match its published SHA-256.",
    );
  });

  it("tests the microphone without keeping audio", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const cancel = vi.fn();
    const open = vi.fn(async () => ({
      finish: () => ({
        chunks: [new Float32Array([0.5])],
        sampleRate: 48_000,
      }),
      cancel,
    }));
    await render({ open });
    await act(async () => buttonNamed("Test microphone")!.click());
    expect(buttonNamed("Listening…")?.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(text()).toContain("Heard you. Peak level 50%.");
    vi.useRealTimers();
  });

  it("says so off macOS", async () => {
    await render({ supported: false });
    expect(text()).toBe("Voice input works on macOS only.");
  });
});
