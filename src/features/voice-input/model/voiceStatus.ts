import { useEffect, useSyncExternalStore } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { readVoiceStatus, type VoiceStatus } from "./voiceCommands";

export type VoiceStatusSnapshot = {
  status: VoiceStatus | null;
  /** True until the first answer arrives, and while checking again. */
  checking: boolean;
  error: string | null;
};

/** whisper.cpp's Homebrew formula. It installs the `whisper-cli` binary. */
export const WHISPER_INSTALL_COMMAND = "brew install whisper-cpp";

/** Voice input is built for macOS: whisper-cli from Homebrew, WKWebView. */
export function voiceSupported(isMac: boolean = IS_MAC): boolean {
  return isMac;
}

export function modelReady(status: VoiceStatus | null): boolean {
  return !!status && status.modelBytes === status.expectedModelBytes;
}

/** Both pieces are in place: the composer shows its mic button. */
export function voiceReady(status: VoiceStatus | null): boolean {
  return !!status?.whisperCli && modelReady(status);
}

export type ModelState = "missing" | "ready" | "wrong-size";

export function modelState(status: VoiceStatus | null): ModelState {
  if (!status || status.modelBytes == null) return "missing";
  return modelReady(status) ? "ready" : "wrong-size";
}

/** What to run by hand to fetch and check the model without the app. */
export function manualDownloadCommands(status: VoiceStatus): string[] {
  const path = shellQuote(status.modelPath);
  const dir = shellQuote(status.modelPath.replace(/\/[^/]*$/, ""));
  return [
    `mkdir -p ${dir}`,
    `curl -L --fail -o ${path} ${status.modelUrl}`,
    `shasum -a 256 ${path}`,
  ];
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Reader = () => Promise<VoiceStatus | null>;

let reader: Reader = readVoiceStatus;
let snapshot: VoiceStatusSnapshot = {
  status: null,
  checking: true,
  error: null,
};
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: VoiceStatusSnapshot) {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** Ask the app again. Concurrent calls share one request. */
export function refreshVoiceStatus(): Promise<void> {
  if (inFlight) return inFlight;
  loaded = true;
  if (!snapshot.checking) publish({ ...snapshot, checking: true });
  inFlight = reader()
    .then(
      (status) =>
        publish({
          status,
          checking: false,
          error: status ? null : "Could not read the voice input status.",
        }),
      (error: unknown) =>
        publish({
          status: null,
          checking: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    )
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function voiceStatusSnapshot(): VoiceStatusSnapshot {
  return snapshot;
}

export function subscribeVoiceStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The shared status. The first component to mount asks the app; later ones
 * reuse the answer until something calls `refreshVoiceStatus`. Off macOS the
 * app is never asked.
 */
export function useVoiceStatus(supported: boolean): VoiceStatusSnapshot {
  const current = useSyncExternalStore(
    subscribeVoiceStatus,
    voiceStatusSnapshot,
    voiceStatusSnapshot,
  );
  useEffect(() => {
    if (supported && !loaded) void refreshVoiceStatus();
  }, [supported]);
  return current;
}

/** Tests and browser fixtures replace the app call. */
export function __setVoiceStatusReader(next: Reader | null) {
  reader = next ?? readVoiceStatus;
  loaded = false;
  inFlight = null;
  snapshot = { status: null, checking: true, error: null };
}
