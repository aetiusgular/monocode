import {
  ChevronDown,
  Lock,
  Pencil,
  Shield,
  Sparkles,
} from "../../../shared/ui/icons";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  RUNTIME_MODE_HINT,
  RUNTIME_MODE_LABEL,
  RUNTIME_MODES,
  type RuntimeMode,
} from "../model/session";
import { Popover } from "../../../shared/ui/Popover";

type Props = {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  onClose?: () => void;
  busy?: boolean;
  side?: "top" | "bottom";
  variant?: "pill" | "plain";
  /**
   * Auto hands approvals to Codex's auto-review, tested only on OpenAI
   * models. Hidden when the chat runs on another provider.
   */
  hideAuto?: boolean;
  /** The harness runs commands with your full rights: no sandbox. */
  unsandboxed?: boolean;
  /** Codex permissions profile for this chat, and how to change it. */
  profile?: string;
  onProfileChange?: (profile: string) => void;
};

const MENU_WIDTH = 288;

const ICONS: Record<RuntimeMode, typeof Lock> = {
  supervised: Lock,
  "auto-accept-edits": Pencil,
  auto: Sparkles,
  "full-access": Shield,
};

export function AccessPicker({
  value,
  onChange,
  onClose,
  busy = false,
  side = "top",
  variant = "pill",
  hideAuto = false,
  unsandboxed = false,
  profile,
  onProfileChange,
}: Props) {
  // A chat already in Auto keeps the row, so its state stays visible.
  const modes = RUNTIME_MODES.filter(
    (mode) => !(hideAuto && mode === "auto" && value !== "auto"),
  );
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, modes.indexOf(value)));
  // Only what is typed. A set profile shows on its own row with Clear.
  const [profileDraft, setProfileDraft] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const Icon = ICONS[value];

  const dismiss = (restore: boolean) => {
    setOpen(false);
    if (restore) onCloseRef.current?.();
  };

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, modes.indexOf(value)));
    setProfileDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value, profile]);

  const pick = (mode: RuntimeMode) => {
    onChange(mode);
    dismiss(true);
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(modes.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const mode = modes[active];
      if (mode) pick(mode);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-access-picker-trigger
        title={`${RUNTIME_MODE_HINT[value]}${unsandboxed ? " This agent has no sandbox: commands run with your full rights." : ""}${profile ? ` Codex profile ${profile}.` : ""}${busy ? " Changes apply to the next turn." : ""}`}
        data-unsandboxed={unsandboxed || undefined}
        aria-label={RUNTIME_MODE_LABEL[value]}
        aria-expanded={open}
        aria-haspopup="listbox"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) {
            dismiss(true);
            return;
          }
          setOpen(true);
        }}
        className={
          variant === "plain"
            ? `-mx-1.5 flex h-7 max-w-52 items-center gap-2 rounded-md px-1.5 text-[12px] text-content/85 ${
                open ? "bg-content/8" : "hover:bg-content/6"
              }`
            : `flex h-6.5 max-w-52 items-center gap-1 rounded-md px-1.5 ${
                open
                  ? "bg-selection text-content"
                  : "bg-selection text-content hover:bg-selection-hover"
              }`
        }
      >
        <Icon
          className={`size-3.5 shrink-0 ${value === "full-access" ? "text-amber-400/90" : ""}`}
          strokeWidth={1.75}
        />
        <span
          className={`min-w-0 truncate ${variant === "plain" ? "" : "text-[11px]"}`}
        >
          {RUNTIME_MODE_LABEL[value]}
        </span>
        {unsandboxed ? (
          <span
            aria-label="No sandbox"
            className="size-1.5 shrink-0 rounded-full bg-amber-500"
          />
        ) : null}
        <ChevronDown
          className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <Popover
          anchor={root}
          side={side}
          width={MENU_WIDTH}
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          role="listbox"
          aria-label="Access"
          data-access-picker
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="p-1"
        >
          {modes.map((mode, index) => {
            const ModeIcon = ICONS[mode];
            const selected = mode === value;
            const highlighted = index === active;
            return (
              <button
                key={mode}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(mode)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left ${
                  highlighted || selected
                    ? "bg-selection text-content"
                    : "text-content hover:bg-content/5"
                }`}
              >
                <ModeIcon
                  className={`mt-0.5 size-3.5 shrink-0 ${mode === "full-access" ? "text-amber-400/90" : "text-content/70"}`}
                  strokeWidth={1.75}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium leading-5">
                    {RUNTIME_MODE_LABEL[mode]}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-content/50">
                    {RUNTIME_MODE_HINT[mode]}
                  </span>
                </span>
              </button>
            );
          })}
          {hideAuto ? (
            <p className="px-2 py-1.5 text-[11px] leading-4 text-content/50">
              {value === "auto"
                ? "Auto runs as Auto-accept edits on this provider. Auto-review is tested on OpenAI models only."
                : "Auto is hidden on this provider. Auto-review is tested on OpenAI models only."}
            </p>
          ) : null}
          {unsandboxed ? (
            <p
              className="px-2 py-1.5 text-[11px] leading-4 text-amber-500"
              data-unsandboxed-note
            >
              No sandbox. This agent runs commands with your full rights in
              every mode. Only Codex sessions are sandboxed.
            </p>
          ) : null}
          {onProfileChange && profile ? (
            <div
              className="flex items-center gap-1.5 px-2 py-1.5"
              data-access-profile={profile}
            >
              <span className="min-w-0 flex-1 truncate text-[11px] text-content/70">
                Profile{" "}
                <span className="font-mono text-content">{profile}</span>
              </span>
              <button
                type="button"
                data-access-profile-clear
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onProfileChange("");
                  dismiss(true);
                }}
                className="h-6.5 shrink-0 rounded-md px-1.5 text-[11px] text-content/70 hover:bg-content/8"
              >
                Clear
              </button>
            </div>
          ) : null}
          {onProfileChange && profile && value === "full-access" ? (
            <p
              className="px-2 py-1.5 text-[11px] leading-4 text-amber-500"
              data-access-profile-ignored
            >
              Full access ignores the profile {profile}.
            </p>
          ) : null}
          {onProfileChange ? (
            <form
              className="flex items-center gap-1.5 px-2 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                const next = profileDraft.trim();
                if (!next) return;
                onProfileChange(next);
                dismiss(true);
              }}
            >
              <input
                aria-label="Codex permissions profile"
                placeholder={
                  profile ? "Another profile" : "Permissions profile"
                }
                value={profileDraft}
                onChange={(event) => setProfileDraft(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                className="h-6.5 min-w-0 flex-1 rounded-md border border-content/10 bg-transparent px-1.5 text-[11px] text-content"
              />
              <button
                type="submit"
                data-access-profile-use
                disabled={!profileDraft.trim()}
                className="h-6.5 shrink-0 rounded-md px-1.5 text-[11px] text-content/70 hover:bg-content/8 disabled:opacity-40"
              >
                Use
              </button>
            </form>
          ) : null}
          {onProfileChange ? (
            <p className="px-2 pb-1.5 text-[11px] leading-4 text-content/45">
              A named profile from this Codex home's config. It replaces the
              mode's sandbox, extra folders included. Plan turns stay read only.
            </p>
          ) : null}
          {busy ? (
            <p className="px-2 py-1.5 text-[11px] leading-4 text-content/50">
              Access changes apply to the next turn. Stop and resend to apply
              them now.
            </p>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}
