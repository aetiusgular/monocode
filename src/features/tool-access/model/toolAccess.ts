import type { HarnessToolAccess } from "../../../integrations/harness/core/types";
import {
  commandRuleFromKey,
  commandRuleLabel,
  isCommandRuleKey,
} from "./commandRules";
import {
  harnessSupportsToolAccess,
  type ApprovalTool,
  type HarnessId,
  type ToolAccess,
  type ToolAccessRule,
} from "../../sessions/model/session";

/** What the user picks for a tool: a rule, or "ask" for no rule. */
export type ToolChoice = ToolAccessRule | "ask";

/** Bounds what a saved session can put on a harness command line. */
export const MAX_TOOL_RULES = 64;
const MAX_TOOL_KEY_LENGTH = 200;

/** Codex does not name its shell or patch tool; these stand for them. */
export const CODEX_COMMAND_TOOL = "codex:command";
export const CODEX_FILE_CHANGE_TOOL = "codex:file-change";

/**
 * A key never starts with `-`, so it cannot be read as a flag where Claude
 * Code takes tool names on its command line.
 */
const TOOL_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
/** A Claude Code tool name: a built-in tool or `mcp__server__tool`. */
const CLAUDE_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export function isToolKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length <= MAX_TOOL_KEY_LENGTH &&
    key !== "__proto__" &&
    (TOOL_KEY.test(key) || isCommandRuleKey(key))
  );
}

/**
 * A rule a key can hold. A command rule (`Bash(npm test *)`, see
 * `commandRules.ts`) only ever allows: blocking one command form would be
 * easy to get round, and "Never" stays a rule for a whole tool.
 */
function ruleFits(key: string, rule: ToolAccessRule): boolean {
  return rule === "always" || !isCommandRuleKey(key);
}

function own(access: ToolAccess | undefined, key: string): unknown {
  return access && Object.prototype.hasOwnProperty.call(access, key)
    ? access[key]
    : undefined;
}

/** The rule for one tool, or "ask" when the session's mode decides. */
export function toolChoice(
  access: ToolAccess | undefined,
  key: string,
): ToolChoice {
  const rule = own(access, key);
  return rule === "always" || rule === "never" ? rule : "ask";
}

/** Stored rules read back from disk: valid keys, the two rules, bounded. */
export function sanitizeToolAccess(value: unknown): ToolAccess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rules: ToolAccess = {};
  let count = 0;
  for (const [rawKey, rule] of Object.entries(value)) {
    if (count >= MAX_TOOL_RULES) break;
    if (rule !== "always" && rule !== "never") continue;
    const key = rawKey.trim();
    if (!isToolKey(key) || own(rules, key) !== undefined) continue;
    if (!ruleFits(key, rule)) continue;
    rules[key] = rule;
    count += 1;
  }
  return count > 0 ? rules : undefined;
}

/**
 * The rules with one tool's choice changed. "ask" drops the rule. Returns the
 * rules given when nothing changes: the choice already stands, the key is not
 * a tool key, or there is no room for another rule.
 */
export function setToolChoice(
  access: ToolAccess | undefined,
  key: string,
  choice: ToolChoice,
): ToolAccess {
  const current = access ?? {};
  const before = toolChoice(current, key);
  if (before === choice) return current;
  if (choice === "ask") {
    const { [key]: _dropped, ...rest } = current;
    return rest;
  }
  if (!isToolKey(key) || !ruleFits(key, choice)) return current;
  if (before === "ask" && Object.keys(current).length >= MAX_TOOL_RULES) {
    return current;
  }
  return { ...current, [key]: choice };
}

/** True when a key holds an allow rule for one command, not a whole tool. */
export function isCommandRuleToolKey(key: string): boolean {
  return isCommandRuleKey(key);
}

/** True when the harness answers approval requests for this key by rule. */
export function toolKeyApplies(harness: HarnessId, key: string): boolean {
  if (!isToolKey(key)) return false;
  if (harness === "claude")
    return CLAUDE_TOOL_NAME.test(key) || isCommandRuleKey(key);
  // Codex names no tool on an MCP confirmation, so no rule can answer one.
  if (harness === "codex") {
    return key === CODEX_COMMAND_TOOL || key === CODEX_FILE_CHANGE_TOOL;
  }
  return false;
}

/** The rules to hand a harness, or nothing where it cannot act on them. */
export function harnessToolAccess(
  harness: HarnessId,
  access: ToolAccess | undefined,
): HarnessToolAccess | undefined {
  if (!harnessSupportsToolAccess(harness)) return undefined;
  const rules = sanitizeToolAccess(access);
  if (!rules) return undefined;
  const always: string[] = [];
  const never: string[] = [];
  for (const key of Object.keys(rules).sort()) {
    if (!toolKeyApplies(harness, key)) continue;
    (rules[key] === "always" ? always : never).push(key);
  }
  if (always.length === 0 && never.length === 0) return undefined;
  return {
    ...(always.length > 0 ? { always } : {}),
    ...(never.length > 0 ? { never } : {}),
  };
}

/** How many rules a harness input carries. */
export function toolRuleCount(access: HarnessToolAccess | undefined): number {
  return (access?.always?.length ?? 0) + (access?.never?.length ?? 0);
}

/** Server and tool of a Claude Code MCP tool name. */
export function mcpTool(key: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(key);
  return match ? { server: match[1], tool: match[2] } : null;
}

/** A tool key in words: "Bash", "File edits", "exa: web_search". */
export function toolLabel(key: string): string {
  if (key === CODEX_COMMAND_TOOL) return "Commands";
  if (key === CODEX_FILE_CHANGE_TOOL) return "File edits";
  const command = commandRuleFromKey(key);
  if (command) return `Bash: ${commandRuleLabel(command)}`;
  const mcp = mcpTool(key);
  return mcp ? `${mcp.server}: ${mcp.tool}` : key;
}

/** The tool an approval request is about, or nothing for an unusable name. */
export function approvalTool(key: unknown): ApprovalTool | undefined {
  return isToolKey(key) ? { key, label: toolLabel(key) } : undefined;
}

/** An approval's tool read back from disk. */
export function sanitizeApprovalTool(value: unknown): ApprovalTool | undefined {
  if (!value || typeof value !== "object") return undefined;
  return approvalTool((value as { key?: unknown }).key);
}

/**
 * What a rule does not do on this harness, where that differs from what the
 * words suggest. One short line each, shown under the rows.
 */
export function toolAccessCaveats(
  harness: HarnessId,
  access: HarnessToolAccess | undefined,
): string[] {
  if (harness === "codex") {
    return [
      // Codex decides when to ask: not in every mode, and not for commands it
      // considers safe. A rule only answers the requests it does send.
      "Never declines when Codex asks. Codex runs safe commands without asking.",
      // See `commandsAlwaysPolicy` and `isPlainCodexApproval`, and the plan
      // branch of the handler.
      ...(access?.always?.includes(CODEX_COMMAND_TOOL)
        ? [
            "Always on Commands lets Codex run commands in its sandbox without asking, from the next turn. A command that asks to leave the sandbox still asks.",
          ]
        : []),
      ...(access?.always?.includes(CODEX_FILE_CHANGE_TOOL)
        ? [
            "Always on File edits skips patches inside this chat's folders. Others still ask.",
          ]
        : []),
      ...(access?.always?.length ? ["Plan turns stay read only."] : []),
    ];
  }
  if (harness === "claude") {
    return [
      ...(access?.always?.length
        ? ["Always is not used in plan turns. They stay read-only."]
        : []),
      // The tool leaves the model's tool list when the process next starts.
      // Until then only a call Claude Code asks about can be declined.
      ...(access?.never?.length
        ? [
            "Never takes the tool away when the next turn starts. Until then, calls that ask are declined.",
          ]
        : []),
    ];
  }
  return [];
}
