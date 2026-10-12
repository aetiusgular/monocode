import {
  sortBackgroundItems,
  type BackgroundItem,
} from "../../../integrations/harness/core/background";
import { harnessCan } from "../../../integrations/harness/core/capabilities";
import { isAgentTool } from "../../../integrations/harness/core/preview";
import type { Block, HarnessId } from "../../sessions/model/session";

/**
 * One row of the Running section. `stop` says who can stop it: MonoCode for
 * a process it owns, the harness for an item it lists, or nobody but the
 * turn itself (a subagent seen only in the transcript).
 */
export type RunningRow = BackgroundItem & {
  stop: "monocode" | "harness" | "turn";
  /** For a subagent seen in the transcript: its block, to show in chat. */
  blockId?: string;
};

const RUNNING_STATUSES = new Set(["in_progress", "pending", "running"]);

/**
 * Subagents still at work, read from the transcript. Every harness that
 * reports a subagent gives it a tool row, so this is the baseline list.
 */
export function transcriptSubagentRows(blocks: readonly Block[]): RunningRow[] {
  const rows: RunningRow[] = [];
  for (const block of blocks) {
    if (block.role !== "tool" || !block.tool) continue;
    const status = block.tool.status?.toLowerCase() ?? "";
    if (!RUNNING_STATUSES.has(status) && !block.streaming) continue;
    if (!isAgentTool(block.tool.kind, block.text || block.tool.title)) continue;
    rows.push({
      id: `transcript:${block.id}`,
      kind: "subagent",
      title:
        block.agentRun?.name?.trim() ||
        block.tool.title?.trim() ||
        block.text.trim() ||
        "Subagent",
      status: "running",
      stoppable: false,
      source: "harness",
      stop: "turn",
      blockId: block.id,
    });
  }
  return rows;
}

export type RunningInput = {
  harness: HarnessId;
  /** What the harness pushed as events (Claude Code). */
  pushed?: readonly BackgroundItem[];
  /** What the harness answered when asked (Codex). Null: no list to ask. */
  polled?: readonly BackgroundItem[] | null;
  /** Processes MonoCode owns for this session, as rows. */
  owned?: readonly BackgroundItem[];
  blocks: readonly Block[];
  /** Item keys the user asked to stop, shown as stopping until they go. */
  stopping?: ReadonlySet<string>;
};

export function runningRowKey(row: Pick<RunningRow, "source" | "id">): string {
  return `${row.source}:${row.id}`;
}

/**
 * Everything the Running section lists. The harness's own items come first
 * when it has them; a subagent seen only in the transcript is added when the
 * harness reported no subagent of its own, so none shows twice.
 */
export function sessionRunningRows(input: RunningInput): RunningRow[] {
  const canStop = harnessCan(input.harness, "backgroundStop");
  const harnessItems = [...(input.pushed ?? []), ...(input.polled ?? [])];
  const seen = new Set<string>();
  const rows: RunningRow[] = [];
  const add = (row: RunningRow) => {
    const key = runningRowKey(row);
    if (seen.has(key)) return;
    seen.add(key);
    const stopping = input.stopping?.has(key) && row.status === "running";
    rows.push(stopping ? { ...row, status: "stopping" } : row);
  };
  for (const item of input.owned ?? []) {
    add({ ...item, source: "monocode", stop: "monocode" });
  }
  for (const item of harnessItems) {
    const stoppable = canStop && item.stoppable && item.status === "running";
    add({
      ...item,
      source: "harness",
      stoppable,
      stop: stoppable ? "harness" : "turn",
    });
  }
  if (!harnessItems.some((item) => item.kind === "subagent")) {
    for (const row of transcriptSubagentRows(input.blocks)) add(row);
  }
  const order = new Map(
    sortBackgroundItems(rows).map((row, index) => [runningRowKey(row), index]),
  );
  return rows.sort(
    (a, b) => (order.get(runningRowKey(a)) ?? 0) - (order.get(runningRowKey(b)) ?? 0),
  );
}

/** Whether the section should ask the harness for its list. */
export function harnessListsBackground(harness: HarnessId): boolean {
  return harnessCan(harness, "backgroundList") === true;
}

/** "12s", "4m", "2h 5m": how long a row has run. */
export function runningElapsed(startedAt: number | undefined, now: number): string {
  if (!startedAt || now < startedAt) return "";
  const seconds = Math.floor((now - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** The last part of a process's output, for the row's log view. */
export const OUTPUT_VIEW_CHARS = 20_000;

export function outputTail(output: string, max = OUTPUT_VIEW_CHARS): {
  text: string;
  cut: boolean;
} {
  if (output.length <= max) return { text: output, cut: false };
  return { text: output.slice(output.length - max), cut: true };
}

/** Strips terminal colour and cursor codes so a log reads as text. */
export function plainTerminalText(text: string): string {
  return (
    text
      // CSI sequences: colours, cursor moves, clears.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // OSC sequences: titles, links.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[@-_]/g, "")
      .replace(/\r\n/g, "\n")
      // A bare carriage return redraws the line: keep what was drawn last.
      .split("\n")
      .map((line) => {
        const parts = line.split("\r").filter((part) => part !== "");
        return parts[parts.length - 1] ?? "";
      })
      .join("\n")
  );
}
