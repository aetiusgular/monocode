import { describe, expect, it } from "vitest";
import { commandRuleGate, type RuleGateInvoke } from "./commandRuleGate";

const answering =
  (value: unknown): RuleGateInvoke =>
  async <T>() => {
    if (value instanceof Error) throw value;
    return value as T;
  };

describe("command rule gate: git (R2)", () => {
  it("lets a git rule answer only on a plain false", async () => {
    expect(
      await commandRuleGate("Bash(git log *)", "/repo", answering(false)),
    ).toEqual({ allow: true });
    for (const value of [true, "false", null, undefined, new Error("x")]) {
      expect(
        await commandRuleGate("Bash(git log *)", "/repo", answering(value)),
      ).toEqual({ allow: false, reason: "git-config" });
    }
  });

  it("checks exact git rules and compound ones that name git", async () => {
    for (const key of [
      "Bash(git status)",
      "Bash(cd sub && git status)",
      "Bash(echo x; git log)",
    ]) {
      expect(await commandRuleGate(key, "/repo", answering(true))).toEqual({
        allow: false,
        reason: "git-config",
      });
    }
  });

  it("asks nothing for a rule that does not name git", async () => {
    const never: RuleGateInvoke = async () => {
      throw new Error("not called");
    };
    expect(await commandRuleGate("Bash(seq 1 3)", "/repo", never)).toEqual({
      allow: true,
    });
    expect(await commandRuleGate("Bash(gitk)", "/repo", never)).toEqual({
      allow: true,
    });
  });

  it("refuses a key that holds no rule and a missing folder", async () => {
    expect(await commandRuleGate("Bash", "/repo", answering(false))).toEqual({
      allow: false,
      reason: "unreadable",
    });
    expect(
      await commandRuleGate("Bash(git log *)", "", answering(false)),
    ).toEqual({ allow: false, reason: "git-config" });
  });
});
