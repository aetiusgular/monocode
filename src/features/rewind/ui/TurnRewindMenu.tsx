import { useRef, useState, type ReactNode } from "react";
import { Popover } from "../../../shared/ui/Popover";
import { GitBranch, RotateCcw, Undo2 } from "../../../shared/ui/icons";
import {
  previewRestoreSessionTurn,
  restoreSessionTurn,
  type RestorePreview,
  type RestoreResult,
} from "../../sessions/model/checkpoint";
import type { RewindAction, RewindOptions } from "../model/rewind";
import type { TurnRewind } from "../model/turnRewind";

/** Files listed in the restore preview before it says how many it left out. */
export const MAX_PREVIEW_FILES = 40;

type Stage =
  | { kind: "menu" }
  | { kind: "confirmChat" }
  | { kind: "loadingFiles" }
  | { kind: "files"; preview: RestorePreview }
  | { kind: "working"; action: RewindAction }
  | { kind: "restored"; result: RestoreResult }
  | { kind: "error"; message: string };

const ACTION_LABEL: Record<RewindAction, string> = {
  chat: "Rewind chat to here",
  files: "Restore files to before this turn",
  fork: "Fork from here",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Failed");
}

/**
 * The prompt's rewind menu: three separate actions, each off with its reason
 * when it cannot run. Restoring files shows what will change and asks first.
 */
export function TurnRewindMenu({
  rewind,
  blockId,
}: {
  rewind: TurnRewind;
  blockId: string;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "menu" });
  const [options, setOptions] = useState<RewindOptions | null>(null);

  const close = () => {
    setOpen(false);
    setStage({ kind: "menu" });
  };

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOptions(rewind.optionsFor(blockId));
    setStage({ kind: "menu" });
    setOpen(true);
  };

  const run = async (action: RewindAction, work: () => Promise<void>) => {
    setStage({ kind: "working", action });
    try {
      await work();
      close();
    } catch (error) {
      setStage({ kind: "error", message: messageOf(error) });
    }
  };

  const loadFiles = async (turnId: string) => {
    setStage({ kind: "loadingFiles" });
    try {
      const preview = await previewRestoreSessionTurn(
        rewind.sessionId,
        rewind.cwd,
        turnId,
      );
      setStage({ kind: "files", preview });
    } catch (error) {
      setStage({ kind: "error", message: messageOf(error) });
    }
  };

  const restore = async (turnId: string) => {
    setStage({ kind: "working", action: "files" });
    try {
      const result = await restoreSessionTurn(
        rewind.sessionId,
        rewind.cwd,
        turnId,
      );
      setStage({ kind: "restored", result });
    } catch (error) {
      setStage({ kind: "error", message: messageOf(error) });
    }
  };

  const later = options?.laterPrompts ?? 0;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-turn-rewind={blockId}
        title="Rewind, restore or fork from here"
        aria-label="Rewind, restore or fork from here"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <RotateCcw className="size-3.5" strokeWidth={1.75} />
      </button>
      {open && options ? (
        <Popover
          anchor={trigger}
          side="bottom"
          align="end"
          gap={6}
          width={320}
          maxHeight={420}
          onDismiss={close}
          autoFocus
        >
          <div
            role="menu"
            aria-label="Rewind, restore or fork"
            data-turn-rewind-menu
            className="flex flex-col gap-0.5 p-1.5 font-sans text-[12.5px]"
          >
            {stage.kind === "menu" ? (
              <>
                <MenuItem
                  icon={<Undo2 className="size-3.5" strokeWidth={1.75} />}
                  action="chat"
                  enabled={options.chat.enabled}
                  detail={
                    options.chat.enabled
                      ? "The agent forgets this prompt and what came after. Files stay as they are."
                      : options.chat.reason
                  }
                  onSelect={() => setStage({ kind: "confirmChat" })}
                />
                <MenuItem
                  icon={<RotateCcw className="size-3.5" strokeWidth={1.75} />}
                  action="files"
                  enabled={options.files.enabled}
                  detail={
                    options.files.enabled
                      ? "Puts the files back as they were. The chat stays as it is."
                      : options.files.reason
                  }
                  onSelect={() =>
                    void loadFiles(options.files.checkpointTurnId!)
                  }
                />
                <MenuItem
                  icon={<GitBranch className="size-3.5" strokeWidth={1.75} />}
                  action="fork"
                  enabled={options.fork.enabled}
                  detail={
                    !options.fork.enabled
                      ? options.fork.reason
                      : options.fork.plan.mode === "native"
                        ? "A new chat with the conversation up to this turn's reply."
                        : `A new chat seeded with the transcript, approximate: ${options.fork.plan.reason}.`
                  }
                  onSelect={() =>
                    void run("fork", () => rewind.onFork(blockId))
                  }
                />
              </>
            ) : null}
            {stage.kind === "confirmChat" ? (
              <Confirm
                text={`Take back this prompt${
                  later > 0
                    ? ` and the ${later} prompt${later === 1 ? "" : "s"} after it`
                    : ""
                }, with the replies? The prompt goes back in the composer. Files stay as they are.`}
                confirm="Rewind chat"
                onConfirm={() =>
                  void run("chat", () => rewind.onRewindChat(blockId))
                }
                onCancel={() => setStage({ kind: "menu" })}
              />
            ) : null}
            {stage.kind === "loadingFiles" ? (
              <p className="px-2 py-1.5 text-content/55">Checking the files…</p>
            ) : null}
            {stage.kind === "files" ? (
              <FilesPreview
                preview={stage.preview}
                onConfirm={() => void restore(stage.preview.turnId)}
                onCancel={() => setStage({ kind: "menu" })}
              />
            ) : null}
            {stage.kind === "working" ? (
              <p role="status" className="px-2 py-1.5 text-content/55">
                {ACTION_LABEL[stage.action]}…
              </p>
            ) : null}
            {stage.kind === "restored" ? (
              <div role="status" className="flex flex-col gap-1 px-2 py-1.5">
                <p className="text-content/85">
                  Restored {stage.result.restored.length} file
                  {stage.result.restored.length === 1 ? "" : "s"}.
                  {stage.result.skipped.length
                    ? ` Left ${stage.result.skipped.length} as they were.`
                    : ""}
                </p>
                <p className="text-[11.5px] leading-4 text-content/50">
                  The folder as it was is kept in commit{" "}
                  <code className="font-mono">{stage.result.backup.slice(0, 10)}</code>.
                </p>
                <button
                  type="button"
                  className="self-end rounded-md px-2 py-1 text-content/70 hover:bg-content/8"
                  onClick={close}
                >
                  Done
                </button>
              </div>
            ) : null}
            {stage.kind === "error" ? (
              <div className="flex flex-col gap-1 px-2 py-1.5">
                <p role="alert" className="text-red-400">
                  {stage.message}
                </p>
                <button
                  type="button"
                  className="self-end rounded-md px-2 py-1 text-content/70 hover:bg-content/8"
                  onClick={() => setStage({ kind: "menu" })}
                >
                  Back
                </button>
              </div>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function MenuItem({
  icon,
  action,
  enabled,
  detail,
  onSelect,
}: {
  icon: ReactNode;
  action: RewindAction;
  enabled: boolean;
  detail?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-rewind-action={action}
      aria-disabled={!enabled}
      disabled={!enabled}
      onClick={onSelect}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left enabled:hover:bg-content/8 disabled:cursor-default"
    >
      <span className={`mt-0.5 ${enabled ? "text-content/70" : "text-content/30"}`}>
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className={enabled ? "text-content" : "text-content/40"}>
          {ACTION_LABEL[action]}
        </span>
        {detail ? (
          <span className="text-[11.5px] leading-4 text-content/45">
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function Confirm({
  text,
  confirm,
  onConfirm,
  onCancel,
}: {
  text: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-2 py-1.5">
      <p className="text-content/85">{text}</p>
      <div className="flex justify-end gap-1">
        <button
          type="button"
          className="rounded-md px-2 py-1 text-content/70 hover:bg-content/8"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          data-rewind-confirm
          className="primary-action rounded-md px-2.5 py-1 font-medium"
          onClick={onConfirm}
        >
          {confirm}
        </button>
      </div>
    </div>
  );
}

const ACTION_WORD: Record<RestorePreview["files"][number]["action"], string> = {
  restore: "restore",
  recreate: "bring back",
  delete: "delete",
};

function FilesPreview({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: RestorePreview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const restorable = preview.files.filter((file) => file.restorable);
  const shown = preview.files.slice(0, MAX_PREVIEW_FILES);
  if (preview.files.length === 0) {
    return (
      <div className="flex flex-col gap-2 px-2 py-1.5">
        <p className="text-content/70">
          The files already match how they were before this turn.
        </p>
        <button
          type="button"
          className="self-end rounded-md px-2 py-1 text-content/70 hover:bg-content/8"
          onClick={onCancel}
        >
          Back
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-2 py-1.5">
      {preview.blocked ? (
        <p role="alert" className="text-red-400">
          {preview.blocked}
        </p>
      ) : (
        <p className="text-content/85">
          This changes {restorable.length} file
          {restorable.length === 1 ? "" : "s"}, also undoing any change made
          to them after this turn. A backup commit is kept first.
        </p>
      )}
      <ul data-restore-files className="flex max-h-48 flex-col overflow-auto">
        {shown.map((file) => (
          <li
            key={file.relative}
            className="flex items-center gap-2 py-0.5 text-[11.5px]"
            title={file.reason ?? file.path}
          >
            <span
              className={`w-16 shrink-0 ${file.restorable ? "text-content/45" : "text-content/30 line-through"}`}
            >
              {ACTION_WORD[file.action]}
            </span>
            <span className="min-w-0 truncate font-mono text-content/75">
              {file.relative}
            </span>
          </li>
        ))}
        {preview.files.length > shown.length ? (
          <li className="py-0.5 text-[11.5px] text-content/45">
            and {preview.files.length - shown.length} more
          </li>
        ) : null}
      </ul>
      <div className="flex justify-end gap-1">
        <button
          type="button"
          className="rounded-md px-2 py-1 text-content/70 hover:bg-content/8"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          data-restore-confirm
          disabled={!!preview.blocked || restorable.length === 0}
          className="primary-action rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
          onClick={onConfirm}
        >
          Restore {restorable.length} file{restorable.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
