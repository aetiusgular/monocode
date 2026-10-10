import type {
  Block,
  TaskListItem,
  TaskListMeta,
} from "../../sessions/model/session";
import { legacyTaskListFromText } from "../../sessions/model/taskList";

/**
 * The task list the agent is working from right now: the last one in the
 * transcript. Providers replace a list in place while they keep its key, so a
 * later block is a list the agent started afterwards.
 */
export function latestTaskList(blocks: readonly Block[]): TaskListMeta | null {
  return latestTaskListBlock(blocks)?.list ?? null;
}

/** The same list, with the transcript block that shows it. */
export function latestTaskListBlock(
  blocks: readonly Block[],
): { blockId: string; list: TaskListMeta } | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.taskList?.items.length) {
      return { blockId: block.id, list: block.taskList };
    }
    // Snapshots saved before task lists had their own block role.
    if (block.role === "plan" && !block.orchestration) {
      const items = legacyTaskListFromText(block.text);
      if (items) return { blockId: block.id, list: { items } };
    }
  }
  return null;
}

export type TaskListFold = {
  /** Finished steps ahead of the work in hand, shown as one row. */
  earlier: TaskListItem[];
  /** Everything from the first unfinished step on. */
  rest: TaskListItem[];
};

/**
 * Splits a list at its first unfinished step. Only the completed run before
 * that step folds: a step finished out of order stays where the agent put it,
 * and a list with nothing left to do is shown whole rather than as one row.
 */
export function foldEarlierSteps(items: readonly TaskListItem[]): TaskListFold {
  const first = items.findIndex((item) => item.status !== "completed");
  if (first <= 0) return { earlier: [], rest: [...items] };
  return { earlier: items.slice(0, first), rest: items.slice(first) };
}

export function earlierStepsLabel(count: number): string {
  return count === 1 ? "1 earlier step" : `${count} earlier steps`;
}

/** The fold's own label: what it holds while shut, what it does while open. */
export function earlierStepsToggleLabel(count: number, shown: boolean): string {
  if (!shown) return earlierStepsLabel(count);
  return count === 1 ? "Hide earlier step" : "Hide earlier steps";
}

/** The step the agent is on, as a key that changes when it moves on. */
export function runningStepKey(items: readonly TaskListItem[]): string | null {
  const index = items.findIndex((item) => item.status === "in_progress");
  if (index < 0) return null;
  return items[index].id ?? `${index}:${items[index].text}`;
}
