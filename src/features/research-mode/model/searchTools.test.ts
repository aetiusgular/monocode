import { describe, expect, it } from "vitest";
import {
  canResearch,
  researchRequest,
  researchServiceKey,
  researchTools,
  searchServiceFor,
  type ResearchToolsInput,
} from "./searchTools";

const EXA_GATEWAY = { sessionName: "exa", title: "Exa", server: "exa" };

const names = (input: ResearchToolsInput) =>
  researchTools(input).map((tool) => tool.name);

describe("researchServiceKey", () => {
  it("reads claude.ai, plugin and filler-word names", () => {
    expect(researchServiceKey("claude.ai Exa")).toBe("exa");
    expect(researchServiceKey("plugin:exa:exa")).toBe("exa");
    expect(researchServiceKey("brave-search-mcp")).toBe("bravesearch");
    expect(researchServiceKey("mcp-fetch")).toBe("fetch");
    expect(researchServiceKey("tavily-remote")).toBe("tavily");
  });

  it("does not take a name that only starts like a service", () => {
    expect(searchServiceFor("example")).toBeUndefined();
    expect(searchServiceFor("exa-notes-sync")).toBeUndefined();
    expect(searchServiceFor("google-drive")).toBeUndefined();
    expect(searchServiceFor("github")).toBeUndefined();
  });
});

describe("researchTools on Claude Code", () => {
  it("counts the built-in WebSearch and WebFetch", () => {
    const tools = researchTools({ harness: "claude" });
    expect(tools).toEqual([
      expect.objectContaining({
        name: "WebSearch",
        search: true,
        fetch: false,
      }),
      expect.objectContaining({ name: "WebFetch", search: false, fetch: true }),
    ]);
    expect(canResearch(tools)).toBe(true);
  });

  it("leaves out a built-in tool set to Never in Tool access", () => {
    expect(
      names({ harness: "claude", toolAccess: { WebSearch: "never" } }),
    ).toEqual(["WebFetch"]);
    expect(
      canResearch(
        researchTools({
          harness: "claude",
          toolAccess: { WebSearch: "never" },
        }),
      ),
    ).toBe(false);
    expect(
      names({ harness: "claude", toolAccess: { WebSearch: "always" } }),
    ).toContain("WebSearch");
  });

  it("adds a gateway Exa connector with its tool names", () => {
    const tools = researchTools({
      harness: "claude",
      toolAccess: { WebSearch: "never", WebFetch: "never" },
      gateway: [EXA_GATEWAY],
    });
    expect(tools).toEqual([
      {
        name: "exa",
        label: "the exa connector",
        source: "gateway",
        search: true,
        fetch: true,
        searchTools: ["web_search_exa"],
        fetchTools: ["web_fetch_exa"],
      },
    ]);
  });

  it("drops a gateway connector switched off for the chat", () => {
    expect(
      names({
        harness: "claude",
        gateway: [EXA_GATEWAY],
        disabledMcpServers: ["exa"],
      }),
    ).toEqual(["WebSearch", "WebFetch"]);
  });

  it("drops an Exa tool set to Never and keeps the other", () => {
    const [exa] = researchTools({
      harness: "claude",
      toolAccess: {
        WebSearch: "never",
        WebFetch: "never",
        mcp__exa__web_search_exa: "never",
      },
      gateway: [EXA_GATEWAY],
    });
    expect(exa).toMatchObject({ search: false, fetch: true });
  });

  it("counts claude.ai connectors and plugins only when usable", () => {
    const reported = [
      { name: "claude.ai Exa", status: "connected" },
      { name: "claude.ai Tavily", status: "needs-auth" },
      { name: "plugin:brave:brave-search", status: "pending" },
      { name: "plugin:fire:firecrawl", status: "failed" },
      { name: "claude.ai Notion", status: "connected" },
    ];
    const tools = researchTools({ harness: "claude", reported });
    expect(tools.map((tool) => [tool.name, tool.source, tool.label])).toEqual([
      ["WebSearch", "built-in", "WebSearch"],
      ["WebFetch", "built-in", "WebFetch"],
      ["claude.ai Exa", "account", "the Exa connector"],
      [
        "plugin:brave:brave-search",
        "mcp",
        "the plugin:brave:brave-search MCP server",
      ],
    ]);
  });

  it("counts configured servers for the session's harness only", () => {
    expect(
      names({
        harness: "claude",
        toolAccess: { WebSearch: "never", WebFetch: "never" },
        configured: [
          { name: "brave-search", provider: "claude" },
          { name: "tavily", provider: "codex" },
          { name: "kagi", provider: "claude", enabled: false },
        ],
      }),
    ).toEqual(["brave-search"]);
  });
});

describe("researchTools on Codex", () => {
  it("counts no built-in search", () => {
    expect(researchTools({ harness: "codex" })).toEqual([]);
    expect(canResearch(researchTools({ harness: "codex" }))).toBe(false);
  });

  it("counts gateway and configured Codex servers, not claude.ai ones", () => {
    expect(
      names({
        harness: "codex",
        gateway: [EXA_GATEWAY],
        reported: [{ name: "claude.ai Tavily", status: "connected" }],
        configured: [{ name: "brave", provider: "codex" }],
      }),
    ).toEqual(["exa", "brave"]);
  });

  it("does not let a fetch-only server enable research", () => {
    const tools = researchTools({
      harness: "codex",
      configured: [{ name: "fetch", provider: "codex" }],
    });
    expect(tools).toHaveLength(1);
    expect(canResearch(tools)).toBe(false);
  });
});

it("finds nothing for other harnesses", () => {
  expect(researchTools({ harness: "cursor", gateway: [EXA_GATEWAY] })).toEqual(
    [],
  );
});

describe("researchRequest", () => {
  it("names each tool with its search or page tools", () => {
    const tools = researchTools({ harness: "claude", gateway: [EXA_GATEWAY] });
    expect(
      researchRequest(tools, { harness: "claude" }, "research/2026-10-10-x.md"),
    ).toEqual({
      reportPath: "research/2026-10-10-x.md",
      search: ["WebSearch", "the exa connector (web_search_exa)"],
      fetch: ["WebFetch", "the exa connector (web_fetch_exa)"],
      subagents: true,
    });
  });

  it("asks for subagents on Claude Code unless Task or Agent is Never", () => {
    const tools = researchTools({ harness: "claude" });
    const path = "research/2026-10-10-x.md";
    expect(
      researchRequest(
        tools,
        { harness: "claude", toolAccess: { Task: "never" } },
        path,
      )?.subagents,
    ).toBe(false);
    expect(
      researchRequest(
        tools,
        { harness: "claude", toolAccess: { Agent: "never" } },
        path,
      )?.subagents,
    ).toBe(false);
    const codex = researchTools({ harness: "codex", gateway: [EXA_GATEWAY] });
    expect(researchRequest(codex, { harness: "codex" }, path)?.subagents).toBe(
      false,
    );
  });

  it("gives nothing without a search tool", () => {
    expect(researchRequest([], { harness: "codex" }, "research/x.md")).toBe(
      undefined,
    );
  });
});
