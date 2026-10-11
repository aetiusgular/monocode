import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** What `voice_status` in `src-tauri/src/voice_input.rs` reports. */
export type VoiceStatus = {
  /** The whisper-cli that would run, or null when it is not installed. */
  whisperCli: string | null;
  modelPath: string;
  /** Size of the model file on disk, or null when there is none. */
  modelBytes: number | null;
  expectedModelBytes: number;
  modelUrl: string;
  modelSha256: string;
};

export type ModelProgress = { received: number; total: number };

const PROGRESS_EVENT = "monocode:voice-model-progress";

/** Null when the answer is not a status, for example outside the app. */
export function parseVoiceStatus(value: unknown): VoiceStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string) : null;
  const count = (key: string) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key])
      ? (raw[key] as number)
      : null;
  const modelPath = text("modelPath");
  const expectedModelBytes = count("expectedModelBytes");
  const modelUrl = text("modelUrl");
  const modelSha256 = text("modelSha256");
  if (!modelPath || !expectedModelBytes || !modelUrl || !modelSha256) {
    return null;
  }
  return {
    whisperCli: text("whisperCli"),
    modelPath,
    modelBytes: count("modelBytes"),
    expectedModelBytes,
    modelUrl,
    modelSha256,
  };
}

export async function readVoiceStatus(): Promise<VoiceStatus | null> {
  return parseVoiceStatus(await invoke<unknown>("voice_status"));
}

/** Runs whisper-cli on this machine. The audio is not sent anywhere. */
export function transcribeWav(wav: Uint8Array): Promise<string> {
  return invoke<string>("voice_transcribe", { wavBase64: bytesToBase64(wav) });
}

export function downloadVoiceModel(): Promise<void> {
  return invoke<void>("voice_download_model");
}

export function cancelVoiceModelDownload(): Promise<void> {
  return invoke<void>("voice_cancel_download");
}

export function onModelProgress(
  handler: (progress: ModelProgress) => void,
): Promise<UnlistenFn> {
  return listen<ModelProgress>(PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
}

/** Base64 without building one huge argument list for String.fromCharCode. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
