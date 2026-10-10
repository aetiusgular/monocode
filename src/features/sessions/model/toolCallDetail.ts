import { isExecuteTool } from "../../../integrations/harness/core/preview";
import { monoCodeToolCall } from "./monocodeToolCall";
import type { Block } from "./session";
import {
  isHiddenTool,
  isSubagentBlock,
  isToolBlock,
  needsApproval,
  toolCallLabel,
  toolCallState,
  toolCategory,
} from "./transcriptActivity";

/** What a call asked for and what came back, for the row that opens onto it. */
export type ToolCallDetail = {
  /** The whole request: the full command line, or the tool with its input. */
  request: string;
  /** What the call returned, or has printed so far while it runs. */
  response?: string;
  /** The call has started and has not finished. */
  running: boolean;
  /** The turn ended, or was stopped, with the call still out. It never returned. */
  stopped?: true;
  /** The response was cut to the length the transcript keeps. */
  cut: boolean;
  /** What was kept is the end of a live log, not the start of a result. */
  latest?: true;
};

/** How a result that was cut to length ends. See `capToolDetail`. */
const CUT_MARK = "\n…";
/** How a live log that outgrew the limit begins. See `appendToolOutput`. */
const TAIL_MARK = "…\n";

/**
 * The request and response behind a tool row, or null when the row already
 * says all there is. An edit opens onto its diff and a failure onto its error,
 * each through a control of its own, so neither is answered here.
 *
 * A harness keeps one `detail` per call. Codex fills it with the command's
 * output, live. Claude Code fills it with a summary of the request while the
 * call runs, and with the result once it lands. So a running shell call's
 * detail is output unless it only repeats the command, and a running call of
 * any other kind is still showing its request. A call that returns no text
 * leaves that summary in place for good, so a finished call's detail is its
 * response only when it does not read as the request.
 */
export function toolCallDetail(
  block: Block,
  cwd?: string,
  /** The call's turn is still in flight. A call left open by a turn that is over is not running. */
  live = true,
): ToolCallDetail | null {
  if (!isToolBlock(block) || isHiddenTool(block)) return null;
  if (needsApproval(block)) return null;
  const state = toolCallState(block);
  if (state === "rejected") return null;
  if (toolCategory(block) === "edit") return null;

  const label = toolCallLabel(block, cwd);
  const detail = block.tool?.detail?.trim() || undefined;
  const open = state === "pending";
  const running = open && live;
  const stopped = open && !live;
  const shell = isExecuteTool(
    block.tool?.kind,
    block.text || block.tool?.title,
  );

  let request = label;
  let response: string | undefined;
  if (!open) {
    if (detail && isRequestSummary(detail)) {
      // The call returned no text, so its detail is still the request.
      request = detail;
    } else if (detail && !echoesRequest(detail, label)) {
      response = detail;
    }
  } else if (shell) {
    response = detail && !repeatsRequest(detail, label) ? detail : undefined;
  } else if (detail && !repeatsRequest(detail, label)) {
    request = detail;
  }

  const latest = !!response && response.startsWith(TAIL_MARK);
  const cut = latest || (!!response && response.endsWith(CUT_MARK));
  if (!response && request === label && !(open && shell)) return null;
  return {
    request,
    ...(response ? { response } : {}),
    running,
    ...(stopped ? { stopped: true as const } : {}),
    cut,
    ...(latest ? { latest: true as const } : {}),
  };
}

/** Longest input Claude Code's request summary keeps. See `summarizeToolRequest`. */
const SUMMARY_INPUT_LIMIT = 400;

/**
 * Claude Code's summary of a request: the tool's name and its input as JSON,
 * "ToolSearch: {"query":"shopify"}", cut with "..." when the input is long.
 */
function isRequestSummary(detail: string): boolean {
  const input = /^[A-Za-z_][\w.:-]*: (\{[\s\S]*)$/.exec(detail)?.[1];
  if (!input) return false;
  if (input.length === SUMMARY_INPUT_LIMIT && input.endsWith("...")) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * A finished call's detail that is the request said back: the label itself,
 * or Claude Code's "Tool: command". Stricter than `repeatsRequest`, because
 * here the detail may be real output that happens to start like the command.
 */
function echoesRequest(detail: string, label: string): boolean {
  if (detail.trim() === label.trim()) return true;
  const named = /^[A-Za-z_][\w.:-]*:\s+([\s\S]+)$/.exec(detail)?.[1];
  return named !== undefined && repeatsRequest(named, label);
}

/** A detail that only says the request again, bare or as "Tool: request". */
function repeatsRequest(detail: string, label: string): boolean {
  const named = /^[A-Za-z_][\w.:-]*:\s+([\s\S]+)$/.exec(detail)?.[1] ?? detail;
  const said = named.trim();
  const asked = label.trim();
  return (
    said === asked ||
    // Either side may have been shortened by the harness.
    (said.length >= 8 && (asked.startsWith(said) || said.startsWith(asked)))
  );
}

/**
 * The call the main agent has in flight, said as something happening: what
 * the turn's status line names while the work is folded away. `blocks` is one
 * turn. Null between calls, while the agent is thinking or writing. A call
 * waiting on approval is not running, and a subagent has a row of its own
 * that says what it is doing.
 */
export function runningCallLabel(
  blocks: readonly Block[],
  cwd?: string,
): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!isToolBlock(block) || isHiddenTool(block)) continue;
    if (isSubagentBlock(block) || needsApproval(block)) continue;
    // A command left running in the background has the line's own wording.
    if (block.tool?.background) continue;
    if (toolCallState(block) !== "pending") continue;
    // The app's own CLI reads as its action, as its row does, not as the long
    // path to the binary.
    const appCall = monoCodeToolCall(block);
    if (appCall) return `Running monocode app ${appCall.action}`;
    return progressive(toolCallLabel(block, cwd), toolCategory(block));
  }
  return null;
}

const PROGRESSIVE: [RegExp, string][] = [
  [/^Read\s+/i, "Reading "],
  [/^List\s+/i, "Listing "],
  [/^Find\s+/i, "Searching for "],
  [/^Edit\s+/i, "Editing "],
  [/^Write\s+/i, "Writing "],
];

function progressive(label: string, category: string): string {
  for (const [verb, doing] of PROGRESSIVE) {
    if (verb.test(label)) return label.replace(verb, doing);
  }
  return category === "run" ? `Running ${label}` : label;
}
