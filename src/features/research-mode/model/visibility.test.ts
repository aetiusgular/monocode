import { describe, expect, it } from "vitest";
import { researchTools } from "./searchTools";
import {
  harnessSupportsResearch,
  researchMenuState,
  sendsAsResearch,
} from "./visibility";

const claudeTools = researchTools({ harness: "claude" });

describe("researchMenuState", () => {
  it("is ready for Claude Code with its built-in search", () => {
    expect(
      researchMenuState({
        harness: "claude",
        remote: false,
        tools: claudeTools,
      }),
    ).toBe("ready");
  });

  it("shows the no-search note when the chat has no search tool", () => {
    expect(
      researchMenuState({ harness: "codex", remote: false, tools: [] }),
    ).toBe("no-search");
  });

  it("hides on host sessions and on harnesses it cannot wrap", () => {
    expect(
      researchMenuState({
        harness: "claude",
        remote: true,
        tools: claudeTools,
      }),
    ).toBe("hidden");
    for (const harness of ["cursor", "opencode", "grok", "fx"] as const) {
      expect(harnessSupportsResearch(harness)).toBe(false);
      expect(
        researchMenuState({ harness, remote: false, tools: claudeTools }),
      ).toBe("hidden");
    }
  });
});

describe("sendsAsResearch", () => {
  it("needs research on, a search tool and a plain turn", () => {
    expect(
      sendsAsResearch({ selected: true, state: "ready", intent: "default" }),
    ).toBe(true);
    expect(
      sendsAsResearch({ selected: false, state: "ready", intent: "default" }),
    ).toBe(false);
    expect(
      sendsAsResearch({
        selected: true,
        state: "no-search",
        intent: "default",
      }),
    ).toBe(false);
    expect(
      sendsAsResearch({ selected: true, state: "ready", intent: "plan" }),
    ).toBe(false);
    expect(
      sendsAsResearch({
        selected: true,
        state: "ready",
        intent: "orchestrate",
      }),
    ).toBe(false);
  });
});
