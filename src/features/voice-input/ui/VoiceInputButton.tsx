import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Loader, Mic, Square } from "../../../shared/ui/icons";
import { keybindingShortcutLabel } from "../../settings/model/settings";
import {
  caretSnapshot,
  insertAtCaret,
  type CaretSnapshot,
} from "../model/insertAtCaret";
import {
  MAX_RECORDING_MS,
  VoiceRecorder,
  type OpenCapture,
} from "../model/recorder";
import { VOICE_INPUT_COMMAND, voiceShortcutPressed } from "../model/shortcut";
import { transcribeWav } from "../model/voiceCommands";
import {
  useVoiceStatus,
  voiceReady,
  voiceSupported,
} from "../model/voiceStatus";
import { webAudioCapture } from "../model/webAudioCapture";

export type VoiceInputDeps = {
  supported: boolean;
  open: OpenCapture;
  transcribe: (wav: Uint8Array) => Promise<string>;
};

const ERROR_MS = 8000;

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The composer's mic button. Hidden off macOS, and hidden until whisper-cli
 * and the model are both installed (Settings, Voice). Click or ⌘⇧M starts
 * recording; click or ⌘⇧M again stops and transcribes on this Mac; Escape
 * cancels. The text lands at the caret and is not sent.
 */
export function VoiceInputButton({
  textareaRef,
  disabled = false,
  deps,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  /** Tests and browser fixtures pass fakes. */
  deps?: Partial<VoiceInputDeps>;
}) {
  const supported = deps?.supported ?? voiceSupported();
  const { status } = useVoiceStatus(supported);
  if (!supported || !voiceReady(status)) return null;
  return (
    <VoiceInputControl
      textareaRef={textareaRef}
      disabled={disabled}
      open={deps?.open}
      transcribe={deps?.transcribe}
    />
  );
}

function VoiceInputControl({
  textareaRef,
  disabled,
  open,
  transcribe,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  open?: OpenCapture;
  transcribe?: (wav: Uint8Array) => Promise<string>;
}) {
  const caret = useRef<CaretSnapshot | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const recorder = useMemo(
    () =>
      new VoiceRecorder(
        {
          open: open ?? webAudioCapture(),
          transcribe: transcribe ?? transcribeWav,
        },
        (text) => {
          const field = textareaRef.current;
          if (field) insertAtCaret(field, text, caret.current);
          caret.current = null;
        },
      ),
    // One recorder per mounted button; fakes do not change after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => recorder.dispose(), [recorder]);
  const phase = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (phase.kind !== "recording") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [phase.kind]);

  useEffect(() => {
    if (phase.kind !== "error") return;
    const timer = window.setTimeout(() => recorder.dismiss(), ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [phase, recorder]);

  const toggle = () => {
    if (recorder.state.kind === "transcribing") return;
    if (!recorder.active) {
      const field = textareaRef.current;
      caret.current = field ? caretSnapshot(field) : null;
    }
    recorder.toggle();
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        if (!recorder.active) return;
        event.preventDefault();
        event.stopPropagation();
        recorder.cancel();
        caret.current = null;
        textareaRef.current?.focus();
        return;
      }
      if (event.repeat || !voiceShortcutPressed(event)) return;
      // Only the composer being typed in, or the one already recording.
      const focused = document.activeElement;
      const mine =
        recorder.active ||
        (focused != null &&
          (focused === textareaRef.current || focused === button.current));
      if (!mine || (disabled && !recorder.active)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleRef.current();
    };
    // Capture, so Escape cancels the recording before Settings, popovers or
    // the composer act on it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recorder, textareaRef, disabled]);

  const shortcut = keybindingShortcutLabel(VOICE_INPUT_COMMAND, "⌘⇧M");
  const hint = shortcut ? ` (${shortcut})` : "";
  const limit = formatElapsed(MAX_RECORDING_MS);

  let label = "Voice input";
  let title = `Voice input${hint}. Transcribed on this Mac.`;
  let icon = <Mic className="size-3.5" strokeWidth={1.75} />;
  let tone = "text-content/55 hover:bg-content/10 hover:text-content";
  if (phase.kind === "starting") {
    label = "Starting microphone";
    title = "Starting microphone. Esc cancels.";
    icon = <Loader className="size-3.5 animate-spin" />;
  } else if (phase.kind === "recording") {
    label = "Stop and transcribe";
    title = `Stop and transcribe${hint}. Esc cancels. Stops at ${limit}.`;
    icon = <Square className="size-2.5 fill-current" strokeWidth={0} />;
    tone = "bg-red-500/15 text-red-400 hover:bg-red-500/25";
  } else if (phase.kind === "transcribing") {
    label = "Transcribing";
    title = "Transcribing on this Mac. Esc discards.";
    icon = <Loader className="size-3.5 animate-spin" />;
  }
  const busy = phase.kind === "starting" || phase.kind === "transcribing";

  return (
    <div
      className="flex min-w-0 shrink items-center gap-1.5"
      data-voice-input={phase.kind}
    >
      {phase.kind === "error" ? (
        <span
          role="alert"
          title={phase.message}
          className="min-w-0 max-w-64 truncate text-[11px] text-red-400"
        >
          {phase.message}
        </span>
      ) : null}
      {phase.kind === "recording" ? (
        <span
          className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-red-400"
          aria-label={`Recording, ${formatElapsed(now - phase.startedAt)}`}
          role="timer"
        >
          <span
            aria-hidden
            className="size-1.5 animate-pulse rounded-full bg-red-500"
          />
          {formatElapsed(now - phase.startedAt)}
        </span>
      ) : null}
      {phase.kind === "transcribing" ? (
        <span className="shrink-0 text-[11px] text-content/45" role="status">
          Transcribing…
        </span>
      ) : null}
      <button
        ref={button}
        type="button"
        title={title}
        aria-label={label}
        aria-pressed={phase.kind === "recording"}
        aria-busy={busy || undefined}
        disabled={busy || (disabled && !recorder.active)}
        // Keep the caret in the composer, where the text will go.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className={`grid size-6.5 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-default disabled:opacity-60 ${tone}`}
      >
        {icon}
      </button>
    </div>
  );
}
