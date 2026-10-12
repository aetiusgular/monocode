import { describe, expect, it } from "vitest";
import {
  agentsMdPluginConfig,
  agentsMdPluginId,
  instructionParts,
  parseCliVersion,
} from "./instructions";

describe("#27: instructions", () => {
  it("turns global text and private notes into preamble parts", () => {
    expect(instructionParts("  Be brief. ", "Notes")).toEqual([
      { id: "instructions", label: "Your instructions", text: "Be brief." },
      { id: "project-notes", label: "Private project notes", text: "Notes" },
    ]);
    expect(instructionParts("", null)).toEqual([]);
    expect(instructionParts(undefined, "  ")).toEqual([]);
  });

  it("picks the AGENTS.md plugin id from the Claude Code version", () => {
    expect(parseCliVersion("2.1.300 (Claude Code)")).toEqual([2, 1, 300]);
    expect(agentsMdPluginId("2.1.276 (Claude Code)")).toBeUndefined();
    expect(agentsMdPluginId("2.1.277 (Claude Code)")).toBe("agents-md@builtin");
    expect(agentsMdPluginId("2.1.284")).toBe("agents-md@builtin");
    expect(agentsMdPluginId("2.1.285")).toBe("cc-plugin-agents-md@builtin");
    expect(agentsMdPluginId("2.2.0")).toBe("cc-plugin-agents-md@builtin");
    expect(agentsMdPluginId("3.0.0")).toBe("cc-plugin-agents-md@builtin");
    expect(agentsMdPluginId("1.9.999")).toBeUndefined();
    // Unknown version: leave the setting out.
    expect(agentsMdPluginId(undefined)).toBeUndefined();
    expect(agentsMdPluginId("garbage")).toBeUndefined();
  });

  it("builds the documented setting, and nothing for an id it does not know", () => {
    expect(agentsMdPluginConfig("cc-plugin-agents-md@builtin")).toEqual({
      "cc-plugin-agents-md@builtin": {
        options: { instructionFiles: "claude-md-and-agents-md" },
      },
    });
    expect(agentsMdPluginConfig("evil@builtin")).toBeUndefined();
    expect(agentsMdPluginConfig(undefined)).toBeUndefined();
  });
});
