import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader } from "../../../shared/ui/icons";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { keybindingShortcutLabel } from "../../settings/model/settings";
import { testMicrophone, type MicTestResult } from "../model/micTest";
import { microphoneError, type OpenCapture } from "../model/recorder";
import { VOICE_INPUT_COMMAND } from "../model/shortcut";
import {
  cancelVoiceModelDownload,
  downloadVoiceModel,
  onModelProgress,
  type ModelProgress,
} from "../model/voiceCommands";
import {
  formatBytes,
  manualDownloadCommands,
  modelState,
  refreshVoiceStatus,
  useVoiceStatus,
  voiceReady,
  voiceSupported,
  WHISPER_INSTALL_COMMAND,
} from "../model/voiceStatus";
import { webAudioCapture } from "../model/webAudioCapture";

export type VoiceSettingsDeps = {
  supported: boolean;
  download: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  onProgress: (
    handler: (progress: ModelProgress) => void,
  ) => Promise<() => void>;
  open: OpenCapture;
  micTestSeconds: number;
};

const DEFAULT_DEPS: VoiceSettingsDeps = {
  supported: voiceSupported(),
  download: downloadVoiceModel,
  cancelDownload: cancelVoiceModelDownload,
  onProgress: onModelProgress,
  open: webAudioCapture(),
  micTestSeconds: 2,
};

type Download =
  | { kind: "idle" }
  | { kind: "running"; received: number; total: number }
  | { kind: "failed"; message: string };

type MicTest =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "done"; result: MicTestResult }
  | { kind: "failed"; message: string };

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : "Something went wrong.";
}

/**
 * Settings, Voice: whether whisper-cli is installed, the model download, and
 * a microphone check. Only listed on macOS.
 */
export function VoiceSettings({
  deps: overrides,
}: {
  deps?: Partial<VoiceSettingsDeps>;
}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const { status, checking, error } = useVoiceStatus(deps.supported);
  const [download, setDownload] = useState<Download>({ kind: "idle" });
  const [mic, setMic] = useState<MicTest>({ kind: "idle" });
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  if (!deps.supported) {
    return (
      <p className="text-[13px] text-content/55">
        Voice input works on macOS only.
      </p>
    );
  }

  const startDownload = async () => {
    setDownload({ kind: "running", received: 0, total: 0 });
    let stop: (() => void) | null = null;
    try {
      stop = await deps.onProgress((progress) => {
        if (mounted.current) setDownload({ kind: "running", ...progress });
      });
      await deps.download();
      if (mounted.current) setDownload({ kind: "idle" });
    } catch (failure) {
      if (mounted.current) {
        setDownload({ kind: "failed", message: errorText(failure) });
      }
    } finally {
      stop?.();
      void refreshVoiceStatus();
    }
  };

  const runMicTest = async () => {
    setMic({ kind: "listening" });
    try {
      const result = await testMicrophone(deps.open, deps.micTestSeconds);
      if (mounted.current) setMic({ kind: "done", result });
    } catch (failure) {
      if (mounted.current) {
        setMic({ kind: "failed", message: microphoneError(failure) });
      }
    }
  };

  const model = modelState(status);
  const ready = voiceReady(status);
  const shortcut = keybindingShortcutLabel(VOICE_INPUT_COMMAND, "⌘⇧M");
  const percent =
    download.kind === "running" && download.total > 0
      ? Math.min(100, Math.floor((download.received / download.total) * 100))
      : 0;

  return (
    <div data-voice-settings>
      <p
        role="status"
        className={`mb-6 flex items-center gap-2 text-[13px] ${ready ? "text-content" : "text-content/55"}`}
      >
        {checking && !status ? (
          <>
            <Loader className="size-3.5 animate-spin" />
            Checking…
          </>
        ) : ready ? (
          <>
            <Check className="size-3.5 text-emerald-400" />
            Ready. Use the mic button in the composer
            {shortcut ? ` or ${shortcut}` : ""}.
          </>
        ) : (
          "Install whisper-cli and download the model to show the mic button in the composer."
        )}
      </p>
      {error ? (
        <p role="alert" className="mb-4 text-[12px] text-red-400">
          {error}
        </p>
      ) : null}

      <Card
        title="whisper.cpp"
        description="Speech to text that runs on this Mac. Audio is never sent anywhere."
      >
        <SettingRow
          label="whisper-cli"
          description={
            status?.whisperCli
              ? undefined
              : "Not installed. Install it with Homebrew, then check again."
          }
          detail={
            status?.whisperCli ? (
              <code className="break-all font-mono text-[11px] text-content/55">
                {status.whisperCli}
              </code>
            ) : (
              <Command text={WHISPER_INSTALL_COMMAND} />
            )
          }
        >
          <span
            className={`text-[12px] ${status?.whisperCli ? "text-emerald-400" : "text-content/45"}`}
          >
            {status?.whisperCli ? "Installed" : "Not found"}
          </span>
          <SecondaryButton
            disabled={checking}
            onClick={() => void refreshVoiceStatus()}
          >
            Check again
          </SecondaryButton>
        </SettingRow>
      </Card>

      <Card
        title="Model"
        description="ggml-base.en, English only, from the whisper.cpp repository on Hugging Face. Checked against its published SHA-256 before use."
      >
        <SettingRow
          label="ggml-base.en.bin"
          description={
            model === "ready"
              ? `Downloaded, ${formatBytes(status!.expectedModelBytes)}.`
              : model === "wrong-size"
                ? `The file is ${formatBytes(status!.modelBytes ?? 0)}, not ${formatBytes(status!.expectedModelBytes)}. Download it again.`
                : status
                  ? `Not downloaded. ${formatBytes(status.expectedModelBytes)}.`
                  : undefined
          }
          detail={
            status ? (
              <code className="break-all font-mono text-[11px] text-content/45">
                {status.modelPath}
              </code>
            ) : null
          }
        >
          {download.kind === "running" ? (
            <>
              <span className="text-[12px] tabular-nums text-content/55">
                {download.total ? `${percent}%` : "Starting…"}
              </span>
              <SecondaryButton
                onClick={() => void deps.cancelDownload().catch(() => {})}
              >
                Cancel
              </SecondaryButton>
            </>
          ) : model === "ready" ? (
            <span className="flex items-center gap-1 text-[12px] text-emerald-400">
              <Check className="size-3.5" />
              Downloaded
            </span>
          ) : (
            <SecondaryButton
              disabled={!status}
              onClick={() => void startDownload()}
            >
              {model === "wrong-size" ? "Download again" : "Download model"}
            </SecondaryButton>
          )}
        </SettingRow>
        {download.kind === "running" ? (
          <div className="px-4 pb-3.5">
            <div
              role="progressbar"
              aria-label="Model download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1 overflow-hidden rounded-full bg-content/10"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            {download.total ? (
              <p className="mt-1.5 text-[11px] tabular-nums text-content/45">
                {formatBytes(download.received)} of{" "}
                {formatBytes(download.total)}
              </p>
            ) : null}
          </div>
        ) : null}
        {download.kind === "failed" ? (
          <p role="alert" className="px-4 pb-3.5 text-[12px] text-red-400">
            {download.message}
          </p>
        ) : null}
        {status && model !== "ready" ? (
          <details className="border-t border-content/5 px-4 py-3 text-[12px] text-content/55">
            <summary className="cursor-default select-none">
              Download it yourself
            </summary>
            <div className="mt-2 flex flex-col gap-1.5">
              {manualDownloadCommands(status).map((line) => (
                <Command key={line} text={line} />
              ))}
              <p className="text-[11px] text-content/45">
                The SHA-256 must be{" "}
                <code className="break-all font-mono">
                  {status.modelSha256}
                </code>{" "}
                and the size {status.expectedModelBytes.toLocaleString("en-US")}{" "}
                bytes.
              </p>
            </div>
          </details>
        ) : null}
      </Card>

      <Card title="Microphone">
        <SettingRow
          label="Test microphone"
          description={`Listens for ${deps.micTestSeconds} seconds and says whether it heard anything. The audio is not kept. The first time, macOS asks for microphone access.`}
          detail={<MicTestText state={mic} />}
        >
          <SecondaryButton
            disabled={mic.kind === "listening"}
            onClick={() => void runMicTest()}
          >
            {mic.kind === "listening" ? "Listening…" : "Test microphone"}
          </SecondaryButton>
        </SettingRow>
      </Card>
    </div>
  );
}

function MicTestText({ state }: { state: MicTest }) {
  if (state.kind === "failed") {
    return (
      <span role="alert" className="text-[12px] text-red-400">
        {state.message}
      </span>
    );
  }
  if (state.kind !== "done") return null;
  const level = Math.round(state.result.peak * 100);
  return (
    <span
      role="status"
      className={`text-[12px] ${state.result.heard ? "text-emerald-400" : "text-content/55"}`}
    >
      {state.result.heard
        ? `Heard you. Peak level ${level}%.`
        : "Heard nothing. Check the input device in System Settings, Sound."}
    </span>
  );
}

function Command({ text }: { text: string }) {
  return (
    <code className="block select-all break-all rounded-md bg-content/5 px-2 py-1 font-mono text-[11px] text-content/70">
      {text}
    </code>
  );
}

/** Same look as the cards on the other Settings pages. */
function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="pt-8 first:pt-0">
      <div className="pb-2.5">
        <h2 className="text-[13px] font-semibold text-content">{title}</h2>
        {description ? (
          <p className="mt-1 text-[12px] leading-relaxed text-content/45">
            {description}
          </p>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3">
        {children}
      </div>
    </section>
  );
}

function SettingRow({
  label,
  description,
  detail,
  children,
}: {
  label: string;
  description?: string;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-6 border-b border-content/5 px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-[13px] font-medium text-content">{label}</div>
        {description ? (
          <p className="text-[12px] leading-relaxed text-content/45">
            {description}
          </p>
        ) : null}
        {detail}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}
