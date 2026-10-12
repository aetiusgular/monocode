import { describe, expect, it } from "vitest";
import { buildClaudeSpawnArgs } from "./claudeProtocol";

function settingsOf(args: string[]): Record<string, unknown> {
  const index = args.lastIndexOf("--settings");
  return JSON.parse(args[index + 1]);
}

describe("F2 and #27 in Claude Code's launch", () => {
  it("passes the preamble file on a new conversation", () => {
    const args = buildClaudeSpawnArgs({
      sessionId: "c1",
      appendSystemPromptFile: "/data/context/preamble/s1.md",
    });
    const at = args.indexOf("--append-system-prompt-file");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("/data/context/preamble/s1.md");
  });

  it("never on a resumed conversation or a helper call", () => {
    expect(
      buildClaudeSpawnArgs({
        resume: "c1",
        appendSystemPromptFile: "/x.md",
      }),
    ).not.toContain("--append-system-prompt-file");
    expect(
      buildClaudeSpawnArgs({
        isolated: true,
        appendSystemPromptFile: "/x.md",
      }),
    ).not.toContain("--append-system-prompt-file");
  });

  it("keeps the file path one argument, whatever it holds (security item 3)", () => {
    const path = "/Users/a b/--model x; rm -rf ~.md";
    const args = buildClaudeSpawnArgs({ appendSystemPromptFile: path });
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe(path);
  });

  it("puts the AGENTS.md plugin option in --settings", () => {
    const args = buildClaudeSpawnArgs({
      settings: {
        pluginConfigs: {
          "cc-plugin-agents-md@builtin": {
            options: { instructionFiles: "claude-md-and-agents-md" },
          },
        },
      },
    });
    expect(settingsOf(args).pluginConfigs).toEqual({
      "cc-plugin-agents-md@builtin": {
        options: { instructionFiles: "claude-md-and-agents-md" },
      },
    });
  });
});
