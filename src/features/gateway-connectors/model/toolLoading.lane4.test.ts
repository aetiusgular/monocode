// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeSpawnArgs,
  claudeSettingsKey,
} from "../../../integrations/harness/providers/claude/claudeProtocol";
import {
  loadClaudeToolLoading,
  readToolLoading,
  saveToolLoading,
} from "./toolLoading";

const settingsOf = (args: string[]) =>
  JSON.parse(args[args.indexOf("--settings") + 1]) as {
    env: Record<string, string>;
  };

beforeEach(() => localStorage.clear());

describe("Claude Code tool loading", () => {
  it("leaves ENABLE_TOOL_SEARCH alone by default", () => {
    expect(readToolLoading()).toBe("default");
    expect(loadClaudeToolLoading()).toBeUndefined();
    const env = settingsOf(buildClaudeSpawnArgs({})).env;
    expect(env).not.toHaveProperty("ENABLE_TOOL_SEARCH");
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
  });

  it("passes auto and up front through the --settings env", () => {
    saveToolLoading("upfront");
    expect(loadClaudeToolLoading()).toBe("upfront");
    expect(
      settingsOf(buildClaudeSpawnArgs({ toolLoading: "upfront" })).env,
    ).toMatchObject({
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
    });
    saveToolLoading("auto");
    expect(
      settingsOf(buildClaudeSpawnArgs({ toolLoading: "auto" })).env
        .ENABLE_TOOL_SEARCH,
    ).toBe("auto");
    saveToolLoading("default");
    expect(localStorage.length).toBe(0);
  });

  it("never reaches MonoCode's own helper calls", () => {
    const args = buildClaudeSpawnArgs({
      isolated: true,
      toolLoading: "upfront",
    });
    expect(args.join(" ")).not.toContain("ENABLE_TOOL_SEARCH");
  });

  it("restarts a chat's process when the choice changes", () => {
    const base = { model: "sonnet", runtimeMode: "supervised" as const };
    const plain = claudeSettingsKey(base);
    expect(claudeSettingsKey({ ...base, toolLoading: undefined })).toBe(plain);
    expect(claudeSettingsKey({ ...base, toolLoading: "upfront" })).not.toBe(
      plain,
    );
    expect(claudeSettingsKey({ ...base, toolLoading: "auto" })).not.toBe(
      claudeSettingsKey({ ...base, toolLoading: "upfront" }),
    );
  });

  it("reads anything unknown as the default", () => {
    localStorage.setItem("monocode.claudeToolLoading.v1", "everything");
    expect(readToolLoading()).toBe("default");
  });
});
