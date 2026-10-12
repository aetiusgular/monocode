import { useEffect, useState } from "react";
import {
  DEFAULT_BRANCH_PREFIX,
  sanitizeBranchPrefix,
  sanitizeWorktreeFolder,
  saveWorktreeSettings,
  useWorktreeSettings,
} from "../model/worktreeSettings";

const INPUT =
  "h-7.5 w-full rounded-lg border border-content/10 bg-content/5 px-2.5 text-[13px] text-content placeholder:text-content/30 focus:border-accent focus:outline-none";

/** Where a new worktree goes, for a repository at `project`. */
export function worktreeLocation(
  folder: string,
  project: string,
  defaultRoot?: string,
): string | undefined {
  if (!folder) return defaultRoot;
  const name = project.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return `${folder.replace(/[\\/]+$/, "")}/${name}`;
}

/**
 * #30: the worktree folder and the branch prefix. Each field saves when it
 * loses focus or on Enter; a value that is not allowed is shown as refused
 * and the saved one stays.
 */
export function WorktreeSettingsFields() {
  const settings = useWorktreeSettings();
  const [folder, setFolder] = useState(settings.folder);
  const [prefix, setPrefix] = useState(settings.prefix);
  const [refused, setRefused] = useState<string>();
  useEffect(() => setFolder(settings.folder), [settings.folder]);
  useEffect(() => setPrefix(settings.prefix), [settings.prefix]);

  const saveFolder = () => {
    const clean = sanitizeWorktreeFolder(folder);
    if (folder.trim() && !clean) {
      setRefused("The folder must be an absolute path, such as ~/worktrees, with no .. in it.");
      setFolder(settings.folder);
      return;
    }
    setRefused(undefined);
    saveWorktreeSettings({ folder: clean });
  };
  const savePrefix = () => {
    const typed = prefix.trim();
    const clean = sanitizeBranchPrefix(typed);
    if (typed && clean !== typed) {
      setRefused(
        "A prefix can hold letters, digits, ., _, - and /, up to 40 characters, and cannot start with -, . or /.",
      );
      setPrefix(settings.prefix);
      return;
    }
    setRefused(undefined);
    saveWorktreeSettings({ prefix: clean });
  };
  const onEnter = (save: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  };

  return (
    <div data-worktree-settings className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-content/70">Worktree folder</span>
        <input
          className={INPUT}
          value={folder}
          placeholder="Beside the repository"
          spellCheck={false}
          onChange={(event) => setFolder(event.target.value)}
          onBlur={saveFolder}
          onKeyDown={onEnter(saveFolder)}
        />
        <span className="text-[11px] text-content/40">
          Each repository gets its own subfolder. Leave empty to keep worktrees beside the repository.
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-content/70">Branch prefix</span>
        <input
          className={INPUT}
          value={prefix}
          placeholder="No prefix"
          spellCheck={false}
          onChange={(event) => setPrefix(event.target.value)}
          onBlur={savePrefix}
          onKeyDown={onEnter(savePrefix)}
        />
        <span className="text-[11px] text-content/40">
          Starts the branch name of a new worktree once it is named. The default is {DEFAULT_BRANCH_PREFIX}.
        </span>
      </label>
      <p className="text-[11px] leading-4 text-content/40">
        Gitignored files listed in a repository's <code>.worktreeinclude</code> are copied into each new worktree. Links and paths outside the repository are skipped, and nothing in the file is run.
      </p>
      {refused ? (
        <p role="alert" className="text-[11px] text-red-400">
          {refused}
        </p>
      ) : null}
    </div>
  );
}
