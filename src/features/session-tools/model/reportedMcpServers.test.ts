// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  __reloadSavedMcpServers,
  __resetReportedMcpServers,
  noteAccountMcpServers,
  noteReportedMcpServers,
  reportedMcpServers,
  sanitizeReportedMcpServers,
} from "./reportedMcpServers";
import { withReportedConnectorRows, type ConnectorRow } from "./connectors";
import { initMcpServers } from "../../../integrations/harness/providers/claude/claudeProtocol";
import { claudeMcpServerDenyRule } from "../../../integrations/harness/providers/claude/claudeProtocol";

beforeEach(() => __resetReportedMcpServers());

describe("initMcpServers", () => {
  it("reads the servers a system/init message lists", () => {
    expect(
      initMcpServers({
        type: "system",
        subtype: "init",
        mcp_servers: [
          { name: "claude.ai Exa", status: "connected" },
          { name: "MCP_DOCKER", status: "connected" },
        ],
      }),
    ).toEqual([
      { name: "claude.ai Exa", status: "connected" },
      { name: "MCP_DOCKER", status: "connected" },
    ]);
  });

  it("is null for other messages or a message without a list", () => {
    expect(initMcpServers({ type: "system", subtype: "init" })).toBeNull();
    expect(
      initMcpServers({ type: "system", subtype: "status", mcp_servers: [] }),
    ).toBeNull();
    expect(initMcpServers({ type: "assistant", mcp_servers: [] })).toBeNull();
  });
});

describe("sanitizeReportedMcpServers", () => {
  it("keeps one entry per name and fills a missing status", () => {
    expect(
      sanitizeReportedMcpServers([
        { name: " a ", status: "connected" },
        { name: "a", status: "failed" },
        { name: "b" },
        { status: "connected" },
        "c",
        null,
      ]),
    ).toEqual([
      { name: "a", status: "connected" },
      { name: "b", status: "unknown" },
    ]);
  });
});

describe("reportedMcpServers", () => {
  it("merges the account's list with the chat's own", () => {
    noteAccountMcpServers("work", [
      { name: "claude.ai Exa", status: "connected" },
      { name: "claude.ai Gmail", status: "pending" },
    ]);
    noteReportedMcpServers("chat-1", [
      { name: "claude.ai Exa", status: "pending" },
      { name: "claude.ai Gmail", status: "connected" },
      { name: "MCP_DOCKER", status: "pending" },
    ]);
    expect(reportedMcpServers("chat-1", "work")).toEqual([
      { name: "claude.ai Exa", status: "connected" },
      { name: "claude.ai Gmail", status: "connected" },
      { name: "MCP_DOCKER", status: "pending" },
    ]);
    expect(reportedMcpServers("chat-2", "work")).toEqual([
      { name: "claude.ai Exa", status: "connected" },
      { name: "claude.ai Gmail", status: "pending" },
    ]);
    expect(reportedMcpServers("chat-2", "home")).toBeNull();
    expect(reportedMcpServers(undefined, undefined)).toBeNull();
  });

  it("returns the same array until something changes", () => {
    noteAccountMcpServers(undefined, [{ name: "x", status: "connected" }]);
    const first = reportedMcpServers("chat-1");
    expect(reportedMcpServers("chat-1")).toBe(first);
    noteReportedMcpServers("chat-1", [{ name: "y", status: "connected" }]);
    expect(reportedMcpServers("chat-1")).not.toBe(first);
  });

  it("keeps the account's list across a restart, as not yet connected", () => {
    noteAccountMcpServers(undefined, [
      { name: "claude.ai Exa", status: "connected" },
      { name: "claude.ai Slack", status: "needs-auth" },
    ]);
    __reloadSavedMcpServers();
    expect(reportedMcpServers(undefined)).toEqual([
      { name: "claude.ai Exa", status: "saved" },
      { name: "claude.ai Slack", status: "needs-auth" },
    ]);
  });
});

describe("withReportedConnectorRows", () => {
  const configured: ConnectorRow[] = [
    { name: "docs", detail: "user · stdio", enabled: true },
    {
      name: "claude.ai Exa",
      detail: "Not configured for Claude Code",
      enabled: false,
      missing: true,
    },
    { name: "gone", detail: "Not configured", enabled: false, missing: true },
  ];

  it("adds connected and still-connecting servers after the configured ones", () => {
    const rows = withReportedConnectorRows(
      configured.slice(0, 1),
      [
        { name: "docs", status: "connected" },
        { name: "plugin:x:y", status: "connected" },
        { name: "claude.ai Gmail", status: "connected" },
        { name: "plugin:sales:gong", status: "needs-auth" },
        { name: "broken", status: "failed" },
        { name: "claude.ai Exa", status: "pending" },
      ],
      [],
    );
    expect(rows.map((row) => [row.name, row.detail])).toEqual([
      ["docs", "user · stdio"],
      ["claude.ai Exa", "claude.ai account"],
      ["claude.ai Gmail", "claude.ai account"],
      ["plugin:x:y", "Claude Code plugin"],
    ]);
  });

  it("replaces the not-configured row of a switched-off server it reported", () => {
    const rows = withReportedConnectorRows(
      configured,
      [{ name: "claude.ai Exa", status: "connected" }],
      ["claude.ai Exa", "gone"],
    );
    expect(rows).toEqual([
      { name: "docs", detail: "user · stdio", enabled: true },
      {
        name: "claude.ai Exa",
        detail: "claude.ai account",
        enabled: false,
      },
      { name: "gone", detail: "Not configured", enabled: false, missing: true },
    ]);
  });

  it("keeps a switched-off server listed whatever its status", () => {
    const rows = withReportedConnectorRows(
      [],
      [{ name: "plugin:a:b", status: "failed" }],
      ["plugin:a:b"],
    );
    expect(rows).toEqual([
      {
        name: "plugin:a:b",
        detail: "Claude Code plugin · failed to connect",
        enabled: false,
      },
    ]);
  });

  it("lists every claude.ai connector, saying when one needs a sign-in", () => {
    const rows = withReportedConnectorRows(
      [],
      [
        { name: "claude.ai Slack", status: "needs-auth" },
        { name: "claude.ai Exa", status: "saved" },
        { name: "plugin:sales:gong", status: "needs-auth" },
      ],
      [],
    );
    expect(rows.map((row) => [row.name, row.detail, row.enabled])).toEqual([
      ["claude.ai Exa", "claude.ai account", true],
      ["claude.ai Slack", "claude.ai account · needs sign-in", true],
    ]);
  });

  it("returns the rows unchanged with nothing reported", () => {
    expect(withReportedConnectorRows(configured, null, [])).toEqual(configured);
  });
});

describe("deny rules for reported servers", () => {
  it("match the tool prefixes Claude Code gives them", () => {
    // Seen in a real Claude Code 2.1.292 session on 10 Oct 2026.
    expect(claudeMcpServerDenyRule("claude.ai Exa")).toBe("mcp__claude_ai_Exa");
    expect(
      claudeMcpServerDenyRule("plugin:desktop-commander:desktop-commander"),
    ).toBe("mcp__plugin_desktop-commander_desktop-commander");
  });
});
