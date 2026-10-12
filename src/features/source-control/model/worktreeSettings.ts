import { useSyncExternalStore } from "react";

/**
 * #30: where new worktrees go and how their branches are named. Global, as in
 * Claude's desktop app. The folder is empty for "beside the repository" (the
 * old `<repo>-worktrees` folder); a set folder gets one subfolder per
 * repository. The prefix starts the branch name MonoCode gives a worktree
 * once it has a name. Temporary and orchestration branches keep `mc/`, which
 * is how MonoCode knows it may rename or remove them.
 */
export type WorktreeSettings = {
  folder: string;
  prefix: string;
};

export const WORKTREE_SETTINGS_KEY = "monocode.worktreeSettings";
export const DEFAULT_BRANCH_PREFIX = "mc/";
export const DEFAULTS: WorktreeSettings = {
  folder: "",
  prefix: DEFAULT_BRANCH_PREFIX,
};
const MAX_FOLDER = 1024;
const MAX_PREFIX = 40;

/**
 * A folder is kept when it is empty, or absolute (`/…`, `~/…`, a Windows drive)
 * with no `..` part and no control characters. Anything else is dropped.
 */
export function sanitizeWorktreeFolder(value: unknown): string {
  if (typeof value !== "string") return "";
  const folder = value.trim();
  if (!folder || folder.length > MAX_FOLDER) return "";
  if (/[\u0000-\u001f\u007f]/.test(folder)) return "";
  const absolute =
    folder.startsWith("/") ||
    folder === "~" ||
    folder.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(folder);
  if (!absolute) return "";
  if (folder.split(/[\\/]+/).includes("..")) return "";
  return folder;
}

/**
 * A prefix is letters, digits, `.`, `_`, `-` and `/`, at most 40 characters,
 * not starting with `-`, `.` or `/`, with no `..`, `//` or `.lock` part. An
 * empty prefix is allowed. A bad prefix falls back to `mc/`.
 */
export function sanitizeBranchPrefix(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BRANCH_PREFIX;
  const prefix = value.trim();
  if (!prefix) return "";
  if (prefix.length > MAX_PREFIX) return DEFAULT_BRANCH_PREFIX;
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix)) return DEFAULT_BRANCH_PREFIX;
  if (/^[-./]/.test(prefix)) return DEFAULT_BRANCH_PREFIX;
  if (prefix.includes("..") || prefix.includes("//")) return DEFAULT_BRANCH_PREFIX;
  if (prefix.split("/").some((part) => part.endsWith(".lock"))) {
    return DEFAULT_BRANCH_PREFIX;
  }
  return prefix;
}

export function sanitizeWorktreeSettings(value: unknown): WorktreeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULTS };
  }
  const record = value as Record<string, unknown>;
  return {
    folder: sanitizeWorktreeFolder(record.folder),
    prefix:
      record.prefix === undefined
        ? DEFAULT_BRANCH_PREFIX
        : sanitizeBranchPrefix(record.prefix),
  };
}

let cache: WorktreeSettings | null = null;
let version = 0;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadWorktreeSettings(): WorktreeSettings {
  if (cache) return cache;
  let parsed: unknown;
  try {
    const raw = storage()?.getItem(WORKTREE_SETTINGS_KEY);
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  cache = sanitizeWorktreeSettings(parsed);
  return cache;
}

export function saveWorktreeSettings(patch: Partial<WorktreeSettings>): WorktreeSettings {
  const next = sanitizeWorktreeSettings({ ...loadWorktreeSettings(), ...patch });
  cache = next;
  try {
    storage()?.setItem(WORKTREE_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the setting lasts for this app run only.
  }
  version += 1;
  for (const notify of listeners) notify();
  return next;
}

/** Test seam. */
export function resetWorktreeSettingsCache(): void {
  cache = null;
}

export function useWorktreeSettings(): WorktreeSettings {
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => version,
    () => version,
  );
  return loadWorktreeSettings();
}
