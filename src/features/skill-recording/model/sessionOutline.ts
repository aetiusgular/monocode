import {
  summarizeToolUse,
  type UseItem,
} from "../../session-panel/model/sessionToolUse";
import type { Block, HarnessId } from "../../sessions/model/session";
import { isPersonTurn } from "./skillRecording";

/** First line of every recording prompt, so a later outline can skip it. */
export const RECORD_SKILL_PROMPT_LEAD = "Record a skill from this session.";

export const OUTLINE_MAX_CHARS = 6000;
const PROMPT_MAX_CHARS = 400;
const LABEL_MAX_CHARS = 200;
const MAX_PROMPTS = 12;
const MAX_ROWS = 25;
const MAX_READS = 15;

const REDACTED = "[redacted]";

/**
 * Patterns for values that look like credentials. The prompt also tells the
 * agent to leave secrets out; this keeps the obvious ones out of the outline
 * MonoCode writes itself.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${REDACTED}@`],
  [
    /(--?(?:token|password|passwd|pass|secret|api[-_]?key|access[-_]?key|auth)[= ]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1${REDACTED}`,
  ],
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1${REDACTED}`,
  ],
];

/** The text with likely credentials replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function oneLine(text: string, max: number): string {
  const line = redactSecrets(text.replace(/\s+/g, " ").trim());
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

/** A label as inline code, on one line. */
function code(text: string): string {
  return `\`${oneLine(text, LABEL_MAX_CHARS).replace(/`/g, "'")}\``;
}

function times(calls: number): string {
  return calls > 1 ? ` (x${calls})` : "";
}

/** The newest `max` rows, oldest first, with a note for the rest. */
function rows(items: readonly UseItem[], max: number): string[] {
  const shown = items.slice(-max);
  const lines = shown.map(
    (item) => `- ${code(item.label)}${times(item.calls)}`,
  );
  const hidden = items.length - shown.length;
  if (hidden > 0) lines.unshift(`- ${hidden} earlier not shown`);
  return lines;
}

function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? [`${title}:`, ...lines, ""] : [];
}

function promptLines(blocks: readonly Block[]): string[] {
  const prompts = blocks.filter(
    (block) =>
      isPersonTurn(block) &&
      block.text.trim() &&
      !block.text.trimStart().startsWith(RECORD_SKILL_PROMPT_LEAD),
  );
  // The first prompts set the task and the last ones finish it.
  const picked =
    prompts.length > MAX_PROMPTS
      ? [...prompts.slice(0, 2), null, ...prompts.slice(-(MAX_PROMPTS - 2))]
      : prompts;
  let number = 0;
  return picked.map((block) => {
    if (!block) {
      const skipped = prompts.length - MAX_PROMPTS;
      number += skipped;
      return `- ${skipped} prompts in between not shown`;
    }
    number += 1;
    return `${number}. ${oneLine(block.text, PROMPT_MAX_CHARS)}`;
  });
}

/**
 * A compact outline of a chat, built from its transcript: what the person
 * asked, the commands run, the files written, read and searched, and the
 * other tools called. Capped at `maxChars`, so the recording turn stays
 * small however long the chat was.
 */
export function buildSessionOutline(
  blocks: readonly Block[],
  options: { harness?: HarnessId; cwd?: string; maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? OUTLINE_MAX_CHARS;
  const use = summarizeToolUse(blocks, {
    harness: options.harness,
    cwd: options.cwd,
  });
  const mcp = use.mcpServers.map((server) => {
    const tools = server.tools.map((tool) => tool.name).join(", ");
    return `- ${code(tools ? `${server.server}: ${tools}` : server.server)}${times(server.calls)}`;
  });
  const lines = [
    ...section("Prompts, in order", promptLines(blocks)),
    ...section("Commands run", rows(use.items.commands, MAX_ROWS)),
    ...section(
      "Files written or edited",
      rows(use.items.filesEdited, MAX_ROWS),
    ),
    ...section("Files read", rows(use.items.filesRead, MAX_READS)),
    ...section("Project searches", rows(use.items.projectSearches, MAX_ROWS)),
    ...section("Web searches", rows(use.items.webSearches, MAX_ROWS)),
    ...section("Web fetches", rows(use.items.webFetches, MAX_ROWS)),
    ...section("MCP tools", mcp.slice(0, MAX_ROWS)),
    ...section("Subagents", rows(use.items.subagents, MAX_ROWS)),
    ...section("Other tools", rows(use.items.otherTools, MAX_ROWS)),
  ];
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0)
    return "(The transcript has no prompts or tool calls.)";

  const out: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > maxChars) {
      out.push(`(Outline cut at ${maxChars} characters.)`);
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join("\n");
}
