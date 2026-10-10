import { isEqualOrInside, pathKey, slash } from "../../../shared/lib/paths";
import {
  harnessSupportsExtraDirs,
  type HarnessId,
} from "../../sessions/model/session";

/** Bounds what a saved session can put on a harness command line. */
export const MAX_EXTRA_DIRS = 32;

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

/** Forward slashes and no trailing separator, keeping a bare root intact. */
function cleanDir(path: string): string {
  const normalized = slash(path.trim());
  if (/^[A-Za-z]:\/?$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/, "") || "/";
}

function insideAny(dir: string, workDirs: readonly string[]): boolean {
  return workDirs.some(
    (root) => isAbsolutePath(root) && isEqualOrInside(dir, root),
  );
}

/**
 * Folders from the picker added to a session's list. A folder is skipped when
 * it is already listed, is not an absolute path, or is one of the session's
 * working directories or inside one: the agent can already work there.
 * Returns `current` itself when nothing was added.
 */
export function addExtraDirs(
  current: readonly string[],
  picked: readonly string[],
  workDirs: readonly string[],
): string[] {
  const next = [...current];
  const seen = new Set(next.map(pathKey));
  for (const raw of picked) {
    if (next.length >= MAX_EXTRA_DIRS) break;
    if (typeof raw !== "string" || !isAbsolutePath(raw.trim())) continue;
    const dir = cleanDir(raw);
    const key = pathKey(dir);
    if (seen.has(key) || insideAny(dir, workDirs)) continue;
    seen.add(key);
    next.push(dir);
  }
  return next.length === current.length ? (current as string[]) : next;
}

export function removeExtraDir(
  current: readonly string[],
  dir: string,
): string[] {
  const key = pathKey(dir);
  return current.filter((entry) => pathKey(entry) !== key);
}

/** A stored list read back from disk: absolute, unique, bounded. */
export function sanitizeExtraDirs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dirs = addExtraDirs(
    [],
    value.filter((entry): entry is string => typeof entry === "string"),
    [],
  );
  return dirs.length > 0 ? dirs : undefined;
}

/**
 * The folders to hand a harness for a turn running in `workCwd`. The working
 * directory can change after a folder was added (a worktree, another project),
 * so anything it now covers is dropped here rather than at the time of adding.
 */
export function harnessExtraDirs(
  harness: HarnessId,
  dirs: readonly string[] | undefined,
  workCwd: string,
): string[] | undefined {
  if (!dirs?.length || !harnessSupportsExtraDirs(harness)) return undefined;
  const effective = dirs.filter((dir) => !insideAny(dir, [workCwd]));
  return effective.length > 0 ? effective : undefined;
}

/** Last path segment, for a chip label. */
export function extraDirName(dir: string): string {
  const clean = cleanDir(dir);
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  return name || clean;
}

/**
 * Folders added after the running turn started. `atTurnStart` is the list as
 * the turn began, or null while no turn is running. Both harnesses pick up a
 * new folder when the next turn starts, never in the middle of one.
 */
export function pendingExtraDirs(
  dirs: readonly string[],
  atTurnStart: readonly string[] | null,
): Set<string> {
  if (!atTurnStart) return new Set();
  const applied = new Set(atTurnStart.map(pathKey));
  return new Set(dirs.filter((dir) => !applied.has(pathKey(dir))));
}
