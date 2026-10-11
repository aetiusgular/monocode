import { describe, expect, it } from "vitest";
import {
  buildClaudeSpawnArgs,
  claudeGatewayMcpConfig,
  claudeSettingsKey,
} from "./claudeProtocol";

const notion = {
  name: "notion-remote",
  command: "/usr/local/bin/docker",
  args: ["mcp", "gateway", "run", "--profile", "monocode_notion_remote"],
};
const hf = {
  name: "hugging-face",
  command: "/usr/local/bin/docker",
  args: ["mcp", "gateway", "run", "--profile", "monocode_hugging_face"],
};

describe("Docker gateway connectors for Claude Code", () => {
  it("builds one stdio server per connector", () => {
    expect(JSON.parse(claudeGatewayMcpConfig([notion, hf])!)).toEqual({
      mcpServers: {
        "notion-remote": {
          type: "stdio",
          command: "/usr/local/bin/docker",
          args: [
            "mcp",
            "gateway",
            "run",
            "--profile",
            "monocode_notion_remote",
          ],
        },
        "hugging-face": {
          type: "stdio",
          command: "/usr/local/bin/docker",
          args: ["mcp", "gateway", "run", "--profile", "monocode_hugging_face"],
        },
      },
    });
    expect(claudeGatewayMcpConfig([])).toBeNull();
    expect(
      claudeGatewayMcpConfig([{ ...notion, name: "claude.ai Notion" }]),
    ).toBeNull();
  });

  it("adds them with --mcp-config beside the user's servers", () => {
    const args = buildClaudeSpawnArgs({
      sessionId: "s1",
      gatewayConnectors: [notion],
    });
    const at = args.indexOf("--mcp-config");
    expect(at).toBeGreaterThan(-1);
    expect(JSON.parse(args[at + 1]).mcpServers).toHaveProperty("notion-remote");
    // A variadic flag: the next argument is another flag.
    expect(args[at + 2]).toMatch(/^--/);
    expect(args).not.toContain("--strict-mcp-config");
    expect(args.filter((arg) => arg === "--mcp-config")).toHaveLength(1);
  });

  it("leaves them out of isolated helper calls and plain sessions", () => {
    const isolated = buildClaudeSpawnArgs({
      isolated: true,
      gatewayConnectors: [notion],
    });
    expect(isolated.join(" ")).not.toContain("notion-remote");
    expect(buildClaudeSpawnArgs({ sessionId: "s1" })).not.toContain(
      "--mcp-config",
    );
  });

  it("restarts the process when the set changes, not when it is reordered", () => {
    const key = (gatewayConnectors?: (typeof notion)[]) =>
      claudeSettingsKey({
        model: "claude-sonnet-4-6",
        runtimeMode: "supervised",
        gatewayConnectors,
      });
    expect(key([notion, hf])).toBe(key([hf, notion]));
    expect(key([notion])).not.toBe(key([notion, hf]));
    expect(key([])).toBe(key(undefined));
    expect(key([notion])).not.toBe(key(undefined));
  });
});
