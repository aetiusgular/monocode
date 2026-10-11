import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
// The shortcut, and its row in Keybindings, exist on macOS only.
vi.mock("../../../platform/tauri/platform", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../platform/tauri/platform")
  >()),
  IS_MAC: true,
}));

import {
  bytesToBase64,
  parseVoiceStatus,
  transcribeWav,
  type VoiceStatus,
} from "./voiceCommands";
import {
  __setVoiceStatusReader,
  formatBytes,
  manualDownloadCommands,
  modelState,
  refreshVoiceStatus,
  voiceReady,
  voiceStatusSnapshot,
  voiceSupported,
} from "./voiceStatus";
import { testMicrophone } from "./micTest";
import { VOICE_INPUT_COMMAND, voiceShortcutPressed } from "./shortcut";

const STATUS: VoiceStatus = {
  whisperCli: "/opt/homebrew/bin/whisper-cli",
  modelPath:
    "/Users/tony/Library/Application Support/com.monocode.desktop/voice/ggml-base.en.bin",
  modelBytes: 147_964_211,
  expectedModelBytes: 147_964_211,
  modelUrl:
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  modelSha256:
    "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
};

afterEach(() => {
  __setVoiceStatusReader(null);
  invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("voice status", () => {
  it("is ready only with whisper-cli and a model of the expected size", () => {
    expect(voiceReady(STATUS)).toBe(true);
    expect(voiceReady({ ...STATUS, whisperCli: null })).toBe(false);
    expect(voiceReady({ ...STATUS, modelBytes: null })).toBe(false);
    expect(voiceReady({ ...STATUS, modelBytes: 1_000 })).toBe(false);
    expect(voiceReady(null)).toBe(false);
  });

  it("names the model state", () => {
    expect(modelState(STATUS)).toBe("ready");
    expect(modelState({ ...STATUS, modelBytes: null })).toBe("missing");
    expect(modelState({ ...STATUS, modelBytes: 12 })).toBe("wrong-size");
    expect(modelState(null)).toBe("missing");
  });

  it("is a macOS feature", () => {
    expect(voiceSupported(true)).toBe(true);
    expect(voiceSupported(false)).toBe(false);
  });

  it("parses the app's answer and rejects anything else", () => {
    expect(parseVoiceStatus(STATUS)).toEqual(STATUS);
    expect(parseVoiceStatus({ ...STATUS, whisperCli: null })?.whisperCli).toBe(
      null,
    );
    expect(parseVoiceStatus(undefined)).toBeNull();
    expect(parseVoiceStatus({ ...STATUS, modelPath: 4 })).toBeNull();
  });

  it("shares one request and publishes the result", async () => {
    const read = vi.fn(async () => STATUS);
    __setVoiceStatusReader(read);
    expect(voiceStatusSnapshot().checking).toBe(true);
    await Promise.all([refreshVoiceStatus(), refreshVoiceStatus()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(voiceStatusSnapshot()).toEqual({
      status: STATUS,
      checking: false,
      error: null,
    });
  });

  it("reports a failed check", async () => {
    __setVoiceStatusReader(async () => {
      throw new Error("no app");
    });
    await refreshVoiceStatus();
    expect(voiceStatusSnapshot()).toEqual({
      status: null,
      checking: false,
      error: "no app",
    });
    __setVoiceStatusReader(async () => null);
    await refreshVoiceStatus();
    expect(voiceStatusSnapshot().error).toBe(
      "Could not read the voice input status.",
    );
  });

  it("gives copyable commands to fetch and check the model by hand", () => {
    expect(manualDownloadCommands(STATUS)).toEqual([
      "mkdir -p '/Users/tony/Library/Application Support/com.monocode.desktop/voice'",
      "curl -L --fail -o '/Users/tony/Library/Application Support/com.monocode.desktop/voice/ggml-base.en.bin' https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
      "shasum -a 256 '/Users/tony/Library/Application Support/com.monocode.desktop/voice/ggml-base.en.bin'",
    ]);
    expect(
      manualDownloadCommands({ ...STATUS, modelPath: "/a'b/m.bin" })[2],
    ).toBe("shasum -a 256 '/a'\\''b/m.bin'");
  });

  it("formats sizes", () => {
    expect(formatBytes(147_964_211)).toBe("141.1 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});

describe("voice commands", () => {
  it("encodes large WAVs as base64 in chunks", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) =>
      c.charCodeAt(0),
    );
    expect(decoded).toEqual(bytes);
  });

  it("sends the WAV to voice_transcribe and nothing else", async () => {
    invoke.mockResolvedValue("hi");
    await expect(transcribeWav(new Uint8Array([1, 2, 3]))).resolves.toBe("hi");
    expect(invoke).toHaveBeenCalledWith("voice_transcribe", {
      wavBase64: "AQID",
    });
  });
});

describe("voice shortcut", () => {
  const key = (
    overrides: Partial<Parameters<typeof voiceShortcutPressed>[0]>,
  ) => ({
    key: "m",
    code: "KeyM",
    metaKey: true,
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    ...overrides,
  });

  it("is Cmd+Shift+M", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(voiceShortcutPressed(key({}))).toBe(true);
    expect(voiceShortcutPressed(key({ key: "M" }))).toBe(true);
    expect(voiceShortcutPressed(key({ shiftKey: false }))).toBe(false);
    expect(voiceShortcutPressed(key({ altKey: true }))).toBe(false);
    expect(voiceShortcutPressed(key({ key: "n", code: "KeyN" }))).toBe(false);
  });

  it("can be turned off in Keybindings", () => {
    const stored = JSON.stringify({
      [VOICE_INPUT_COMMAND]: { disabled: true },
    });
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(voiceShortcutPressed(key({}))).toBe(false);
  });
});

describe("testMicrophone", () => {
  it("reports the loudest sample and whether it was speech", async () => {
    const cancel = vi.fn();
    const open = vi.fn(async () => ({
      finish: () => ({
        chunks: [new Float32Array([0.01, -0.4]), new Float32Array([0.2])],
        sampleRate: 48_000,
      }),
      cancel,
    }));
    const wait = vi.fn(async () => undefined);
    const result = await testMicrophone(open, 2, wait);
    expect(open).toHaveBeenCalledWith(2);
    expect(wait).toHaveBeenCalledWith(2000);
    expect(result.heard).toBe(true);
    expect(result.peak).toBeCloseTo(0.4);
  });

  it("calls a silent room silent", async () => {
    const result = await testMicrophone(
      async () => ({
        finish: () => ({
          chunks: [new Float32Array([0.001])],
          sampleRate: 48_000,
        }),
        cancel: () => undefined,
      }),
      1,
      async () => undefined,
    );
    expect(result.heard).toBe(false);
  });
});
