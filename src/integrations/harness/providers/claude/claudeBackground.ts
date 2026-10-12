import {
  sortBackgroundItems,
  type BackgroundItem,
  type BackgroundItemKind,
} from "../../core/background";
import { isAgentTaskType } from "./claudeProtocol";

/** What Claude Code reports about one task it runs beside the turn. */
export type ClaudeBackgroundTaskInfo = {
  description: string;
  taskType?: string;
  startedAt?: number;
};

/**
 * Claude Code's task types: `local_agent` and `remote_agent` are subagents,
 * a monitor says so in its type, and everything else is a shell command.
 */
export function claudeBackgroundKind(
  taskType: string | undefined,
): BackgroundItemKind {
  if (isAgentTaskType(taskType)) return "subagent";
  if ((taskType ?? "").toLowerCase().includes("monitor")) return "monitor";
  return "shell";
}

/**
 * The Running section's rows for Claude's tasks. Each one can be stopped
 * with `stop_task`, by its id.
 */
export function claudeBackgroundItems(
  tasks: ReadonlyMap<string, ClaudeBackgroundTaskInfo>,
): BackgroundItem[] {
  const items: BackgroundItem[] = [];
  for (const [id, task] of tasks) {
    items.push({
      id,
      kind: claudeBackgroundKind(task.taskType),
      title: task.description.trim() || "Background task",
      status: "running",
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      stoppable: true,
      source: "harness",
    });
  }
  return sortBackgroundItems(items);
}

