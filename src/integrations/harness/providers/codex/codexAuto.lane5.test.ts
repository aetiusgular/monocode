import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadStartParams, buildTurnStartParams } from "./codexProtocol";
import { codexThreadIdentity, codexThreadIdentityKey } from "./codexProviders";
import { saveModelProvider } from "../../../../features/model-setup/model/modelProviders";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("Auto on a provider other than OpenAI", () => {
  it("is off for a chat on a local provider, by id or by account", () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      accountId: "local",
    });
    expect(
      codexThreadIdentity({ modelProvider: "ollama_local" }).autoReviewOff,
    ).toBe(true);
    expect(
      codexThreadIdentity({ providerAccountId: "local" }).autoReviewOff,
    ).toBe(true);
    expect(
      codexThreadIdentity({ modelProvider: "openai" }).autoReviewOff,
    ).toBeUndefined();
    // The wrapper case: MonoCode cannot see the provider, so Auto stays.
    expect(codexThreadIdentity({}).autoReviewOff).toBeUndefined();
  });

  it("sends review by you instead of auto-review", () => {
    const thread = buildThreadStartParams({
      cwd: "/r",
      runtimeMode: "auto",
      autoReviewOff: true,
    });
    expect(thread.approvalsReviewer).toBe("user");
    const turn = buildTurnStartParams({
      threadId: "t",
      runtimeMode: "auto",
      prompt: "hi",
      autoReviewOff: true,
    });
    expect(turn.approvalsReviewer).toBe("user");
    // Untouched elsewhere.
    expect(
      buildTurnStartParams({ threadId: "t", runtimeMode: "auto", prompt: "hi" })
        .approvalsReviewer,
    ).toBe("auto_review");
    expect(
      buildTurnStartParams({
        threadId: "t",
        runtimeMode: "supervised",
        prompt: "hi",
        autoReviewOff: true,
      }).approvalsReviewer,
    ).toBe("user");
  });

  it("reopens the thread when it changes", () => {
    expect(codexThreadIdentityKey({ autoReviewOff: true })).not.toBe(
      codexThreadIdentityKey({}),
    );
  });
});
