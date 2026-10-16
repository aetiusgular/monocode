import { describe, expect, it } from "vitest";
import {
  chatRuleOffered,
  commandRuleGate,
  type RuleGateInvoke,
} from "./commandRuleGate";

// Mac test 10.1 (15 Oct): in a repository whose own git config names a
// command, the card offered "Allow git show in this chat", but the gate
// refuses git rules there, so pressing it changed nothing.

const answering = (value: unknown) => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const call: RuleGateInvoke = async <T>(
    command: string,
    args: Record<string, unknown>,
  ) => {
    calls.push([command, args]);
    if (value instanceof Error) throw value;
    return value as T;
  };
  return { call, calls };
};

describe("which rules a command card offers", () => {
  it("offers a git rule in a plain repository", async () => {
    const { call, calls } = answering(false);
    expect(await chatRuleOffered("Bash(git show *)", "/repo", call)).toBe(true);
    expect(calls).toEqual([["git_repo_names_commands", { cwd: "/repo" }]]);
  });

  it("offers no git rule where the repository's config names a command", async () => {
    const { call } = answering(true);
    for (const key of [
      "Bash(git show *)",
      "Bash(git status)",
      "Bash(cd sub && git status)",
    ]) {
      expect(await chatRuleOffered(key, "/repo", call)).toBe(false);
    }
  });

  it("agrees with the gate on every answer, failures included", async () => {
    for (const value of [false, true, "false", null, new Error("no git")]) {
      const offered = await chatRuleOffered(
        "Bash(git log *)",
        "/repo",
        answering(value).call,
      );
      const gate = await commandRuleGate(
        "Bash(git log *)",
        "/repo",
        answering(value).call,
      );
      expect(offered).toBe(gate.allow);
    }
    expect(
      await chatRuleOffered("Bash(git log *)", "", answering(false).call),
    ).toBe(false);
  });

  it("offers other commands' rules at once, with no check", () => {
    const { call, calls } = answering(true);
    for (const key of [
      "Bash(npm test *)",
      "Bash(python3 -m pytest *)",
      "Bash(ls -la)",
      "Bash(cargo fmt *)",
    ]) {
      // Not a promise: a card for these does not wait.
      expect(chatRuleOffered(key, "/repo", call)).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});
