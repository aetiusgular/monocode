import type { HarnessId, ToolAccess } from "../../sessions/model/session";
import { toolChoice } from "../../tool-access/model/toolAccess";
import type { ResearchRequest } from "./researchPrompt";

/** Where a search-capable tool comes from. */
export type ResearchToolSource = "built-in" | "gateway" | "account" | "mcp";

/** One tool, or one MCP server, research can use in this chat. */
export type ResearchTool = {
  /** The MCP server name, or the built-in tool's name. */
  name: string;
  /** How the instructions name it, e.g. `WebSearch` or `the exa connector`. */
  label: string;
  source: ResearchToolSource;
  search: boolean;
  fetch: boolean;
  /** Its search and page tools by name, where they are known for certain. */
  searchTools?: string[];
  fetchTools?: string[];
};

/** A web service an MCP server can wrap, matched on its name. */
type SearchService = {
  title: string;
  /** Lowercase letters and digits of the names it goes by. */
  keys: string[];
  search: boolean;
  fetch: boolean;
  /** Tool names, only where they are known for certain. */
  searchTools?: string[];
  fetchTools?: string[];
};

/**
 * Services known to search the web or read pages. Matching is by server name
 * only: MonoCode does not see a server's tool list before a turn starts, so a
 * search server under an unusual name is not found.
 */
const SERVICES: SearchService[] = [
  {
    title: "Exa",
    keys: ["exa", "exasearch", "exaai", "exalabs", "websearchexa"],
    search: true,
    fetch: true,
    searchTools: ["web_search_exa"],
    fetchTools: ["web_fetch_exa"],
  },
  {
    title: "Brave Search",
    keys: ["brave", "bravesearch"],
    search: true,
    fetch: false,
  },
  { title: "Tavily", keys: ["tavily"], search: true, fetch: true },
  { title: "Firecrawl", keys: ["firecrawl"], search: true, fetch: true },
  {
    title: "Perplexity",
    keys: ["perplexity", "perplexityask"],
    search: true,
    fetch: false,
  },
  {
    title: "DuckDuckGo",
    keys: ["duckduckgo", "ddg", "ddgsearch"],
    search: true,
    fetch: true,
  },
  { title: "Kagi", keys: ["kagi"], search: true, fetch: true },
  { title: "Serper", keys: ["serper"], search: true, fetch: false },
  { title: "SerpApi", keys: ["serpapi"], search: true, fetch: false },
  { title: "SearXNG", keys: ["searxng"], search: true, fetch: true },
  { title: "Linkup", keys: ["linkup"], search: true, fetch: false },
  { title: "Jina", keys: ["jina", "jinaai"], search: true, fetch: true },
  {
    title: "Google Search",
    keys: ["googlesearch"],
    search: true,
    fetch: false,
  },
  { title: "Web search", keys: ["websearch"], search: true, fetch: false },
  { title: "Fetch", keys: ["fetch", "webfetch"], search: false, fetch: true },
];

/** Lowercase letters and digits of a server name, without filler words. */
export function researchServiceKey(name: string): string {
  const bare = name
    .replace(/^claude\.ai\s+/i, "")
    // A plugin server, `plugin:<plugin>:<server>`, goes by its last part.
    .replace(/^plugin:(?:[^:]*:)?/i, "");
  return bare
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[-_ ](remote|mcp|server|official|api)\b/g, " ")
    .replace(/^mcp[-_ ]/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** The web service a server wraps, if its name says so. */
export function searchServiceFor(
  ...names: string[]
): SearchService | undefined {
  for (const name of names) {
    const key = researchServiceKey(name);
    if (!key) continue;
    const service = SERVICES.find((entry) => entry.keys.includes(key));
    if (service) return service;
  }
  return undefined;
}

/** A gateway connector as the session launches it. */
export type ResearchGatewayConnector = {
  sessionName: string;
  title: string;
  server: string;
};

/** What MonoCode knows about a chat's tools before its next turn. */
export type ResearchToolsInput = {
  harness: HarnessId;
  toolAccess?: ToolAccess;
  /** MCP servers switched off for this chat. */
  disabledMcpServers?: readonly string[];
  /** Docker gateway connectors the next turn starts with. */
  gateway?: readonly ResearchGatewayConnector[];
  /** Servers Claude Code reported for the chat or its account. */
  reported?: readonly { name: string; status: string }[] | null;
  /** Servers configured for the harness on this computer. */
  configured?: readonly { name: string; provider: string; enabled?: boolean }[];
};

/** Statuses that mean a reported server's tools can be used this turn. */
const USABLE = new Set(["connected", "pending", "saved"]);

function mcpLabel(kind: "connector" | "MCP server", name: string): string {
  const shown = name.replace(/^claude\.ai\s+/i, "");
  return kind === "connector"
    ? `the ${shown} connector`
    : `the ${shown} MCP server`;
}

/** A Claude Code MCP tool switched to Never in Tool access. */
function mcpToolNever(
  harness: HarnessId,
  access: ToolAccess | undefined,
  server: string,
  tool: string,
): boolean {
  return (
    harness === "claude" &&
    toolChoice(access, `mcp__${server}__${tool}`) === "never"
  );
}

function serverTools(
  input: ResearchToolsInput,
  name: string,
  source: ResearchToolSource,
  service: SearchService,
): ResearchTool[] {
  const searchTools = service.searchTools?.filter(
    (tool) => !mcpToolNever(input.harness, input.toolAccess, name, tool),
  );
  const fetchTools = service.fetchTools?.filter(
    (tool) => !mcpToolNever(input.harness, input.toolAccess, name, tool),
  );
  const search =
    service.search && (!service.searchTools || !!searchTools?.length);
  const fetch = service.fetch && (!service.fetchTools || !!fetchTools?.length);
  if (!search && !fetch) return [];
  return [
    {
      name,
      label: mcpLabel(source === "mcp" ? "MCP server" : "connector", name),
      source,
      search,
      fetch,
      ...(search && searchTools?.length ? { searchTools } : {}),
      ...(fetch && fetchTools?.length ? { fetchTools } : {}),
    },
  ];
}

/**
 * The search and page-reading tools a chat's next turn has, as far as
 * MonoCode can tell. Claude Code's built-in WebSearch and WebFetch count
 * unless Tool access sets them to Never. Codex's own web search does not
 * count: MonoCode does not turn it on and cannot tell whether it is on, and
 * it is missing on local models. MCP servers count by name (see `SERVICES`).
 */
export function researchTools(input: ResearchToolsInput): ResearchTool[] {
  const { harness } = input;
  if (harness !== "claude" && harness !== "codex") return [];
  const off = new Set(input.disabledMcpServers ?? []);
  const out: ResearchTool[] = [];
  const seen = new Set<string>();
  const add = (tools: ResearchTool[]) => {
    for (const tool of tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      out.push(tool);
    }
  };

  if (harness === "claude") {
    for (const [name, search] of [
      ["WebSearch", true],
      ["WebFetch", false],
    ] as const) {
      if (toolChoice(input.toolAccess, name) === "never") continue;
      add([{ name, label: name, source: "built-in", search, fetch: !search }]);
    }
  }

  for (const connector of input.gateway ?? []) {
    if (off.has(connector.sessionName)) continue;
    const service = searchServiceFor(
      connector.server,
      connector.title,
      connector.sessionName,
    );
    if (service) {
      add(serverTools(input, connector.sessionName, "gateway", service));
    }
  }

  // Claude Code's own report: claude.ai connectors and plugin servers.
  if (harness === "claude") {
    for (const server of input.reported ?? []) {
      if (off.has(server.name) || !USABLE.has(server.status)) continue;
      const service = searchServiceFor(server.name);
      if (!service) continue;
      const source = server.name.toLowerCase().startsWith("claude.ai ")
        ? "account"
        : "mcp";
      add(serverTools(input, server.name, source, service));
    }
  }

  for (const server of input.configured ?? []) {
    if (server.provider !== harness || server.enabled === false) continue;
    if (off.has(server.name)) continue;
    const service = searchServiceFor(server.name);
    if (service) add(serverTools(input, server.name, "mcp", service));
  }

  return out;
}

/** True when the chat has at least one tool that searches the web. */
export function canResearch(tools: readonly ResearchTool[]): boolean {
  return tools.some((tool) => tool.search);
}

/** Subagents run through Claude Code's Task tool (named Agent in newer builds). */
function subagentsAllowed(
  harness: HarnessId,
  access: ToolAccess | undefined,
): boolean {
  return (
    harness === "claude" &&
    toolChoice(access, "Task") !== "never" &&
    toolChoice(access, "Agent") !== "never"
  );
}

/** The request a research message is sent with, or none without a search tool. */
export function researchRequest(
  tools: readonly ResearchTool[],
  input: Pick<ResearchToolsInput, "harness" | "toolAccess">,
  reportPath: string,
): ResearchRequest | undefined {
  const named = (label: string, names: string[] | undefined) =>
    names?.length ? `${label} (${names.join(", ")})` : label;
  const search = tools
    .filter((tool) => tool.search)
    .map((tool) => named(tool.label, tool.searchTools));
  if (search.length === 0) return undefined;
  return {
    reportPath,
    search,
    fetch: tools
      .filter((tool) => tool.fetch)
      .map((tool) => named(tool.label, tool.fetchTools)),
    subagents: subagentsAllowed(input.harness, input.toolAccess),
  };
}
