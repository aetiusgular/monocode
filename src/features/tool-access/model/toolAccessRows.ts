import { summarizeToolUse } from "../../session-panel/model/sessionToolUse";
import {
  HARNESS_TITLE,
  type Block,
  type HarnessId,
  type ToolAccess,
} from "../../sessions/model/session";
import {
  CODEX_COMMAND_TOOL,
  CODEX_FILE_CHANGE_TOOL,
  isCommandRuleToolKey,
  mcpTool,
  sanitizeToolAccess,
  toolChoice,
  toolKeyApplies,
  toolLabel,
  type ToolChoice,
} from "./toolAccess";

/** Tools every session of a harness is offered a rule for. */
const BUILT_IN: Partial<
  Record<HarnessId, Array<[key: string, detail: string]>>
> = {
  claude: [
    ["Bash", "Shell commands"],
    ["Edit", "Changes to files"],
    ["Write", "New and rewritten files"],
    ["WebFetch", "Reads a web page"],
    ["WebSearch", "Searches the web"],
  ],
  codex: [
    [CODEX_COMMAND_TOOL, "Shell commands"],
    [CODEX_FILE_CHANGE_TOOL, "Patches to files"],
  ],
};

export type ToolAccessRow = {
  key: string;
  label: string;
  detail: string;
  choice: ToolChoice;
  /**
   * A rule the session's harness does not act on: it was set under another
   * provider. Listed so it can be seen and cleared.
   */
  inactive?: boolean;
  /** A rule for one command: it can be Always or Ask, never Never. */
  allowOnly?: boolean;
};

/** The harness a key was made for, when that is not the session's. */
function otherHarness(harness: HarnessId, key: string): HarnessId | undefined {
  for (const candidate of ["claude", "codex"] as const) {
    if (candidate !== harness && toolKeyApplies(candidate, key)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Tools the transcript shows this session meeting: every tool an approval
 * card named, and on Claude Code every MCP tool it called. Only keys the
 * harness can answer by rule.
 */
export function seenToolKeys(
  blocks: readonly Block[],
  harness: HarnessId,
): string[] {
  const keys = new Set<string>();
  for (const block of blocks) {
    const key = block.approval?.tool?.key;
    if (key && toolKeyApplies(harness, key)) keys.add(key);
  }
  if (harness === "claude") {
    for (const server of summarizeToolUse(blocks, { harness }).mcpServers) {
      for (const tool of server.tools) {
        const key = `mcp__${server.server}__${tool.name}`;
        if (toolKeyApplies(harness, key)) keys.add(key);
      }
    }
  }
  return [...keys];
}

/**
 * One row per tool the popover offers: the harness's built-in list, then every
 * other tool with a rule or met in the transcript by name, then rules left
 * over from another provider.
 */
export function toolAccessRows(
  harness: HarnessId,
  access: ToolAccess | undefined,
  blocks: readonly Block[],
): ToolAccessRow[] {
  const rules = sanitizeToolAccess(access) ?? {};
  const rows: ToolAccessRow[] = [];
  const listed = new Set<string>();
  for (const [key, detail] of BUILT_IN[harness] ?? []) {
    listed.add(key);
    rows.push({
      key,
      label: toolLabel(key),
      detail,
      choice: toolChoice(rules, key),
    });
  }
  const more = new Set([
    ...Object.keys(rules).filter((key) => toolKeyApplies(harness, key)),
    ...seenToolKeys(blocks, harness),
  ]);
  const extra = [...more]
    .filter((key) => !listed.has(key))
    .map((key) => ({
      key,
      label: toolLabel(key),
      detail: isCommandRuleToolKey(key)
        ? "Commands it covers run without asking"
        : mcpTool(key)
          ? "MCP tool"
          : "Tool",
      choice: toolChoice(rules, key),
      ...(isCommandRuleToolKey(key) ? { allowOnly: true } : {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const inactive = Object.keys(rules)
    .filter((key) => !toolKeyApplies(harness, key))
    .map((key) => {
      const owner = otherHarness(harness, key);
      return {
        key,
        label: toolLabel(key),
        detail: owner
          ? `Only applies on ${HARNESS_TITLE[owner]}`
          : `Not used by ${HARNESS_TITLE[harness]}`,
        choice: toolChoice(rules, key),
        inactive: true,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...rows, ...extra, ...inactive];
}
