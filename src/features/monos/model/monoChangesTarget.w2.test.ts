// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ask, commit } = vi.hoisted(() => ({
  ask: vi.fn(async (_message: string, _options?: unknown) => false),
  commit: vi.fn(async () => "OLD PATH"),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));
vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: () => true,
}));
vi.mock("../../../platform/tauri/fs", () => ({
  gitStagedContext: vi.fn(async () => ({
    branch: "main",
    summary: "secret.txt | 1 +",
    patch: "STAGED_DIFF_OF_THE_LOCAL_CHAT",
  })),
  gitRangeContext: vi.fn(),
}));

import {
  setCheckoutSessionsSource,
  type CheckoutSession,
} from "../../../integrations/harness/core/helperPrompt";
import {
  generateCommitMessage,
  UNOWNED_REFUSED,
} from "../../../integrations/harness/core/textHarness";
import {
  registerHarness,
  type HarnessAdapter,
  type TextPromptInput,
} from "../../../integrations/harness/core/registry";
import { setHarnessModels } from "../../sessions/model/models";
import { monoChangesTextTarget } from "./monoChangesTarget";

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
      return JSON.stringify({ subject: "Update the file", body: "" });
    },
  } as HarnessAdapter;
}

// The reviewer's case: Mono "Ops" on Claude (hosted) with secret-proj
// attached, where you work in a local Codex chat.
const mono: CheckoutSession = {
  id: "mono-ops",
  harness: "claude",
  model: "claude:sonnet-5",
  modelSettings: {},
  cwd: "/Users/t/ops",
  blocks: [{ id: "m", role: "user", text: "check the build", startedAt: 9_000 }],
};
const localCodex: CheckoutSession = {
  id: "codex-local",
  harness: "codex",
  model: "codex:qwen2.5:7b",
  modelSettings: {},
  cwd: "/Users/t/secret-proj",
  providerAccountId: "local-home",
  modelProvider: "ollama",
  providerSessionId: "thr_1",
  blocks: [{ id: "u", role: "user", text: "edit secret.txt", startedAt: 1_000 }],
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
  setCheckoutSessionsSource(() => [mono, localCodex]);
});

describe("security review K2: a Mono's Changes tab follows each checkout's owner", () => {
  it("is a bare harness id, never a route that skips the owner lookup", () => {
    expect(monoChangesTextTarget(mono)).toBe("claude");
  });

  it("an attached project a local chat works in goes to that chat, not the hosted Mono", async () => {
    await expect(
      generateCommitMessage("/Users/t/secret-proj", monoChangesTextTarget(mono)),
    ).resolves.toBe("Update the file");
    expect(sent.claude).toBeUndefined();
    expect(sent.codex).toHaveLength(1);
    expect(sent.codex[0].prompt).toContain("STAGED_DIFF_OF_THE_LOCAL_CHAT");
    expect(ask).not.toHaveBeenCalled();
  });

  it("a project no chat works in asks first, and sends nothing on no", async () => {
    await expect(
      generateCommitMessage("/Users/t/other-proj", monoChangesTextTarget(mono)),
    ).rejects.toThrow(UNOWNED_REFUSED);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(sent.claude).toBeUndefined();
    expect(sent.codex).toBeUndefined();
  });

  it("the Mono's own checkout, with no other chat there, goes to the Mono", async () => {
    await expect(
      generateCommitMessage("/Users/t/ops", monoChangesTextTarget(mono)),
    ).resolves.toBe("Update the file");
    expect(sent.claude).toHaveLength(1);
    expect(ask).not.toHaveBeenCalled();
  });
});
