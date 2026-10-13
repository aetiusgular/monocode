/** Sessions that finished while unfocused, until the user looks at them. */
import type { Block, Session } from "./session";

export function nextUnseenFinishedSessions({
  previousBusyIds,
  busyIds,
  previousUnseenIds,
  focusedSessionId,
  untrackedIds,
}: {
  previousBusyIds: ReadonlySet<string>;
  busyIds: ReadonlySet<string>;
  previousUnseenIds: ReadonlySet<string>;
  focusedSessionId?: string;
  /** Sessions the user cannot focus or see as done, such as orchestration
   * workers and inbox discussions. An unseen session stays loaded until it
   * is looked at, so marking one of these would keep it in memory for good. */
  untrackedIds?: ReadonlySet<string>;
}): Set<string> {
  const next = new Set(previousUnseenIds);
  for (const id of previousBusyIds) {
    if (!busyIds.has(id) && id !== focusedSessionId) next.add(id);
  }
  for (const id of busyIds) next.delete(id);
  if (focusedSessionId) next.delete(focusedSessionId);
  if (untrackedIds) for (const id of untrackedIds) next.delete(id);
  return next;
}

/**
 * How many replies each session finished while unfocused, until the user
 * looks at it. Unlike the done set, a count survives the session working
 * again, so replies keep adding up while the user is away.
 */
export function nextUnseenReplyCounts({
  previousBusyIds,
  busyIds,
  previousCounts,
  focusedSessionId,
  trackedIds,
}: {
  previousBusyIds: ReadonlySet<string>;
  busyIds: ReadonlySet<string>;
  previousCounts: ReadonlyMap<string, number>;
  focusedSessionId?: string;
  /** Only these sessions are counted; others are dropped. */
  trackedIds: ReadonlySet<string>;
}): Map<string, number> {
  const next = new Map(previousCounts);
  for (const id of previousBusyIds) {
    if (!busyIds.has(id) && id !== focusedSessionId && trackedIds.has(id))
      next.set(id, (next.get(id) ?? 0) + 1);
  }
  if (focusedSessionId) next.delete(focusedSessionId);
  for (const id of next.keys()) if (!trackedIds.has(id)) next.delete(id);
  return next;
}

/**
 * The error the last turn ended with, if it ended with one: an error notice
 * after the last prompt the user sent. A chat that finished this way is not
 * "Done" (Mac test 2.16: an automation run whose worktree could not be made
 * showed Done in the sidebar).
 */
export function lastTurnError(blocks: readonly Block[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.role === "user" && !block.internal) return undefined;
    if (block.role === "system" && block.notice === "error") {
      return block.text.trim() || "The turn failed.";
    }
  }
  return undefined;
}

/** Open sessions whose last turn ended in an error, with that error. */
export function failedTurnSessions(
  sessions: readonly Pick<Session, "id" | "blocks" | "busy">[],
): Map<string, string> {
  const failed = new Map<string, string>();
  for (const session of sessions) {
    if (session.busy) continue;
    const error = lastTurnError(session.blocks);
    if (error) failed.set(session.id, error);
  }
  return failed;
}
