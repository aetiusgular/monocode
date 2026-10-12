import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { stagedContext, rangeContext } = vi.hoisted(() => ({
  stagedContext: vi.fn(async (_cwd: string, _paths?: readonly string[]) => ({
    branch: "feature",
    summary: "a.txt | 1 +",
    patch: "LOCAL_ONLY_DIFF",
  })),
  rangeContext: vi.fn(async (_cwd: string) => ({
    base: "main",
    head: "feature",
    commitSummary: "abc123 Add the thing\ndef456 Fix the thing",
    diffSummary: "a.txt | 1 +",
    diffPatch: "LOCAL_ONLY_DIFF",
  })),
}));
// This project already agreed to send changes to a helper harness (F3).
vi.mock("../../../features/code-review/model/reviewConsent", () => ({
  reviewConsented: () => true,
  recordReviewConsent: vi.fn(),
}));
vi.mock("../../../platform/tauri/fs", () => ({
  gitStagedContext: stagedContext,
  gitRangeContext: rangeContext,
}));
vi.mock("./availability", () => ({ isHarnessAvailable: () => true }));

import {
  canRunHelper,
  GIT_TIMEOUT_MS,
  helperBranchName,
  helperCommitMessage,
  helperPrContent,
  helperRouteForCheckout,
  helperRouteForSession,
  helperTimeoutMs,
  helperTitle,
  HelperUnavailableError,
  isHelperRoute,
  pickHelperModel,
  type HelperRoute,
} from "./helperPrompt";
import {
  generateCommitMessage,
  generatePrContent,
  pickTextHarness,
} from "./textHarness";
import {
  registerHarness,
  type HarnessAdapter,
  type TextPromptInput,
} from "./registry";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
  type AgentModel,
} from "../../../features/sessions/model/models";
import { resetTraitOverridesCache } from "../../../features/model-traits/model/modelTraits";
import type { HarnessId } from "../../../features/sessions/model/session";

const LOCAL_QWEN: AgentModel = {
  id: "codex:qwen2.5:7b",
  harness: "codex",
  name: "qwen2.5:7b",
  nativeId: "qwen2.5:7b",
};
const LUNA: AgentModel = {
  id: "codex:gpt-5.6-luna",
  harness: "codex",
  name: "GPT-5.6 Luna",
  nativeId: "gpt-5.6-luna",
};

type Calls = Record<string, TextPromptInput[]>;
let calls: Calls = {};
let reply: (input: TextPromptInput) => Promise<string>;

function fakeAdapter(id: HarnessId, withText = true): HarnessAdapter {
  return {
    id,
    live: true,
    sendTurn: async () => {},
    steerTurn: async () => {},
    cancelTurn: async () => {},
    respondApproval: () => {},
    stopSession: async () => {},
    generateCommitMessage: async () => "OLD PATH",
    ...(withText
      ? {
          runTextPrompt: async (input: TextPromptInput) => {
            (calls[id] ??= []).push(input);
            return reply(input);
          },
        }
      : {}),
  } as HarnessAdapter;
}

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
    configurable: true,
  });
}

const localCodex: HelperRoute = {
  kind: "route",
  harness: "codex",
  providerAccountId: "local-home",
  modelId: "codex:qwen2.5:7b",
};

beforeEach(() => {
  mockLocalStorage();
  resetTraitOverridesCache();
  resetHarnessModelOverlays();
  calls = {};
  reply = async () =>
    JSON.stringify({ subject: "Update a.txt", body: "" });
  for (const id of ["claude", "codex", "cursor", "grok", "opencode"] as const) {
    registerHarness(fakeAdapter(id));
  }
  registerHarness(fakeAdapter("fx", false));
});
afterEach(() => {
  resetHarnessModelOverlays();
  resetTraitOverridesCache();
  vi.clearAllMocks();
});

describe("pickHelperModel", () => {
  it("uses the cheap model when the live Codex catalog lists it", () => {
    setHarnessModels("codex", [LUNA, LOCAL_QWEN]);
    expect(pickHelperModel(localCodex)).toEqual({
      model: "gpt-5.6-luna",
      source: "cheap",
    });
  });

  it("uses the session's own model when the local home lacks the cheap one", () => {
    setHarnessModels("codex", [LOCAL_QWEN]);
    expect(pickHelperModel(localCodex)).toEqual({
      model: "qwen2.5:7b",
      source: "session",
    });
  });

  it("does not trust Codex's built-in list for the cheap model", () => {
    expect(pickHelperModel(localCodex, [LUNA], false)).toEqual({
      model: "qwen2.5:7b",
      source: "session",
    });
  });

  it("asks for the harness default when there is neither", () => {
    expect(
      pickHelperModel({ kind: "route", harness: "codex" }, [], true),
    ).toEqual({ source: "default" });
  });

  it("uses Haiku for Claude Code from its built-in list", () => {
    const choice = pickHelperModel({
      kind: "route",
      harness: "claude",
      modelId: "claude:opus-5-5",
    });
    expect(choice.source).toBe("cheap");
    expect(choice.model).toMatch(/haiku/i);
  });
});

describe("routes", () => {
  const sessions = [
    {
      id: "a",
      harness: "claude" as const,
      model: "claude:opus-5-5",
      modelSettings: {},
      cwd: "/repo",
    },
    {
      id: "b",
      harness: "codex" as const,
      model: "codex:qwen2.5:7b",
      modelSettings: {},
      cwd: "/repo",
      worktreeCwd: "/repo-wt",
      providerAccountId: "local-home",
    },
  ];

  it("picks the session that owns the checkout, not the active tab", () => {
    const route = helperRouteForCheckout(sessions, "/repo-wt", sessions[0]);
    expect(route?.harness).toBe("codex");
    expect(route?.providerAccountId).toBe("local-home");
    expect(route?.sessionId).toBe("b");
  });

  it("prefers the active session when it works in the checkout", () => {
    expect(helperRouteForCheckout(sessions, "/repo", sessions[0])?.sessionId).toBe(
      "a",
    );
  });

  it("returns nothing when no open session works there", () => {
    expect(helperRouteForCheckout(sessions, "/elsewhere", null)).toBeUndefined();
    expect(helperRouteForCheckout(sessions, "~", null)).toBeUndefined();
    expect(helperRouteForCheckout(sessions, undefined, null)).toBeUndefined();
  });

  it("matches paths with a trailing slash", () => {
    expect(helperRouteForCheckout(sessions, "/repo-wt/", null)?.sessionId).toBe(
      "b",
    );
  });

  it("falls back to the project's account for a session without one", () => {
    const route = helperRouteForSession({
      harness: "codex",
      model: "codex:qwen2.5:7b",
      cwd: "/repo",
    });
    expect(route.providerAccountId).toBeTruthy();
    const claude = helperRouteForSession({ harness: "cursor", model: "" });
    expect(claude.providerAccountId).toBeUndefined();
  });

  it("recognises routes", () => {
    expect(isHelperRoute(localCodex)).toBe(true);
    expect(isHelperRoute("codex")).toBe(false);
    expect(isHelperRoute(null)).toBe(false);
    expect(pickTextHarness(localCodex)).toBe("codex");
  });
});

describe("helper prompts", () => {
  it("sends a local session's diff to its own harness and account only (case 7)", async () => {
    setHarnessModels("codex", [LOCAL_QWEN]);
    const message = await helperCommitMessage(localCodex, "/repo");
    expect(message).toBe("Update a.txt");
    expect(calls.codex).toHaveLength(1);
    expect(calls.codex[0]).toMatchObject({
      providerAccountId: "local-home",
      model: "qwen2.5:7b",
      ephemeral: true,
    });
    expect(calls.codex[0].prompt).toContain("LOCAL_ONLY_DIFF");
    expect(calls.claude).toBeUndefined();
    expect(calls.cursor).toBeUndefined();
  });

  it("routes textHarness callers through the session", async () => {
    setHarnessModels("codex", [LOCAL_QWEN]);
    await generateCommitMessage("/repo", localCodex, undefined, ["a.txt"]);
    expect(stagedContext).toHaveBeenCalledWith("/repo", ["a.txt"]);
    expect(calls.codex).toHaveLength(1);
    expect(calls.claude).toBeUndefined();
  });

  it("keeps the old path for a bare harness id", async () => {
    await expect(generateCommitMessage("/repo", "claude")).resolves.toBe(
      "OLD PATH",
    );
  });

  it("refuses rather than borrowing another harness (case 11)", async () => {
    const fx: HelperRoute = { kind: "route", harness: "fx", modelId: "fx:x" };
    expect(canRunHelper(fx)).toBe(false);
    await expect(helperCommitMessage(fx, "/repo")).rejects.toBeInstanceOf(
      HelperUnavailableError,
    );
    expect(stagedContext).not.toHaveBeenCalled();
    expect(Object.keys(calls)).toHaveLength(0);
    await expect(helperBranchName(fx, "/repo", "x")).resolves.toBeNull();
    await expect(
      helperTitle(fx, { cwd: "/repo", message: "x" }),
    ).resolves.toBeNull();
  });

  it("reports an empty reply instead of hanging (case 2)", async () => {
    reply = async () => "";
    await expect(helperCommitMessage(localCodex, "/repo")).rejects.toThrow(
      /returned no text/,
    );
  });

  it("reports what the model said when it is not a commit message", async () => {
    reply = async () => "I will now make the requested change";
    await expect(helperCommitMessage(localCodex, "/repo")).rejects.toThrow(
      /Model replied: I will now/,
    );
  });

  it("builds PR text from the commits when the harness has no helper", async () => {
    const pr = await helperPrContent(
      { kind: "route", harness: "fx" },
      "/repo",
    );
    expect(pr).toEqual({
      title: "Add the thing",
      body: expect.stringContaining("## Commits"),
      base: "main",
      head: "feature",
    });
    expect(Object.keys(calls)).toHaveLength(0);
  });

  it("builds PR text from the commits when the model fails", async () => {
    reply = async () => {
      throw new Error("timed out");
    };
    const pr = await helperPrContent(localCodex, "/repo");
    expect(pr.title).toBe("Add the thing");
    expect(calls.codex).toHaveLength(1);
  });

  it("uses the model's PR text when it parses", async () => {
    reply = async () =>
      JSON.stringify({ title: "Ship it", body: "Body text" });
    await expect(generatePrContent("/repo", localCodex)).resolves.toMatchObject({
      title: "Ship it",
      body: "Body text",
    });
  });

  it("returns null for a branch name the model fails to give", async () => {
    reply = async () => {
      throw new Error("no tool call");
    };
    await expect(helperBranchName(localCodex, "/repo", "fix the login")).resolves.toBeNull();
  });

  it("gets a title from the session's model", async () => {
    setHarnessModels("codex", [LOCAL_QWEN]);
    reply = async () => "Fix the login";
    const title = await helperTitle(localCodex, {
      cwd: "/repo",
      message: "please fix the login",
    });
    expect(title?.title).toBe("Fix the login");
    expect(calls.codex[0].model).toBe("qwen2.5:7b");
  });
});

describe("timeouts (case 3)", () => {
  it("stretches four times for a model marked slow", () => {
    setHarnessModels("codex", [{ ...LOCAL_QWEN, slow: true }]);
    expect(helperTimeoutMs(localCodex, GIT_TIMEOUT_MS)).toBe(GIT_TIMEOUT_MS * 4);
  });

  it("keeps the base timeout otherwise", () => {
    setHarnessModels("codex", [LOCAL_QWEN]);
    expect(helperTimeoutMs(localCodex, GIT_TIMEOUT_MS)).toBe(GIT_TIMEOUT_MS);
    expect(
      helperTimeoutMs({ kind: "route", harness: "codex" }, GIT_TIMEOUT_MS),
    ).toBe(GIT_TIMEOUT_MS);
  });

  it("passes the stretched timeout to the harness", async () => {
    setHarnessModels("codex", [{ ...LOCAL_QWEN, slow: true }]);
    await helperCommitMessage(localCodex, "/repo");
    expect(calls.codex[0].timeoutMs).toBe(GIT_TIMEOUT_MS * 4);
  });
});
