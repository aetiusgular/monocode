import type { Block } from "../../sessions/model/session";

/**
 * Suggested prompts (#46): chips computed from the project's state, with no
 * model call, so they work on every harness and any model and add nothing to
 * the context. A chip fills the composer; it never sends.
 */
export type SuggestedPrompt = {
  id: "failed-command" | "unfinished-tasks" | "unbuilt-plan" | "changes";
  label: string;
  prompt: string;
};

export type ProjectState = {
  /** From `git diff --stat` on the session's working folder; null if unknown. */
  changes: { files: number; additions: number; deletions: number } | null;
};

export const SUGGESTIONS_MAX = 3;
const COMMAND_MAX = 80;

const COMMAND_KINDS = new Set(["execute", "shell", "command", "bash"]);
const FAILED = new Set(["failed", "error"]);

/** The last user turn's blocks: what the agent did since the last prompt. */
function lastTurn(blocks: readonly Block[]): readonly Block[] {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.role === "user" && !block.internal && !block.draft)
      return blocks.slice(index + 1);
  }
  return blocks;
}

/**
 * The command a failed shell call ran, as one short line: the raw command
 * when the harness gave it, else the row's label. It is the agent's text, so
 * it is cut and quoted, and only ever lands in the user's own composer,
 * where they read it before sending.
 */
export function commandLine(block: Block): string {
  const raw = (block.tool?.command || block.tool?.title || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  return raw.length > COMMAND_MAX ? `${raw.slice(0, COMMAND_MAX - 1)}…` : raw;
}

function failedCommand(turn: readonly Block[]): Block | undefined {
  for (let index = turn.length - 1; index >= 0; index--) {
    const block = turn[index]!;
    const tool = block.tool;
    if (!tool || !COMMAND_KINDS.has(tool.kind ?? "")) continue;
    // Only the latest command counts: a later success means it was fixed.
    // A call that never ran (refused on its card, or stopped: the harness
    // marks those cancelled) is not a command to fix (Mac 1.11).
    if (block.approval?.decided === "deny") return undefined;
    return FAILED.has((tool.status ?? "").toLowerCase()) ? block : undefined;
  }
  return undefined;
}

function openTasks(blocks: readonly Block[]): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const list = blocks[index]!.taskList;
    if (!list) continue;
    return list.items.filter(
      (item) => item.status === "pending" || item.status === "in_progress",
    ).length;
  }
  return 0;
}

function unbuiltPlan(blocks: readonly Block[]): boolean {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const plan = blocks[index]!.plan;
    if (plan) return plan.status === "ready";
  }
  return false;
}

/**
 * Up to three chips, most specific first. Nothing while a turn runs or the
 * composer holds text: a chip must never replace what the user wrote.
 */
export function suggestPrompts(input: {
  blocks: readonly Block[];
  busy: boolean;
  hasDraft: boolean;
  state: ProjectState;
}): SuggestedPrompt[] {
  if (input.busy || input.hasDraft) return [];
  const out: SuggestedPrompt[] = [];
  const failed = failedCommand(lastTurn(input.blocks));
  if (failed) {
    const command = commandLine(failed);
    out.push({
      id: "failed-command",
      label: "Fix the failing command",
      prompt: command
        ? `The last command failed: \`${command.replace(/`/g, "'")}\`. Find out why and fix it.`
        : "The last command failed. Find out why and fix it.",
    });
  }
  const tasks = openTasks(input.blocks);
  if (tasks > 0) {
    out.push({
      id: "unfinished-tasks",
      label: `Finish the ${tasks} open task${tasks === 1 ? "" : "s"}`,
      prompt: "Carry on with the tasks that are not done yet.",
    });
  } else if (unbuiltPlan(input.blocks)) {
    out.push({
      id: "unbuilt-plan",
      label: "Build the plan",
      prompt: "Build the plan above.",
    });
  }
  const changes = input.state.changes;
  if (changes && changes.files > 0) {
    out.push({
      id: "changes",
      label: `Review ${changes.files} changed file${changes.files === 1 ? "" : "s"}`,
      prompt:
        "Review the uncommitted changes in this folder. Point out bugs, missing tests and anything left half done.",
    });
  }
  return out.slice(0, SUGGESTIONS_MAX);
}

const DISMISSED_KEY = "monocode:suggested-prompts:off";

/** Chips the user closed for a session; read failures mean none closed. */
export function suggestionsDismissed(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) && list.includes(sessionId);
  } catch {
    return false;
  }
}

function storedList(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    // Unreadable data starts a fresh list rather than blocking every dismiss.
    return [];
  }
}

export function dismissSuggestions(sessionId: string | undefined): void {
  if (!sessionId) return;
  const list = storedList();
  if (!list.includes(sessionId)) list.push(sessionId);
  try {
    // Bounded: the oldest sessions fall off.
    window.localStorage.setItem(
      DISMISSED_KEY,
      JSON.stringify(list.slice(-200)),
    );
  } catch {
    // Storage blocked: the chips come back next time, which is harmless.
  }
}
