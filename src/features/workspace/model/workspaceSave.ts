/**
 * When to write the workspace snapshot.
 *
 * The snapshot effect re-runs on every change to the tabs or sessions, far
 * more often than the snapshot itself changes. Each run cancels the pending
 * timer, so the save must stay pending until it has actually fired: marking
 * the key as saved when the timer was armed lost the save whenever a session
 * updated inside the quiet window, and a layout change then never reached the
 * database until the next one. A key that keeps getting interrupted is saved
 * at once after `WORKSPACE_SAVE_MAX_WAIT_MS` so a streaming session cannot
 * starve it.
 */
export const WORKSPACE_SAVE_QUIET_MS = 250;
export const WORKSPACE_SAVE_MAX_WAIT_MS = 2000;

export type PendingWorkspaceSave = { key: string; since: number };

export type WorkspaceSavePlan =
  | { action: "skip"; pending: null }
  | { action: "save"; pending: null }
  | { action: "wait"; ms: number; pending: PendingWorkspaceSave };

export function planWorkspaceSave(input: {
  key: string;
  savedKey: string | null;
  pending: PendingWorkspaceSave | null;
  now: number;
}): WorkspaceSavePlan {
  const { key, savedKey, pending, now } = input;
  if (key === savedKey) return { action: "skip", pending: null };
  const since = pending?.key === key ? pending.since : now;
  if (now - since >= WORKSPACE_SAVE_MAX_WAIT_MS) {
    return { action: "save", pending: null };
  }
  return {
    action: "wait",
    ms: WORKSPACE_SAVE_QUIET_MS,
    pending: { key, since },
  };
}
