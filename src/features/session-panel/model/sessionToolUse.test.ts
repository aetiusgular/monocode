import { describe, expect, it } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import {
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../../../integrations/harness/providers/claude/claudeProtocol";
import { mapCodexNotification } from "../../../integrations/harness/providers/codex/codexProtocol";
import {
  newSession,
  type Block,
  type HarnessId,
  type Session,
} from "../../sessions/model/session";
import {
  isToolUseEmpty,
  mcpServerFromToolName,
  summarizeToolUse,
  type SessionToolUse,
  type ToolUseOptions,
} from "./sessionToolUse";

/** The counts alone: what the session used, without the lists behind them. */
type Counts = Omit<SessionToolUse, "items" | "mcpServers"> & {
  mcpServers: { server: string; calls: number }[];
};

function counts(use: SessionToolUse): Counts {
  const { items: _items, mcpServers, ...rest } = use;
  return {
    ...rest,
    mcpServers: mcpServers.map(({ server, calls }) => ({ server, calls })),
  };
}

function summarize(blocks: readonly Block[], options?: ToolUseOptions): Counts {
  return counts(summarizeToolUse(blocks, options));
}

const EMPTY: Counts = {
  mcpServers: [],
  webSearches: 0,
  webFetches: 0,
  projectSearches: 0,
  commands: 0,
  filesRead: 0,
  filesEdited: 0,
  subagents: 0,
  otherTools: 0,
};

function session(harness: HarnessId): Session {
  return { ...newSession(harness, "/repo"), id: harness };
}

/** Blocks as the Claude adapter leaves them: a start, then the result. */
function claudeBlocks(
  calls: [name: string, input: Record<string, unknown>][],
): Block[] {
  let state = session("claude");
  calls.forEach(([name, input], index) => {
    const callId = `toolu_${index}`;
    state = applyHarnessEvent(state, {
      type: "tool.started",
      callId,
      title: toolTitle(name, input),
      kind: toolKindFromName(name),
      status: "pending",
      preview: previewFromTool(name, input),
    });
    state = applyHarnessEvent(state, {
      type: "tool.updated",
      callId,
      title: toolTitle(name, input),
      kind: toolKindFromName(name),
      status: "completed",
      detail: "ok",
      preview: previewFromTool(name, input, "ok"),
    });
  });
  return state.blocks;
}

/** Blocks as the Codex adapter leaves them, from app-server thread items. */
function codexBlocks(items: Record<string, unknown>[]): Block[] {
  let state = session("codex");
  items.forEach((item, index) => {
    const params = { item: { id: `item_${index}`, ...item } };
    for (const method of ["item/started", "item/completed"]) {
      for (const event of mapCodexNotification(method, params).events) {
        state = applyHarnessEvent(state, event);
      }
    }
  });
  return state.blocks;
}

function claudeUse(
  calls: [name: string, input: Record<string, unknown>][],
): Counts {
  return summarize(claudeBlocks(calls), {
    harness: "claude",
    cwd: "/repo",
  });
}

function codexUse(items: Record<string, unknown>[]): Counts {
  return summarize(codexBlocks(items), {
    harness: "codex",
    cwd: "/repo",
  });
}

describe("mcpServerFromToolName", () => {
  it("reads the server out of a Claude MCP tool name", () => {
    expect(mcpServerFromToolName("mcp__github__create_issue")).toBe("github");
    expect(mcpServerFromToolName("mcp__claude_ai_Gmail__search_threads")).toBe(
      "claude_ai_Gmail",
    );
    expect(mcpServerFromToolName("mcp__desktop-commander__read_file")).toBe(
      "desktop-commander",
    );
  });

  it("rejects names that are not MCP tools", () => {
    expect(mcpServerFromToolName("Read")).toBeNull();
    expect(mcpServerFromToolName("mcp__github")).toBeNull();
    expect(mcpServerFromToolName("github:create_issue")).toBeNull();
  });
});

describe("summarizeToolUse", () => {
  it("is empty for a session that used nothing", () => {
    const use = summarize([
      { id: "u", role: "user", text: "Hello" },
      { id: "a", role: "assistant", text: "Hi." },
      { id: "r", role: "reasoning", text: "Thinking" },
    ]);
    expect(use).toEqual(EMPTY);
    expect(isToolUseEmpty(use)).toBe(true);
  });

  describe("Claude-style blocks", () => {
    it("groups MCP calls by server, most-called first", () => {
      const use = claudeUse([
        ["mcp__linear__list_issues", {}],
        ["mcp__github__create_issue", { title: "Bug" }],
        ["mcp__github__list_pull_requests", {}],
        ["mcp__github__get_issue", { number: 4 }],
      ]);
      expect(use.mcpServers).toEqual([
        { server: "github", calls: 3 },
        { server: "linear", calls: 1 },
      ]);
      expect(use.otherTools).toBe(0);
      expect(isToolUseEmpty(use)).toBe(false);
    });

    it("keeps an MCP call with its server when the adapter retitled it", () => {
      // "search", "read" and "write" in a tool name make the adapter file the
      // call as a search, a read or an edit and retitle its row.
      const blocks = claudeBlocks([
        ["mcp__github__search_code", { query: "useEffect" }],
        ["mcp__filesystem__read_file", { path: "/repo/src/a.ts" }],
        ["mcp__filesystem__write_file", { path: "/repo/b.ts", content: "x" }],
      ]);
      expect(blocks.map((block) => block.tool?.kind)).toEqual([
        "search",
        "read",
        "edit",
      ]);
      expect(summarize(blocks, { harness: "claude" })).toEqual({
        ...EMPTY,
        mcpServers: [
          { server: "filesystem", calls: 2 },
          { server: "github", calls: 1 },
        ],
      });
    });

    it("counts web searches and fetches apart from project searches", () => {
      const use = claudeUse([
        ["WebSearch", { query: "tauri 2 side panel" }],
        ["WebSearch", { query: "react 19 use" }],
        ["WebFetch", { url: "https://example.com", prompt: "Summarize" }],
        ["Grep", { pattern: "useEffect" }],
        ["Glob", { pattern: "**/*.tsx" }],
      ]);
      expect(use).toEqual({
        ...EMPTY,
        webSearches: 2,
        webFetches: 1,
        projectSearches: 2,
      });
    });

    it("counts commands, and reads a shell search or read for what it is", () => {
      const use = claudeUse([
        ["Bash", { command: "npm test" }],
        ["Bash", { command: "git status" }],
        ["Bash", { command: "ls src" }],
        ["Bash", { command: "rg useEffect src" }],
        ["Bash", { command: "cat src/a.ts" }],
      ]);
      expect(use).toEqual({
        ...EMPTY,
        commands: 3,
        projectSearches: 1,
        filesRead: 1,
      });
    });

    it("counts each file read or edited once", () => {
      const use = claudeUse([
        ["Read", { file_path: "/repo/src/a.ts" }],
        ["Read", { file_path: "/repo/src/a.ts", offset: 200 }],
        ["Read", { file_path: "/repo/src/b.ts" }],
        ["Bash", { command: "cat src/a.ts" }],
        [
          "Edit",
          { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" },
        ],
        [
          "Edit",
          { file_path: "/repo/src/a.ts", old_string: "c", new_string: "d" },
        ],
        ["Write", { file_path: "/repo/src/new.ts", content: "export {}" }],
      ]);
      expect(use.filesRead).toBe(2);
      expect(use.filesEdited).toBe(2);
      expect(use.commands).toBe(0);
    });

    it("counts subagents and what they did", () => {
      let state: Session = {
        ...session("claude"),
        blocks: claudeBlocks([
          [
            "Task",
            { description: "Review the diff", subagent_type: "reviewer" },
          ],
        ]),
      };
      const callId = state.blocks[0].tool?.callId ?? "";
      const steps: [string, Record<string, unknown>][] = [
        ["Read", { file_path: "/repo/src/a.ts" }],
        ["mcp__github__get_pull_request", { number: 12 }],
        ["Bash", { command: "npm test" }],
      ];
      steps.forEach(([name, input], index) => {
        state = applyHarnessEvent(state, {
          type: "agent.step",
          callId,
          stepId: `step_${index}`,
          kind: "tool",
          text: toolTitle(name, input),
          toolKind: toolKindFromName(name),
          status: "completed",
          preview: previewFromTool(name, input),
        });
      });
      state = applyHarnessEvent(state, {
        type: "agent.step",
        callId,
        stepId: "prose",
        kind: "message",
        text: "The diff looks right.",
      });
      expect(summarize(state.blocks, { harness: "claude" })).toEqual({
        ...EMPTY,
        subagents: 1,
        filesRead: 1,
        commands: 1,
        mcpServers: [{ server: "github", calls: 1 }],
      });
    });

    it("puts tools it cannot place under other tools", () => {
      const use = claudeUse([
        ["ToolSearch", { query: "select:Read" }],
        ["ExitPlanMode", {}],
        ["Skill", { skill: "pdf" }],
        ["SomeFutureTool", { anything: true }],
      ]);
      expect(use).toEqual({ ...EMPTY, otherTools: 4 });
    });

    it("leaves the task list tool to the progress section", () => {
      const use = claudeUse([
        ["TodoWrite", { todos: [{ content: "Inspect", status: "pending" }] }],
      ]);
      expect(use).toEqual(EMPTY);
    });
  });

  describe("Codex-style blocks", () => {
    it("groups MCP calls by server", () => {
      const blocks = codexBlocks([
        { type: "mcpToolCall", server: "github", tool: "create_issue" },
        {
          type: "mcpToolCall",
          server: "github",
          tool: "search_code",
          arguments: { query: "useEffect" },
        },
        {
          type: "mcpToolCall",
          server: "docs",
          tool: "read_page",
          arguments: { path: "/repo/README.md" },
        },
      ]);
      // A query or a path in the arguments retitles the row.
      expect(blocks.map((block) => block.text)).toEqual([
        "github:create_issue",
        "Find useEffect",
        "Read README.md",
      ]);
      expect(summarize(blocks, { harness: "codex" })).toEqual({
        ...EMPTY,
        mcpServers: [
          { server: "github", calls: 2 },
          { server: "docs", calls: 1 },
        ],
      });
    });

    it("does not read a server out of a call that names none", () => {
      expect(codexUse([{ type: "mcpToolCall", tool: "create_issue" }])).toEqual(
        {
          ...EMPTY,
          otherTools: 1,
        },
      );
    });

    it("trusts the server:tool title only from Codex", () => {
      const blocks = codexBlocks([
        { type: "mcpToolCall", server: "github", tool: "create_issue" },
      ]);
      expect(summarize(blocks, { harness: "cursor" })).toEqual({
        ...EMPTY,
        otherTools: 1,
      });
      expect(summarize(blocks)).toEqual({ ...EMPTY, otherTools: 1 });
    });

    it("counts its search item as a web search", () => {
      const use = codexUse([
        { type: "webSearch", query: "tauri 2 side panel" },
        { type: "webSearch", query: "react 19 use" },
      ]);
      expect(use).toEqual({ ...EMPTY, webSearches: 2 });
    });

    it("sorts shell commands into commands, searches and reads", () => {
      const use = codexUse([
        { type: "commandExecution", command: "npm test", cwd: "/repo" },
        { type: "commandExecution", command: "git diff --stat", cwd: "/repo" },
        {
          type: "commandExecution",
          command: "ls src",
          cwd: "/repo",
          commandActions: [{ type: "listFiles", path: "src" }],
        },
        {
          type: "commandExecution",
          command: "rg useEffect src",
          cwd: "/repo",
          commandActions: [{ type: "search", query: "useEffect", path: "src" }],
        },
        {
          type: "commandExecution",
          command: "cat src/a.ts",
          cwd: "/repo",
          commandActions: [{ type: "read", path: "/repo/src/a.ts" }],
        },
        {
          type: "commandExecution",
          command: "sed -n 1,40p src/a.ts",
          cwd: "/repo",
          commandActions: [{ type: "read", path: "src/a.ts" }],
        },
      ]);
      expect(use).toEqual({
        ...EMPTY,
        commands: 3,
        projectSearches: 1,
        filesRead: 1,
      });
    });

    it("counts each edited file once", () => {
      const change = (path: string) => ({
        type: "fileChange",
        changes: [{ path, diff: "@@ -1 +1 @@\n-a\n+b\n" }],
      });
      const use = codexUse([
        change("/repo/src/a.ts"),
        change("/repo/src/a.ts"),
        change("/repo/src/b.ts"),
      ]);
      expect(use).toEqual({ ...EMPTY, filesEdited: 2 });
    });

    it("counts a spawned agent, not the bookkeeping around it", () => {
      const use = codexUse([
        {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          prompt: "Review the diff",
          receiverThreadIds: ["thread_1"],
        },
        {
          type: "collabAgentToolCall",
          tool: "wait",
          receiverThreadIds: ["thread_1"],
        },
      ]);
      expect(use.subagents).toBe(1);
      // Waiting on an agent is a call of its own that fits nowhere else.
      expect(use.otherTools).toBe(1);
    });
  });

  it("follows the provider each turn was sent to", () => {
    const user = (id: string, harness: HarnessId): Block => ({
      id,
      role: "user",
      text: "Go on",
      turnModel: { harness, id: "model", name: "Model" },
    });
    const blocks = [
      user("u1", "codex"),
      ...codexBlocks([
        { type: "mcpToolCall", server: "github", tool: "create_issue" },
        { type: "webSearch", query: "tauri" },
      ]),
      user("u2", "claude"),
      ...claudeBlocks([["Grep", { pattern: "tauri" }]]),
    ];
    // The session now runs Claude; its first turn still reads as Codex.
    expect(summarize(blocks, { harness: "claude" })).toEqual({
      ...EMPTY,
      mcpServers: [{ server: "github", calls: 1 }],
      webSearches: 1,
      projectSearches: 1,
    });
  });

  it("does not count a call that was refused or is still waiting", () => {
    const call = (id: string, approval?: Block["approval"]): Block => ({
      id,
      role: approval ? "approval" : "tool",
      text: "npm publish",
      tool: { callId: id, title: "npm publish", kind: "execute" },
      ...(approval ? { approval } : {}),
    });
    const use = summarize([
      call("ran"),
      call("allowed", { requestId: 1, decided: "allow" }),
      call("denied", { requestId: 2, decided: "deny" }),
      call("waiting", { requestId: 3 }),
    ]);
    expect(use).toEqual({ ...EMPTY, commands: 2 });
  });

  it("does not count a background row as a second command", () => {
    const use = summarize([
      {
        id: "run",
        role: "tool",
        text: "npm run dev",
        tool: { callId: "run", title: "npm run dev", kind: "execute" },
      },
      {
        id: "wait",
        role: "tool",
        text: "npm run dev",
        tool: {
          callId: "wait",
          title: "npm run dev",
          kind: "execute",
          background: true,
        },
      },
    ]);
    expect(use).toEqual({ ...EMPTY, commands: 1 });
  });

  it("counts a read with no path once per call", () => {
    const read = (id: string): Block => ({
      id,
      role: "tool",
      text: "Read",
      tool: { callId: id, title: "Read", kind: "read", status: "completed" },
    });
    expect(summarize([read("one"), read("two")]).filesRead).toBe(2);
  });

  it("does not guess at a shell program that shares a tool's name", () => {
    const use = summarize([
      {
        id: "fetch",
        role: "tool",
        text: "fetch",
        tool: {
          callId: "fetch",
          title: "fetch",
          kind: "execute",
          preview: { kind: "shell", title: "fetch" },
        },
      },
    ]);
    expect(use).toEqual({ ...EMPTY, commands: 1 });
  });
});

describe("the lists behind the counts", () => {
  const cwd = "/repo";

  it("names each MCP server's tools and links to its latest call", () => {
    const blocks = claudeBlocks([
      ["mcp__github__get_issue", { number: 1 }],
      ["mcp__linear__get_issue", { id: "A-1" }],
      ["mcp__github__get_issue", { number: 2 }],
      ["mcp__github__list_pull_requests", {}],
    ]);
    const use = summarizeToolUse(blocks, { harness: "claude", cwd });
    expect(use.mcpServers).toEqual([
      {
        server: "github",
        calls: 3,
        tools: [
          { name: "get_issue", calls: 2 },
          { name: "list_pull_requests", calls: 1 },
        ],
        blockId: blocks[3].id,
      },
      {
        server: "linear",
        calls: 1,
        tools: [{ name: "get_issue", calls: 1 }],
        blockId: blocks[1].id,
      },
    ]);
  });

  it("names a Codex MCP call's tool", () => {
    const use = summarizeToolUse(
      codexBlocks([
        {
          type: "mcpToolCall",
          server: "github",
          tool: "create_issue",
          status: "completed",
          arguments: {},
        },
      ]),
      { harness: "codex", cwd },
    );
    expect(use.mcpServers).toHaveLength(1);
    expect(use.mcpServers[0].tools).toEqual([
      { name: "create_issue", calls: 1 },
    ]);
  });

  it("lists commands once each, newest last, with how often they ran", () => {
    const blocks = claudeBlocks([
      ["Bash", { command: "npm test" }],
      ["Bash", { command: "git status" }],
      ["Bash", { command: "npm test" }],
    ]);
    const use = summarizeToolUse(blocks, { harness: "claude", cwd });
    expect(use.commands).toBe(3);
    expect(use.items.commands).toEqual([
      { label: "git status", calls: 1, blockId: blocks[1].id },
      { label: "npm test", calls: 2, blockId: blocks[2].id },
    ]);
  });

  it("gives the same answer when asked again about the same blocks", () => {
    // The second call reads its calls from the per-block cache. Nothing the
    // first call built may have been changed by adding the rows up.
    const blocks = claudeBlocks([
      ["Bash", { command: "npm test" }],
      ["Read", { file_path: "/repo/src/a.ts" }],
      ["Bash", { command: "npm test" }],
      ["mcp__github__get_issue", { number: 1 }],
      ["mcp__github__get_issue", { number: 2 }],
    ]);
    const first = summarizeToolUse(blocks, { harness: "claude", cwd });
    const snapshot = JSON.parse(JSON.stringify(first));
    const second = summarizeToolUse(blocks, { harness: "claude", cwd });
    expect(second).toEqual(snapshot);
    expect(first).toEqual(snapshot);
  });

  it("lists files by their path in the working copy, with one to open", () => {
    const blocks = claudeBlocks([
      ["Read", { file_path: "/repo/src/a.ts" }],
      ["Read", { file_path: "/repo/src/a.ts", offset: 40 }],
      [
        "Edit",
        { file_path: "/repo/src/b.ts", old_string: "x", new_string: "y" },
      ],
    ]);
    const use = summarizeToolUse(blocks, { harness: "claude", cwd });
    expect(use.items.filesRead).toEqual([
      {
        label: "src/a.ts",
        path: "/repo/src/a.ts",
        calls: 2,
        blockId: blocks[1].id,
      },
    ]);
    expect(use.items.filesEdited).toEqual([
      {
        label: "src/b.ts",
        path: "/repo/src/b.ts",
        calls: 1,
        blockId: blocks[2].id,
      },
    ]);
  });

  it("lists web searches by their query and project searches by theirs", () => {
    const use = summarizeToolUse(
      claudeBlocks([
        ["WebSearch", { query: "idempotency keys" }],
        ["Grep", { pattern: "createCharge" }],
      ]),
      { harness: "claude", cwd },
    );
    expect(use.items.webSearches.map((item) => item.label)).toEqual([
      "idempotency keys",
    ]);
    expect(use.items.projectSearches.map((item) => item.label)).toEqual([
      "createCharge",
    ]);
  });

  it("links what a subagent did to the subagent's own row", () => {
    let state = session("claude");
    state = applyHarnessEvent(state, {
      type: "tool.started",
      callId: "agent",
      title: "Review the change",
      kind: toolKindFromName("Task"),
      status: "in_progress",
    });
    state = applyHarnessEvent(state, {
      type: "agent.step",
      callId: "agent",
      stepId: "agent_0",
      kind: "tool",
      text: toolTitle("Bash", { command: "npm test" }),
      toolKind: toolKindFromName("Bash"),
      status: "completed",
      preview: previewFromTool("Bash", { command: "npm test" }),
    });
    const use = summarizeToolUse(state.blocks, { harness: "claude", cwd });
    const row = state.blocks.find((block) => block.agentRun);
    expect(row).toBeDefined();
    expect(use.items.subagents).toEqual([
      { label: "Review the change", calls: 1, blockId: row!.id },
    ]);
    expect(use.items.commands).toEqual([
      { label: "npm test", calls: 1, blockId: row!.id },
    ]);
  });

  it("keeps the lists empty for a session that used nothing", () => {
    const use = summarizeToolUse([{ id: "u", role: "user", text: "Hello" }]);
    expect(Object.values(use.items).every((list) => list.length === 0)).toBe(
      true,
    );
  });
});
