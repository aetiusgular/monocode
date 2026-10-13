// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ask, commit } = vi.hoisted(() => ({
  ask: vi.fn(async (_message: string, _options?: unknown) => false),
  commit: vi.fn(async () => "OLD PATH"),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));
vi.mock("./availability", () => ({ isHarnessAvailable: () => true }));
vi.mock("../../../platform/tauri/fs", () => ({
  gitStagedContext: vi.fn(async () => ({
    branch: "main",
    summary: "a.txt | 1 +\nb.txt | 1 +",
    patch: "STAGED_AND_UNSTAGED_DIFF",
  })),
  gitRangeContext: vi.fn(),
}));

import {
  checkoutOwner,
  helperRouteForCheckout,
  setCheckoutSessionsSource,
  type CheckoutSession,
} from "./helperPrompt";
import {
  generateCommitMessage,
  MIXED_REFUSED,
  UNOWNED_REFUSED,
} from "./textHarness";
import {
  registerHarness,
  type HarnessAdapter,
  type TextPromptInput,
} from "./registry";
import { setHarnessModels } from "../../../features/sessions/model/models";

const sent: Record<string, TextPromptInput[]> = {};
function adapter(id: "claude" | "codex"): HarnessAdapter {
  return {
    id,
    live: true,
    sendTurn: async () => {},
    steerTurn: async () => {},
    cancelTurn: async () => {},
    respondApproval: () => {},
    stopSession: async () => {},
    generateCommitMessage: commit,
    runTextPrompt: async (input: TextPromptInput) => {
      (sent[id] ??= []).push(input);
      return JSON.stringify({ subject: "Update two files", body: "" });
    },
  } as HarnessAdapter;
}

// The 4.2 setup in ~/s7-gen: a local Codex chat that ran a turn there, and a
// new Claude Code chat, never used, as the active tab.
const usedCodex: CheckoutSession = {
  id: "codex-local",
  harness: "codex",
  model: "codex:qwen2.5:7b",
  modelSettings: {},
  cwd: "/Users/t/s7-gen",
  providerAccountId: "local-home",
  modelProvider: "ollama",
  providerSessionId: "thr_1",
  blocks: [{ id: "u", role: "user", text: "add a line", startedAt: 1_000 }],
};
const blankClaude: CheckoutSession = {
  id: "claude-new",
  harness: "claude",
  model: "claude:sonnet-5",
  modelSettings: {},
  cwd: "/Users/t/s7-gen",
  blocks: [],
};

beforeEach(() => {
  localStorage.clear();
  ask.mockReset();
  ask.mockResolvedValue(false);
  commit.mockClear();
  for (const key of Object.keys(sent)) delete sent[key];
  registerHarness(adapter("claude"));
  registerHarness(adapter("codex"));
  setHarnessModels("codex", []);
  setCheckoutSessionsSource(null);
});

describe("checkout owner (Mac finding 4.2, corner case 7)", () => {
  it("picks the used local Codex chat over a blank active Claude Code tab", () => {
    const route = helperRouteForCheckout(
      [usedCodex, blankClaude],
      "/Users/t/s7-gen/",
      blankClaude,
    );
    expect(route?.harness).toBe("codex");
    expect(route?.sessionId).toBe("codex-local");
  });

  it("picks the most recently used chat; the active tab only breaks ties", () => {
    const older = {
      ...usedCodex,
      id: "older",
      blocks: [{ id: "a", role: "user" as const, text: "x", startedAt: 10 }],
    };
    const newer = {
      ...usedCodex,
      id: "newer",
      blocks: [{ id: "b", role: "user" as const, text: "y", startedAt: 20 }],
    };
    expect(
      helperRouteForCheckout([older, newer], "/Users/t/s7-gen", older)
        ?.sessionId,
    ).toBe("newer");
    const tie = {
      ...older,
      id: "tie",
      blocks: [{ id: "c", role: "user" as const, text: "z", startedAt: 20 }],
    };
    expect(
      helperRouteForCheckout([newer, tie], "/Users/t/s7-gen", tie)?.sessionId,
    ).toBe("tie");
  });

  it("prefers a local chat when used chats differ in harness or locality", () => {
    const usedClaude = {
      ...blankClaude,
      id: "claude-used",
      blocks: [
        { id: "c", role: "user" as const, text: "later", startedAt: 5_000 },
      ],
    };
    const owner = checkoutOwner(
      [usedCodex, usedClaude],
      "/Users/t/s7-gen",
      usedClaude,
      (s) => s.harness === "codex",
    );
    expect(owner).toEqual({
      kind: "owner",
      route: expect.objectContaining({ sessionId: "codex-local" }),
    });
  });

  it("asks when used chats differ and none is local", () => {
    const usedClaude = {
      ...blankClaude,
      id: "claude-used",
      blocks: [
        { id: "c", role: "user" as const, text: "later", startedAt: 5_000 },
      ],
    };
    const owner = checkoutOwner(
      [usedCodex, usedClaude],
      "/Users/t/s7-gen",
      null,
      () => false,
    );
    expect(owner?.kind).toBe("ask");
    expect(owner?.route.sessionId).toBe("claude-used");
    expect(
      helperRouteForCheckout([usedCodex, usedClaude], "/Users/t/s7-gen", null),
    ).toBeDefined();
  });

  it("ignores a used chat in another folder and a blank chat in this one", () => {
    const elsewhere = { ...usedCodex, id: "elsewhere", cwd: "/Users/t/other" };
    expect(
      checkoutOwner([elsewhere, blankClaude], "/Users/t/s7-gen", blankClaude),
    ).toBeUndefined();
  });
});

describe("Generate in the 4.2 scenario", () => {
  it("a bare Claude Code id (the blank tab's Generate) goes to the used Codex chat, with no dialog", async () => {
    setCheckoutSessionsSource(() => [blankClaude, usedCodex]);
    await expect(
      generateCommitMessage("/Users/t/s7-gen", "claude"),
    ).resolves.toBe("Update two files");
    expect(ask).not.toHaveBeenCalled();
    expect(sent.claude).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    expect(sent.codex).toHaveLength(1);
    expect(sent.codex[0].providerAccountId).toBe("local-home");
    expect(sent.codex[0].prompt).toContain("STAGED_AND_UNSTAGED_DIFF");
  });

  it("a blank checkout with no used chat still asks, and sends nothing on no", async () => {
    setCheckoutSessionsSource(() => [blankClaude]);
    await expect(
      generateCommitMessage("/Users/t/s7-gen", "claude"),
    ).rejects.toThrow(UNOWNED_REFUSED);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(sent.claude).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
  });

  it("two used hosted-or-unknown chats on different harnesses ask first", async () => {
    const codexUnknown = {
      ...usedCodex,
      modelProvider: undefined,
      providerAccountId: "default",
    };
    const usedClaude = {
      ...blankClaude,
      blocks: [
        { id: "c", role: "user" as const, text: "later", startedAt: 5_000 },
      ],
    };
    setCheckoutSessionsSource(() => [codexUnknown, usedClaude]);
    await expect(
      generateCommitMessage("/Users/t/s7-gen", "claude"),
    ).rejects.toThrow(MIXED_REFUSED);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(String(ask.mock.calls[0][0])).toMatch(/different agents/);
    expect(sent.claude).toBeUndefined();
    expect(sent.codex).toBeUndefined();
  });
});
