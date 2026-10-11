import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { homeDir, listDir } from "../../../platform/tauri/fs";
import {
  Popover,
  type PopoverAnchor,
  type PopoverDismissReason,
} from "../../../shared/ui/Popover";
import type { Block } from "../../sessions/model/session";
import { isValidSkillName } from "../../skills/model/skills";
import { recordSkillPrompt } from "../model/recordSkillPrompt";
import { buildSessionOutline } from "../model/sessionOutline";
import {
  cleanDescription,
  RECORD_SKILL_FOLDERS,
  recordSkillFile,
  recordSkillFolder,
  skillNameError,
  type RecordSkillHarness,
  type RecordSkillScope,
} from "../model/skillRecording";

/** What the dialog reads from disk. Tests and fixtures pass fakes. */
export type RecordSkillIo = {
  homeDir: () => Promise<string>;
  /** Names of the entries in a folder. Rejects when it does not exist. */
  listFolder: (path: string) => Promise<string[]>;
};

const TAURI_IO: RecordSkillIo = {
  homeDir,
  listFolder: (path) =>
    listDir(path).then((entries) => entries.map((entry) => entry.name)),
};

const FIELD =
  "w-full rounded-md bg-content/10 px-2 py-1.5 text-[13px] text-content outline-none placeholder:text-content/40";
const LABEL = "mb-1 block text-[11px] text-content/55";
const NOTE = "text-[11px] leading-4 text-content/45";

/**
 * Asks for a skill name, when to use it, and where to save it, then hands
 * the composer one turn that has the agent write the skill. Nothing is
 * written by MonoCode itself.
 */
export function RecordSkillDialog({
  anchor,
  harness,
  projectCwd,
  inWorktree = false,
  blocks,
  catalogNames,
  onRecord,
  onDismiss,
  io = TAURI_IO,
}: {
  anchor: PopoverAnchor;
  harness: RecordSkillHarness;
  /** The folder the chat runs in. A project skill is saved under it. */
  projectCwd: string;
  /** The chat runs in a git worktree, so a project skill lands there. */
  inWorktree?: boolean;
  blocks: readonly Block[];
  /** Skill names the chat already has, from its catalog. */
  catalogNames: readonly string[];
  /** Sends the turn. False means it was not sent. */
  onRecord: (prompt: string) => boolean | void;
  onDismiss: (reason: PopoverDismissReason | "recorded") => void;
  io?: RecordSkillIo;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const projectFolder = recordSkillFolder({
    harness,
    scope: "project",
    home: null,
    projectCwd,
  });
  const [scope, setScope] = useState<RecordSkillScope>(
    projectFolder ? "project" : "user",
  );
  const [home, setHome] = useState<string | null>(null);
  const [homeFailed, setHomeFailed] = useState(false);
  // Entry names per folder, once listed. A folder that is not there is empty.
  const [listed, setListed] = useState<Record<string, string[]>>({});
  const [attempted, setAttempted] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The popover measures itself hidden on its first pass, and a hidden
    // input cannot take focus, so wait for the frame it is placed in.
    const frame = requestAnimationFrame(() => nameInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let live = true;
    io.homeDir().then(
      (path) => live && setHome(path),
      () => live && setHomeFailed(true),
    );
    return () => {
      live = false;
    };
  }, [io]);

  const folder = recordSkillFolder({ harness, scope, home, projectCwd });
  const folderNames = folder ? listed[folder] : undefined;

  useEffect(() => {
    if (!folder || listed[folder]) return;
    let live = true;
    const done = (names: string[]) => {
      if (live) setListed((current) => ({ ...current, [folder]: names }));
    };
    io.listFolder(folder).then(done, () => done([]));
    return () => {
      live = false;
    };
  }, [folder, io, listed]);

  const taken = useMemo(
    () => new Set([...catalogNames, ...(folderNames ?? [])]),
    [catalogNames, folderNames],
  );
  const trimmed = name.trim();
  const nameError = skillNameError(trimmed, taken);
  const cleaned = cleanDescription(description);
  // An invalid name is never shown as a path.
  const file =
    folder && isValidSkillName(trimmed)
      ? recordSkillFile(folder, trimmed)
      : null;
  const checking = !!folder && !folderNames;
  const ready = !nameError && !!cleaned && !!file && !checking;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!ready || !file || !cleaned) return;
    const prompt = recordSkillPrompt({
      name: trimmed,
      description: cleaned,
      file,
      outline: buildSessionOutline(blocks, { harness, cwd: projectCwd }),
    });
    if (onRecord(prompt) === false) {
      setSendError("Could not send. Try again.");
      return;
    }
    onDismiss("recorded");
  };

  const showNameError = !!nameError && (attempted || trimmed.length > 0);
  const relative = RECORD_SKILL_FOLDERS[harness];

  return (
    <Popover
      anchor={anchor}
      side="top"
      align="start"
      width={320}
      onDismiss={onDismiss}
      data-composer-plus
      role="dialog"
      aria-label="Record a skill"
      className="p-1.5"
    >
      <form onSubmit={submit} className="px-2 py-1.5">
        <p className="pb-1 text-[10px] font-medium uppercase tracking-wide text-content/40">
          Record a skill
        </p>
        <p className={`mb-2 ${NOTE}`}>
          The agent writes a SKILL.md from what this chat did. It does not redo
          the work.
        </p>
        <label className="mb-2 block">
          <span className={LABEL}>Name</span>
          <input
            ref={nameInput}
            value={name}
            spellCheck={false}
            autoComplete="off"
            placeholder="fix-flaky-test"
            aria-invalid={showNameError}
            onChange={(event) => {
              setName(event.target.value);
              setSendError(null);
            }}
            className={`${FIELD} font-mono`}
          />
        </label>
        {showNameError ? (
          <p role="alert" className="-mt-1 mb-2 text-[11px] text-content/70">
            {nameError}
          </p>
        ) : null}
        <label className="mb-2 block">
          <span className={LABEL}>When to use it</span>
          <input
            value={description}
            spellCheck
            autoComplete="off"
            placeholder="Use when a test fails only on CI."
            aria-invalid={attempted && !cleaned}
            onChange={(event) => {
              setDescription(event.target.value);
              setSendError(null);
            }}
            className={FIELD}
          />
        </label>
        {attempted && !cleaned ? (
          <p role="alert" className="-mt-1 mb-2 text-[11px] text-content/70">
            Say when the skill should be used.
          </p>
        ) : null}
        <div role="group" aria-label="Save for" className="mb-2 flex gap-1">
          <ScopeButton
            label="Just me"
            hint={`~/${relative.user}`}
            selected={scope === "user"}
            disabled={homeFailed}
            onClick={() => setScope("user")}
          />
          <ScopeButton
            label="This project"
            hint={relative.project}
            selected={scope === "project"}
            disabled={!projectFolder}
            onClick={() => setScope("project")}
          />
        </div>
        <p className={NOTE}>Saved to</p>
        <p
          data-testid="record-skill-path"
          title={file ?? undefined}
          className="mb-1 break-all font-mono text-[11px] leading-4 text-content/75"
        >
          {file ??
            (folder
              ? `${folder}/<name>/SKILL.md`
              : scope === "user" && homeFailed
                ? "Home folder not found"
                : "...")}
        </p>
        {scope === "project" && inWorktree ? (
          <p className={`mb-1 ${NOTE}`}>
            This chat runs in a worktree. The skill is saved there.
          </p>
        ) : null}
        {scope === "user" ? (
          <p className={`mb-1 ${NOTE}`}>
            Outside the project, so the agent may ask before writing.
          </p>
        ) : null}
        {sendError ? (
          <p role="alert" className="mb-1 text-[11px] text-content/70">
            {sendError}
          </p>
        ) : null}
        <div className="mt-2 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => onDismiss("escape")}
            className="rounded-md px-2 py-1 text-[12px] text-content/50 hover:bg-content/10 hover:text-content"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={attempted && !ready}
            className="rounded-md bg-content/20 px-2 py-1 text-[12px] text-content disabled:opacity-40"
          >
            Record
          </button>
        </div>
      </form>
    </Popover>
  );
}

function ScopeButton({
  label,
  hint,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left ${
        selected
          ? "bg-selection-emphasis text-content"
          : "bg-selection text-content/70"
      } disabled:opacity-40`}
    >
      <span className="text-[12px]">{label}</span>
      <span className="truncate font-mono text-[10px] text-content/40">
        {hint}
      </span>
    </button>
  );
}
