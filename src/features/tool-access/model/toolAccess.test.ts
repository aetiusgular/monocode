import { describe, expect, it } from "vitest";
import {
  sessionToolsInput,
  sessionToolsSummary,
  withSessionToolsPatch,
} from "../../session-tools/model/harnessInput";
import type { Block, ToolAccess } from "../../sessions/model/session";
import {
  CODEX_COMMAND_TOOL,
  CODEX_FILE_CHANGE_TOOL,
  MAX_TOOL_RULES,
  approvalTool,
  harnessToolAccess,
  sanitizeApprovalTool,
  sanitizeToolAccess,
  setToolChoice,
  toolAccessCaveats,
  toolChoice,
  toolKeyApplies,
  toolLabel,
} from "./toolAccess";
import { seenToolKeys, toolAccessRows } from "./toolAccessRows";

describe("sanitizeToolAccess", () => {
  it("keeps string keys with one of the two rules", () => {
    expect(
      sanitizeToolAccess({
        Bash: "always",
        " WebFetch ": "never",
        mcp__exa__web_search: "always",
        "codex:command": "never",
        Edit: "ask",
        Write: true,
        "": "always",
        "-rf": "always",
        "Bash(rm *)": "never",
        "two words": "never",
      }),
    ).toEqual({
      Bash: "always",
      WebFetch: "never",
      mcp__exa__web_search: "always",
      "codex:command": "never",
    });
  });

  it("is undefined for anything that is not a record of rules", () => {
    expect(sanitizeToolAccess(undefined)).toBeUndefined();
    expect(sanitizeToolAccess(null)).toBeUndefined();
    expect(sanitizeToolAccess("Bash")).toBeUndefined();
    expect(sanitizeToolAccess(["Bash"])).toBeUndefined();
    expect(sanitizeToolAccess({})).toBeUndefined();
    expect(sanitizeToolAccess({ Bash: "sometimes" })).toBeUndefined();
  });

  it("does not let a stored key reach the object's prototype", () => {
    const stored = JSON.parse('{"__proto__":"always","constructor":"never"}');
    const rules = sanitizeToolAccess(stored)!;
    expect(Object.keys(rules)).toEqual(["constructor"]);
    expect(toolChoice(rules, "constructor")).toBe("never");
    expect(toolChoice(rules, "toString")).toBe("ask");
    expect(toolChoice({}, "constructor")).toBe("ask");
  });

  it("stops at the cap", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_TOOL_RULES + 10 }, (_, i) => [`T${i}`, "never"]),
    );
    expect(Object.keys(sanitizeToolAccess(many)!)).toHaveLength(MAX_TOOL_RULES);
  });
});

describe("setToolChoice", () => {
  it("adds, changes and drops a rule without touching the rules given", () => {
    const rules: ToolAccess = { Bash: "always" };
    expect(setToolChoice(rules, "Edit", "never")).toEqual({
      Bash: "always",
      Edit: "never",
    });
    expect(setToolChoice(rules, "Bash", "never")).toEqual({ Bash: "never" });
    expect(setToolChoice(rules, "Bash", "ask")).toEqual({});
    expect(setToolChoice(undefined, "Bash", "always")).toEqual({
      Bash: "always",
    });
    expect(rules).toEqual({ Bash: "always" });
  });

  it("returns the same rules when nothing changes", () => {
    const rules: ToolAccess = { Bash: "always" };
    expect(setToolChoice(rules, "Bash", "always")).toBe(rules);
    expect(setToolChoice(rules, "Edit", "ask")).toBe(rules);
    expect(setToolChoice(rules, "Bash(rm *)", "never")).toBe(rules);
  });

  it("takes no rule past the cap, but still changes one it has", () => {
    const full = Object.fromEntries(
      Array.from({ length: MAX_TOOL_RULES }, (_, i) => [`T${i}`, "never"]),
    ) as ToolAccess;
    expect(setToolChoice(full, "Bash", "always")).toBe(full);
    expect(setToolChoice(full, "T0", "always").T0).toBe("always");
  });
});

describe("harnessToolAccess", () => {
  const rules: ToolAccess = {
    WebFetch: "never",
    Bash: "always",
    mcp__exa__web_search: "always",
    Write: "never",
    [CODEX_COMMAND_TOOL]: "never",
    [CODEX_FILE_CHANGE_TOOL]: "always",
  };

  it("hands Claude Code its tool names, sorted, by rule", () => {
    expect(harnessToolAccess("claude", rules)).toEqual({
      always: ["Bash", "mcp__exa__web_search"],
      never: ["WebFetch", "Write"],
    });
  });

  it("hands Codex its two keys and no tool names", () => {
    expect(harnessToolAccess("codex", rules)).toEqual({
      always: [CODEX_FILE_CHANGE_TOOL],
      never: [CODEX_COMMAND_TOOL],
    });
    // Codex names no tool on an MCP confirmation.
    expect(toolKeyApplies("codex", "mcp__exa__web_search")).toBe(false);
  });

  it("is undefined where no rule applies", () => {
    expect(harnessToolAccess("cursor", rules)).toBeUndefined();
    expect(harnessToolAccess("claude", undefined)).toBeUndefined();
    expect(harnessToolAccess("claude", {})).toBeUndefined();
    expect(
      harnessToolAccess("claude", { [CODEX_COMMAND_TOOL]: "never" }),
    ).toBeUndefined();
    expect(harnessToolAccess("codex", { Bash: "never" })).toBeUndefined();
  });

  it("leaves out the side that is empty", () => {
    expect(harnessToolAccess("claude", { Bash: "never" })).toEqual({
      never: ["Bash"],
    });
  });
});

describe("sessionToolsInput and the summary", () => {
  it("carries the rules for the harness the turn is sent to", () => {
    const session = {
      harness: "claude" as const,
      toolAccess: {
        Bash: "always",
        [CODEX_COMMAND_TOOL]: "never",
      } as ToolAccess,
    };
    expect(sessionToolsInput(session, "/repo")).toEqual({
      toolAccess: { always: ["Bash"] },
    });
    expect(
      sessionToolsInput({ ...session, harness: "codex" }, "/repo"),
    ).toEqual({ toolAccess: { never: [CODEX_COMMAND_TOOL] } });
    expect(
      sessionToolsInput({ ...session, harness: "cursor" }, "/repo"),
    ).toEqual({});
  });

  it("counts the rules and names them in the title", () => {
    expect(
      sessionToolsSummary(
        {
          harness: "claude",
          disabledMcpServers: ["github"],
          toolAccess: { Bash: "always", mcp__exa__web_search: "never" },
        },
        "/repo",
      ),
    ).toEqual({
      label: "1 off · 2 tool rules",
      title:
        "Connectors off: github\nAlways allow: Bash\nNever allow: exa: web_search",
    });
    expect(
      sessionToolsSummary(
        { harness: "codex", toolAccess: { [CODEX_COMMAND_TOOL]: "never" } },
        "/repo",
      ),
    ).toEqual({ label: "1 tool rule", title: "Never allow: Commands" });
    // A rule the harness does not act on is not counted.
    expect(
      sessionToolsSummary(
        { harness: "codex", toolAccess: { Bash: "never" } },
        "/repo",
      ),
    ).toBeNull();
  });

  it("replaces the rules through a patch and clears them when empty", () => {
    const session = { id: "s1", toolAccess: { Bash: "always" } as ToolAccess };
    expect(
      withSessionToolsPatch(session, { toolAccess: { Edit: "never" } }),
    ).toEqual({ id: "s1", toolAccess: { Edit: "never" } });
    expect(
      withSessionToolsPatch(session, { toolAccess: {} }).toolAccess,
    ).toBeUndefined();
    expect(withSessionToolsPatch(session, {})).toBe(session);
  });
});

describe("tool labels", () => {
  it("names a key in words", () => {
    expect(toolLabel("Bash")).toBe("Bash");
    expect(toolLabel(CODEX_COMMAND_TOOL)).toBe("Commands");
    expect(toolLabel(CODEX_FILE_CHANGE_TOOL)).toBe("File edits");
    expect(toolLabel("mcp__exa__web_search")).toBe("exa: web_search");
  });

  it("describes the tool of an approval request, or nothing", () => {
    expect(approvalTool("mcp__exa__web_search")).toEqual({
      key: "mcp__exa__web_search",
      label: "exa: web_search",
    });
    expect(approvalTool(undefined)).toBeUndefined();
    expect(approvalTool("not a tool")).toBeUndefined();
    // The label is worked out again, never trusted from disk.
    expect(sanitizeApprovalTool({ key: "Bash", label: "<b>x</b>" })).toEqual({
      key: "Bash",
      label: "Bash",
    });
    expect(sanitizeApprovalTool({ key: 7 })).toBeUndefined();
    expect(sanitizeApprovalTool("Bash")).toBeUndefined();
  });
});

function toolBlock(id: string, tool: Block["tool"], extra?: Partial<Block>) {
  return { id, role: "tool", text: tool?.title ?? "", tool, ...extra } as Block;
}

describe("toolAccessRows", () => {
  const blocks: Block[] = [
    { id: "u", role: "user", text: "go" },
    toolBlock("t1", {
      callId: "c1",
      kind: "mcp__exa__web_search",
      title: "mcp__exa__web_search",
      status: "completed",
    }),
    toolBlock(
      "t2",
      { callId: "c2", kind: "edit", title: "NotebookEdit", status: "failed" },
      {
        approval: {
          requestId: 4,
          decided: "deny",
          tool: { key: "NotebookEdit", label: "NotebookEdit" },
        },
      },
    ),
  ];

  it("lists the built-in tools first, each on Ask", () => {
    expect(
      toolAccessRows("claude", undefined, []).map((row) => [
        row.label,
        row.choice,
      ]),
    ).toEqual([
      ["Bash", "ask"],
      ["Edit", "ask"],
      ["Write", "ask"],
      ["WebFetch", "ask"],
      ["WebSearch", "ask"],
    ]);
    expect(toolAccessRows("codex", undefined, [])).toEqual([
      {
        key: CODEX_COMMAND_TOOL,
        label: "Commands",
        detail: "Shell commands",
        choice: "ask",
      },
      {
        key: CODEX_FILE_CHANGE_TOOL,
        label: "File edits",
        detail: "Patches to files",
        choice: "ask",
      },
    ]);
  });

  it("adds the tools the chat has used or been asked about", () => {
    expect(seenToolKeys(blocks, "claude").sort()).toEqual([
      "NotebookEdit",
      "mcp__exa__web_search",
    ]);
    const rows = toolAccessRows("claude", { Bash: "never" }, blocks);
    expect(rows.slice(5)).toEqual([
      {
        key: "mcp__exa__web_search",
        label: "exa: web_search",
        detail: "MCP tool",
        choice: "ask",
      },
      {
        key: "NotebookEdit",
        label: "NotebookEdit",
        detail: "Tool",
        choice: "ask",
      },
    ]);
    expect(rows[0]).toMatchObject({ key: "Bash", choice: "never" });
  });

  it("adds every tool with a rule, met in the transcript or not", () => {
    const rows = toolAccessRows("claude", { mcp__docs__read: "always" }, []);
    expect(rows.at(-1)).toEqual({
      key: "mcp__docs__read",
      label: "docs: read",
      detail: "MCP tool",
      choice: "always",
    });
  });

  it("offers Codex no rule for tools it cannot answer for", () => {
    // The MCP call and the Claude Code tool name mean nothing to Codex.
    expect(seenToolKeys(blocks, "codex")).toEqual([]);
    expect(toolAccessRows("codex", undefined, blocks)).toHaveLength(2);
  });

  it("keeps a rule set under another provider in view, marked", () => {
    const rules: ToolAccess = { Bash: "always", [CODEX_COMMAND_TOOL]: "never" };
    expect(toolAccessRows("claude", rules, []).at(-1)).toEqual({
      key: CODEX_COMMAND_TOOL,
      label: "Commands",
      detail: "Only applies on Codex",
      choice: "never",
      inactive: true,
    });
    expect(toolAccessRows("codex", rules, []).at(-1)).toEqual({
      key: "Bash",
      label: "Bash",
      detail: "Only applies on Claude Code",
      choice: "always",
      inactive: true,
    });
  });
});

describe("toolAccessCaveats", () => {
  it("always says what never cannot do on Codex", () => {
    expect(toolAccessCaveats("codex", undefined)).toEqual([
      "Never declines when Codex asks. Codex runs safe commands without asking.",
    ]);
    expect(
      toolAccessCaveats("codex", { always: [CODEX_COMMAND_TOOL] })[1],
    ).toContain("A command that asks to leave the sandbox still asks");
  });

  it("speaks up on Claude Code only for the rules that are set", () => {
    expect(toolAccessCaveats("claude", undefined)).toEqual([]);
    expect(toolAccessCaveats("claude", { always: ["Bash"] })).toEqual([
      "Always is not used in plan turns. They stay read-only.",
    ]);
    expect(toolAccessCaveats("claude", { never: ["Bash"] })[0]).toContain(
      "when the next turn starts",
    );
    expect(toolAccessCaveats("cursor", { never: ["Bash"] })).toEqual([]);
  });
});
