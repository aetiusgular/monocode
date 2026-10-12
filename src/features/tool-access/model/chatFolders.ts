/**
 * Approvals held to a chat's folders.
 *
 * Every automatic yes to a file change, from a chat's "always allow" rule or
 * its "Allow for this chat" grant, first checks that each changed path sits
 * inside the chat's working folder or one of its added folders. Anything else
 * goes to the approval card.
 *
 * - Lexical check here: absolute paths only (a relative one is read against
 *   the working folder), no `..` component, no NUL, and names taken literally.
 * - Disk check in Rust (`approval_paths_within`): symlinks are resolved, so a
 *   link inside the folder that points out of it is refused.
 * - Any failure, a missing path, or no folders at all means "not inside".
 */
import { invoke } from "@tauri-apps/api/core";

/** At most this many paths are checked for one request. More shows the card. */
export const MAX_CHECKED_PATHS = 256;

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/")
    ? path.replace(/\/+$/, "")
    : path;
}

/**
 * The absolute, `..`-free form of `path`, or null when it cannot be one.
 * `.` and empty components are dropped. Nothing is resolved on disk.
 */
export function literalAbsolutePath(
  path: string,
  base?: string,
): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096)
    return null;
  if (path.includes("\0")) return null;
  let full = path;
  if (!full.startsWith("/")) {
    if (!base || !base.startsWith("/")) return null;
    full = `${trimTrailingSlash(base)}/${full}`;
  }
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The chat's folders, absolute and deduplicated. The working folder first. */
export function chatFolders(
  cwd: string | undefined,
  extraDirs?: string[],
): string[] {
  const out: string[] = [];
  for (const dir of [cwd, ...(extraDirs ?? [])]) {
    if (!dir) continue;
    const literal = literalAbsolutePath(dir);
    // The filesystem root is never a chat folder: it would admit everything.
    if (!literal || literal === "/") continue;
    if (!out.includes(literal)) out.push(literal);
  }
  return out;
}

/** True when the literal path is a folder itself or sits below one. */
export function lexicallyInside(path: string, folders: string[]): boolean {
  return folders.some(
    (folder) => path === folder || path.startsWith(`${folder}/`),
  );
}

export type DiskPathCheck = (
  folders: string[],
  paths: string[],
) => Promise<boolean>;

const tauriDiskCheck: DiskPathCheck = (folders, paths) =>
  invoke<boolean>("approval_paths_within", { roots: folders, paths });

/**
 * True only when every path is inside one of the chat's folders, lexically
 * and on disk. An empty path list is false: a request whose files are not
 * known shows the card.
 */
export async function pathsInsideChatFolders(
  paths: readonly string[] | null | undefined,
  folders: readonly string[],
  diskCheck: DiskPathCheck = tauriDiskCheck,
): Promise<boolean> {
  if (!paths || paths.length === 0 || paths.length > MAX_CHECKED_PATHS)
    return false;
  const roots = [...folders];
  if (roots.length === 0) return false;
  const literal: string[] = [];
  for (const path of paths) {
    const absolute = literalAbsolutePath(path, roots[0]);
    if (!absolute || !lexicallyInside(absolute, roots)) return false;
    literal.push(absolute);
  }
  try {
    return (await diskCheck(roots, literal)) === true;
  } catch {
    return false;
  }
}

/**
 * The paths a Codex `fileChange` item (or `patchUpdated` notification)
 * touches: each change's `path`, plus the destination of a move. Null when a
 * change has no readable path, so the request fails closed.
 */
export function codexChangePaths(changes: unknown): string[] | null {
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const out: string[] = [];
  for (const change of changes) {
    if (!change || typeof change !== "object") return null;
    const rec = change as Record<string, unknown>;
    const path = rec.path;
    if (typeof path !== "string" || !path) return null;
    out.push(path);
    const kind = rec.kind;
    if (kind && typeof kind === "object") {
      const k = kind as Record<string, unknown>;
      const moved = k.move_path ?? k.movePath;
      if (typeof moved === "string" && moved) out.push(moved);
      else if (moved != null) return null;
    }
  }
  return out;
}

/** Claude Code tools that write one file, and the input key naming it. */
const CLAUDE_FILE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/**
 * For a Claude Code tool that writes a file, the path it writes. Null for a
 * file tool whose input names no path. Undefined for any other tool.
 */
export function claudeWritePath(
  toolName: string,
  input: Record<string, unknown>,
): string | null | undefined {
  const key = CLAUDE_FILE_TOOLS[toolName];
  if (!key) return undefined;
  const value = input[key];
  return typeof value === "string" && value ? value : null;
}

/** The paths of each recent Codex `fileChange` item, by item id. */
export type CodexFileChangeLog = Map<string, string[] | null>;

const MAX_LOGGED_CHANGES = 200;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Keep the paths of `fileChange` items as Codex reports them. Called for
 * every notification, before it is queued, so the paths are known when the
 * approval request for that item arrives.
 */
export function recordCodexFileChange(
  log: CodexFileChangeLog,
  method: string,
  params: unknown,
): void {
  const rec = record(params);
  if (!rec) return;
  let id: string | undefined;
  let paths: string[] | null = null;
  if (method === "item/started" || method === "item/completed") {
    const item = record(rec.item);
    if (!item || item.type !== "fileChange" || typeof item.id !== "string")
      return;
    id = item.id;
    paths = codexChangePaths(item.changes);
  } else if (method === "item/fileChange/patchUpdated") {
    if (typeof rec.itemId !== "string") return;
    id = rec.itemId;
    paths = codexChangePaths(rec.changes);
  } else {
    return;
  }
  const before = log.get(id);
  // A later report adds paths. An unreadable one poisons the item.
  const merged =
    before === null || paths === null
      ? null
      : [...new Set([...(before ?? []), ...paths])];
  log.delete(id);
  log.set(id, merged);
  while (log.size > MAX_LOGGED_CHANGES) {
    const oldest = log.keys().next().value;
    if (oldest === undefined) break;
    log.delete(oldest);
  }
}

/**
 * Whether an automatic yes to this Codex request stays inside the chat's
 * folders. A command names no files, so it passes; the sandbox and the plain
 * check decide for it. A file change passes only when every path of its item
 * is known and inside.
 */
export async function codexRequestInsideChatFolders(
  log: CodexFileChangeLog,
  folders: readonly string[],
  method: string,
  params: unknown,
  diskCheck?: DiskPathCheck,
): Promise<boolean> {
  if (method !== "item/fileChange/requestApproval") return true;
  const itemId = record(params)?.itemId;
  if (typeof itemId !== "string") return false;
  return pathsInsideChatFolders(log.get(itemId), folders, diskCheck);
}
