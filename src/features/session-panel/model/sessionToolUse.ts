import {
  isAgentTool,
  isExecuteTool,
  isSearchTool,
  isWeakToolTitle,
} from "../../../integrations/harness/core/preview";
import { displayPath, pathKey } from "../../../shared/lib/paths";
import type { AgentStep, Block, HarnessId } from "../../sessions/model/session";
import {
  isHiddenTool,
  isToolBlock,
  needsApproval,
  resolveToolCallDisplay,
  toolCallLabel,
  toolCategory,
} from "../../sessions/model/transcriptActivity";

/** One tool of an MCP server and how often the session called it. */
export type McpToolUse = {
  name: string;
  calls: number;
};

export type McpServerUse = {
  server: string;
  calls: number;
  /** Most-called first. Empty when the calls did not name their tool. */
  tools: McpToolUse[];
  /** Transcript block of the server's latest call. */
  blockId: string;
};

/** One thing the session used, as a row the panel can list and act on. */
export type UseItem = {
  /** What to show: a command line, a query, a file path, a name. */
  label: string;
  /** Transcript block of the latest call (the parent's, for a subagent's). */
  blockId: string;
  /** Absolute path, when the call names a file that can be opened. */
  path?: string;
  /** How many calls this row stands for. */
  calls: number;
};

/**
 * The calls behind each count, one row per distinct thing, in the order each
 * was last used: the newest is at the end.
 */
export type SessionToolUseItems = {
  webSearches: UseItem[];
  webFetches: UseItem[];
  projectSearches: UseItem[];
  commands: UseItem[];
  filesRead: UseItem[];
  filesEdited: UseItem[];
  subagents: UseItem[];
  otherTools: UseItem[];
};

/** What a session's tool calls add up to, read from its transcript alone. */
export type SessionToolUse = {
  /** Most-called first; servers called equally often keep transcript order. */
  mcpServers: McpServerUse[];
  webSearches: number;
  webFetches: number;
  /** Greps, globs and shell searches over the working copy. */
  projectSearches: number;
  commands: number;
  /** Distinct files where the call names one, otherwise one per call. */
  filesRead: number;
  filesEdited: number;
  subagents: number;
  /** Calls that fit none of the above with confidence. */
  otherTools: number;
  /** What the counts are made of. */
  items: SessionToolUseItems;
};

export type ToolUseOptions = {
  /** Provider for turns that do not record their own. */
  harness?: HarnessId;
  /** Working copy, so absolute and relative paths to one file count once. */
  cwd?: string;
};

/** What a call was, before it is told where in the transcript it sits. */
type CallUse =
  | { kind: "mcp"; server: string; tool?: string }
  | { kind: "read" | "edit"; target: string; label: string; path?: string }
  | {
      kind:
        | "webSearch"
        | "webFetch"
        | "projectSearch"
        | "command"
        | "subagent"
        | "other";
      label: string;
    };

type ToolUse = CallUse & { blockId: string };

type CachedUses = {
  harness: HarnessId | undefined;
  cwd: string | undefined;
  uses: ToolUse[];
};

/**
 * Blocks are replaced, never mutated, so a block seen before classifies the
 * same way again. Without this a long session would re-read every call on each
 * streamed token.
 */
const usesByBlock = new WeakMap<Block, CachedUses>();

export function summarizeToolUse(
  blocks: readonly Block[],
  options: ToolUseOptions = {},
): SessionToolUse {
  const servers = new Map<
    string,
    { calls: number; tools: Map<string, number>; blockId: string }
  >();
  const reads = new Map<string, UseItem>();
  const edits = new Map<string, UseItem>();
  const lists = {
    webSearch: new Map<string, UseItem>(),
    webFetch: new Map<string, UseItem>(),
    projectSearch: new Map<string, UseItem>(),
    command: new Map<string, UseItem>(),
    subagent: new Map<string, UseItem>(),
    other: new Map<string, UseItem>(),
  };
  const summary: SessionToolUse = {
    mcpServers: [],
    webSearches: 0,
    webFetches: 0,
    projectSearches: 0,
    commands: 0,
    filesRead: 0,
    filesEdited: 0,
    subagents: 0,
    otherTools: 0,
    items: {
      webSearches: [],
      webFetches: [],
      projectSearches: [],
      commands: [],
      filesRead: [],
      filesEdited: [],
      subagents: [],
      otherTools: [],
    },
  };
  let harness = options.harness;
  for (const block of blocks) {
    // A session can change provider between turns; each turn says which.
    if (block.role === "user" && block.turnModel) {
      harness = block.turnModel.harness;
      continue;
    }
    for (const use of blockToolUses(block, harness, options.cwd)) {
      switch (use.kind) {
        case "mcp": {
          const entry = servers.get(use.server) ?? {
            calls: 0,
            tools: new Map<string, number>(),
            blockId: use.blockId,
          };
          entry.calls += 1;
          entry.blockId = use.blockId;
          if (use.tool) {
            entry.tools.set(use.tool, (entry.tools.get(use.tool) ?? 0) + 1);
          }
          servers.set(use.server, entry);
          break;
        }
        case "read":
          addItem(reads, use.target, use);
          break;
        case "edit":
          addItem(edits, use.target, use);
          break;
        case "webSearch":
          summary.webSearches += 1;
          addItem(lists.webSearch, use.label, use);
          break;
        case "webFetch":
          summary.webFetches += 1;
          addItem(lists.webFetch, use.label, use);
          break;
        case "projectSearch":
          summary.projectSearches += 1;
          addItem(lists.projectSearch, use.label, use);
          break;
        case "command":
          summary.commands += 1;
          addItem(lists.command, use.label, use);
          break;
        case "subagent":
          summary.subagents += 1;
          // Two subagents given the same job are still two subagents.
          addItem(lists.subagent, `${use.blockId}:${use.label}`, use);
          break;
        default:
          summary.otherTools += 1;
          addItem(lists.other, use.label, use);
      }
    }
  }
  summary.filesRead = reads.size;
  summary.filesEdited = edits.size;
  // Map order is first use, and the sort is stable.
  summary.mcpServers = [...servers]
    .map(([server, entry]) => ({
      server,
      calls: entry.calls,
      tools: [...entry.tools]
        .map(([name, calls]) => ({ name, calls }))
        .sort((a, b) => b.calls - a.calls),
      blockId: entry.blockId,
    }))
    .sort((a, b) => b.calls - a.calls);
  summary.items = {
    webSearches: [...lists.webSearch.values()],
    webFetches: [...lists.webFetch.values()],
    projectSearches: [...lists.projectSearch.values()],
    commands: [...lists.command.values()],
    filesRead: [...reads.values()],
    filesEdited: [...edits.values()],
    subagents: [...lists.subagent.values()],
    otherTools: [...lists.other.values()],
  };
  return summary;
}

/**
 * One row per key. A repeat adds to its row, moves the row's link to the later
 * call, and moves the row to the end.
 */
function addItem(
  rows: Map<string, UseItem>,
  key: string,
  use: { label: string; blockId: string; path?: string },
) {
  const row = rows.get(key);
  if (row) {
    row.calls += 1;
    row.blockId = use.blockId;
    if (!row.path && use.path) row.path = use.path;
    rows.delete(key);
    rows.set(key, row);
    return;
  }
  rows.set(key, {
    label: use.label,
    blockId: use.blockId,
    calls: 1,
    ...(use.path ? { path: use.path } : {}),
  });
}

export function isToolUseEmpty(
  use: Omit<SessionToolUse, "items" | "mcpServers"> & {
    mcpServers: readonly unknown[];
  },
): boolean {
  return (
    use.mcpServers.length === 0 &&
    use.webSearches === 0 &&
    use.webFetches === 0 &&
    use.projectSearches === 0 &&
    use.commands === 0 &&
    use.filesRead === 0 &&
    use.filesEdited === 0 &&
    use.subagents === 0 &&
    use.otherTools === 0
  );
}

/** Server of a Claude-style MCP tool name, `mcp__server__tool`. */
export function mcpServerFromToolName(name: string): string | null {
  return mcpToolFromName(name)?.server ?? null;
}

function mcpToolFromName(
  name: string,
): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name.trim());
  return match ? { server: match[1], tool: match[2] } : null;
}

function blockToolUses(
  block: Block,
  harness: HarnessId | undefined,
  cwd: string | undefined,
): ToolUse[] {
  if (!isToolBlock(block)) return [];
  const cached = usesByBlock.get(block);
  if (cached && cached.harness === harness && cached.cwd === cwd) {
    return cached.uses;
  }
  const uses: ToolUse[] = [];
  // A call still waiting on the user, or one the user refused, never ran.
  const ran = !needsApproval(block) && block.approval?.decided !== "deny";
  // Todo updates are the Progress list, and a placeholder row names no tool.
  if (ran && !isHiddenTool(block)) {
    const use = classifyCall(block, harness, cwd);
    if (use) uses.push({ ...use, blockId: block.id });
  }
  // What a subagent did was done in this session too.
  for (const step of block.agentRun?.steps ?? []) {
    if (step.kind !== "tool") continue;
    const call = stepBlock(step);
    if (isHiddenTool(call)) continue;
    const use = classifyCall(call, harness, cwd);
    // A step has no row of its own: its link is the subagent's.
    if (use) uses.push({ ...use, blockId: block.id });
  }
  usesByBlock.set(block, { harness, cwd, uses });
  return uses;
}

/** A subagent's step in the shape the transcript's own classifiers read. */
function stepBlock(step: AgentStep): Block {
  return {
    id: step.id,
    role: "tool",
    text: step.text,
    tool: {
      title: step.text,
      kind: step.toolKind,
      status: step.status,
      preview: step.preview,
    },
  };
}

function classifyCall(
  block: Block,
  harness: HarnessId | undefined,
  cwd: string | undefined,
): CallUse | null {
  const kind = block.tool?.kind;
  const title = block.text || block.tool?.title;
  const preview = block.tool?.preview;
  const names = providerToolNames(block);
  const label = toolCallLabel(block, cwd);
  const query = preview?.query?.trim();

  const mcp = mcpCall(block, names, harness);
  if (mcp) return { kind: "mcp", ...mcp };

  if (isAgentTool(kind, title)) {
    return { kind: "subagent", label: block.agentRun?.name || label };
  }

  // A shell row's names are command lines: `fetch` there is a program.
  if (!isExecuteTool(kind)) {
    const webNames = kind ? [kind, ...names] : names;
    if (webNames.some(isWebSearchName)) {
      return { kind: "webSearch", label: query || label };
    }
    if (webNames.some(isWebFetchName)) {
      return { kind: "webFetch", label: query || label };
    }
    // Codex greps through its shell, which arrives as a command. Its only
    // search item is the web search.
    if (harness === "codex" && lower(kind) === "search") {
      return { kind: "webSearch", label: query || label };
    }
  }

  switch (toolCategory(block)) {
    case "agent":
      return { kind: "subagent", label: block.agentRun?.name || label };
    case "edit":
      return { kind: "edit", ...fileUse(block, label, cwd) };
    case "run":
      // A background row is the same command again, waited on.
      return block.tool?.background ? null : { kind: "command", label };
    case "research": {
      const bare = toolCallLabel(block);
      if (/^Find\b/i.test(bare) || isSearchTool(kind, title, preview)) {
        // A provider files any tool with "search" in its name as a search.
        // One whose name is known and is not a file search is something else.
        const named = lower(kind) === "search" ? names : [];
        return named.length > 0 && !named.some(isProjectSearchName)
          ? { kind: "other", label }
          : { kind: "projectSearch", label: query || label };
      }
      // Listing a folder reads no file; from a shell it is a command.
      if (/^List\b/i.test(bare) && isExecuteTool(kind)) {
        return { kind: "command", label };
      }
      return { kind: "read", ...fileUse(block, label, cwd) };
    }
    default:
      return { kind: "other", label };
  }
}

/** A file call's dedupe key, the path to show, and the path to open. */
function fileUse(
  block: Block,
  label: string,
  cwd: string | undefined,
): { target: string; label: string; path?: string } {
  const preview = block.tool?.preview;
  const display = resolveToolCallDisplay(label, preview, cwd);
  const path = display.isFile ? display.filePath : undefined;
  const shown = path
    ? displayPath(path, cwd)
    : (preview?.fileName ??
      label.match(/^(?:Read|List|Edit|Write)\s+(.+)$/i)?.[1] ??
      label);
  return {
    target: fileTarget(block, cwd),
    label: shown,
    ...(path ? { path } : {}),
  };
}

/**
 * The provider's own name for the tool, where the block still carries it
 * outside its kind. The preview keeps the name of a call whose row was
 * retitled ("Find foo", "Read src/app.ts"), and an unrecognised tool's row is
 * titled with its name. Prose titles and placeholders are not names.
 */
function providerToolNames(block: Block): string[] {
  return [
    block.tool?.preview?.title,
    isExecuteTool(block.tool?.kind) ? undefined : block.tool?.title,
  ].flatMap((value) => {
    const name = value?.trim() ?? "";
    return /^[A-Za-z][\w.:-]*$/.test(name) && !isWeakToolTitle(name)
      ? [name]
      : [];
  });
}

function mcpCall(
  block: Block,
  names: string[],
  harness: HarnessId | undefined,
): { server: string; tool?: string } | null {
  // Claude keeps an MCP tool's name as its kind unless the name reads like a
  // built-in ("search", "read"), and then the preview still has it.
  const kind = block.tool?.kind;
  for (const name of kind ? [kind, ...names] : names) {
    const call = mcpToolFromName(name);
    if (call) return call;
  }
  // Codex titles an MCP call `server:tool` and gives it the kind "other".
  // Other providers use that kind for anything, so only Codex's is trusted.
  if (harness !== "codex" || lower(kind) !== "other") return null;
  for (const name of names) {
    const match = /^([^\s:]+):([^\s:]+)$/.exec(name);
    // "mcp" is what Codex writes when the call did not name its server.
    if (match && match[1] !== "mcp") {
      return { server: match[1], tool: match[2] };
    }
  }
  return null;
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isWebSearchName(name: string): boolean {
  const key = normalizedName(name);
  return key.endsWith("websearch") || key === "searchweb";
}

function isWebFetchName(name: string): boolean {
  const key = normalizedName(name);
  return key.endsWith("webfetch") || key === "fetch";
}

function isProjectSearchName(name: string): boolean {
  const key = normalizedName(name);
  return (
    key === "search" ||
    key === "find" ||
    /grep|glob|ripgrep|codesearch|codebasesearch/.test(key) ||
    /^(?:search|find|list)(?:in)?(?:files?|code|directory|dir)/.test(key) ||
    /^(?:file|code)s?search/.test(key)
  );
}

/** One key per file the call names, or per call when it names none. */
function fileTarget(block: Block, cwd: string | undefined): string {
  const preview = block.tool?.preview;
  if (preview?.path) return `path:${pathKey(displayPath(preview.path, cwd))}`;
  if (preview?.fileName) return `name:${preview.fileName}`;
  const labelled = toolCallLabel(block, cwd).match(
    /^(?:Read|List|Edit|Write)\s+(.+)$/i,
  )?.[1];
  if (labelled) return `path:${pathKey(displayPath(labelled, cwd))}`;
  return `call:${block.tool?.callId ?? block.id}`;
}

function lower(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
