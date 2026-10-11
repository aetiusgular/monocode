import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { VoiceInputButton } from "../../src/features/voice-input/ui/VoiceInputButton";
import { VoiceSettings } from "../../src/features/voice-input/ui/VoiceSettings";
import type { AudioCapture } from "../../src/features/voice-input/model/recorder";
import type { ModelProgress } from "../../src/features/voice-input/model/voiceCommands";
import "../../src/styles/index.css";

const PARAMS = new URLSearchParams(location.search);
/** `?setup=missing`: whisper-cli and the model are not installed. */
const MISSING = PARAMS.get("setup") === "missing";
/** `?page=settings`: Settings, Voice instead of the composer. */
const SETTINGS = PARAMS.get("page") === "settings";

localStorage.clear();

type Probe = {
  /** Byte length of each WAV sent to voice_transcribe. */
  transcribed: number[];
  /** Resolves the transcription that is waiting. */
  finishTranscription: ((text: string) => void) | null;
  opened: number;
  canceled: number;
  reportProgress: ((progress: ModelProgress) => void) | null;
  finishDownload: (() => void) | null;
};
const probe: Probe = {
  transcribed: [],
  finishTranscription: null,
  opened: 0,
  canceled: 0,
  reportProgress: null,
  finishDownload: null,
};
(window as unknown as { __voice: Probe }).__voice = probe;

let modelBytes: number | null = MISSING ? null : 147_964_211;

/** The app's two voice commands, answered in memory. */
(
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
).__TAURI_INTERNALS__ = {
  invoke: async (command, args) => {
    if (command === "voice_status") {
      return {
        whisperCli: MISSING ? null : "/opt/homebrew/bin/whisper-cli",
        modelPath:
          "/Users/tony/Library/Application Support/com.monocode.desktop/voice/ggml-base.en.bin",
        modelBytes,
        expectedModelBytes: 147_964_211,
        modelUrl:
          "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
        modelSha256:
          "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
      };
    }
    if (command === "voice_transcribe") {
      probe.transcribed.push(atob(String(args?.wavBase64)).length);
      return new Promise<string>((resolve) => {
        probe.finishTranscription = resolve;
      });
    }
    throw new Error(`The fixture has no ${command}.`);
  },
};

/** A fake microphone: a quiet tone at 48 kHz for however long it is open. */
async function open(): Promise<AudioCapture> {
  probe.opened += 1;
  const started = performance.now();
  return {
    finish: () => {
      const seconds = (performance.now() - started) / 1000;
      const samples = new Float32Array(Math.round(seconds * 48_000)).fill(0.1);
      return { chunks: [samples], sampleRate: 48_000 };
    },
    cancel: () => {
      probe.canceled += 1;
    },
  };
}

function ComposerFixture() {
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="flex h-full items-end bg-background-base p-6">
      <div className="agent-chat-composer w-full max-w-3xl rounded-xl border border-content/10 bg-content/3">
        <textarea
          ref={field}
          aria-label="Message"
          rows={2}
          defaultValue="Fix "
          className="w-full resize-none bg-transparent px-3 py-3 text-sm outline-none"
        />
        <div className="flex items-center gap-2 px-2 pb-2" data-toolbar>
          <div className="flex-1" />
          <div className="flex shrink-0 items-center gap-1">
            <VoiceInputButton
              textareaRef={field}
              deps={{ supported: true, open }}
            />
            <button
              type="button"
              aria-label="Send"
              className="composer-send primary-action grid size-6.5 place-items-center rounded-md"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsFixture() {
  return (
    <div className="@container/settings h-full overflow-y-auto bg-background-base">
      <div className="mx-auto w-full max-w-5xl px-5 py-6 @min-[560px]/settings:px-8 @min-[560px]/settings:py-8">
        <VoiceSettings
          deps={{
            supported: true,
            open,
            micTestSeconds: 1,
            onProgress: async (handler) => {
              probe.reportProgress = handler;
              return () => {
                probe.reportProgress = null;
              };
            },
            download: () =>
              new Promise<void>((resolve) => {
                probe.finishDownload = () => {
                  modelBytes = 147_964_211;
                  resolve();
                };
              }),
            cancelDownload: async () => undefined,
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  SETTINGS ? <SettingsFixture /> : <ComposerFixture />,
);
