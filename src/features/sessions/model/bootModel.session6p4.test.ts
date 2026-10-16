import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  isTauri: () => false,
}));

import {
  resetHarnessModelOverlays,
  setHarnessModels,
  type AgentModel,
} from "./models";
import { newSession, type Session } from "./session";
import { sessionAfterCatalogRefresh } from "./bootModel";

/**
 * Mac finding 5.3, retest 3 (15 Oct, 5733804). The Codex path moved from the
 * wrapper home to the auto-detected one and back, with a restart each time.
 * At each launch the boot pass saved the new catalog's default over every
 * Codex chat whose model that catalog did not list: all 34 chats ended on
 * `codex:qwen2.5:7b`, 27 of which ran on qwen3:8b.
 */

const QWEN3: AgentModel = {
  id: "codex:qwen3:8b",
  harness: "codex",
  name: "qwen3:8b (Ollama on this Mac)",
  nativeId: "qwen3:8b",
  settings: [
    {
      id: "effort",
      label: "Effort",
      kind: "select",
      value: "medium",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
      ],
    },
  ],
};
const QWEN25: AgentModel = {
  id: "codex:qwen2.5:7b",
  harness: "codex",
  name: "Qwen2.5 7B",
  nativeId: "qwen2.5:7b",
};

function chat(model: string, modelSettings?: Record<string, string>): Session {
  return { ...newSession("codex", "/Users/t/s7-r10", model), id: model, model, modelSettings };
}

beforeEach(() => resetHarnessModelOverlays());
afterEach(() => resetHarnessModelOverlays());

describe("5.3: the boot pass keeps a chat's model when the catalog does not list it", () => {
  it("a qwen2.5 chat under the auto-detected catalog keeps qwen2.5", () => {
    setHarnessModels("codex", [QWEN3]);
    const next = sessionAfterCatalogRefresh(chat("codex:qwen2.5:7b"));
    expect(next.model).toBe("codex:qwen2.5:7b");
  });

  it("a qwen3 chat under the wrapper's catalog keeps qwen3", () => {
    setHarnessModels("codex", [QWEN25]);
    const next = sessionAfterCatalogRefresh(chat("codex:qwen3:8b"));
    expect(next.model).toBe("codex:qwen3:8b");
  });

  it("there and back leaves every chat on its own model", () => {
    const chats = [chat("codex:qwen2.5:7b"), chat("codex:qwen3:8b")];
    setHarnessModels("codex", [QWEN3]);
    const once = chats.map((c) => sessionAfterCatalogRefresh(c));
    setHarnessModels("codex", [QWEN25]);
    const twice = once.map((c) => sessionAfterCatalogRefresh(c));
    expect(twice.map((c) => c.model)).toEqual([
      "codex:qwen2.5:7b",
      "codex:qwen3:8b",
    ]);
  });

  it("model settings still merge on a chat that keeps its model", () => {
    setHarnessModels("codex", [QWEN3]);
    const next = sessionAfterCatalogRefresh(chat("codex:qwen2.5:7b"));
    expect(next.model).toBe("codex:qwen2.5:7b");
    expect(next.modelSettings).toEqual({ effort: "medium" });
  });
});

describe("5.3: a model the catalog resolves is still rewritten", () => {
  it("leaves a chat on a listed model untouched", () => {
    setHarnessModels("codex", [QWEN3]);
    const before = chat("codex:qwen3:8b", { effort: "low" });
    expect(sessionAfterCatalogRefresh(before)).toBe(before);
  });

  it("rewrites a saved id that resolves by its native id", () => {
    const renamed: AgentModel = { ...QWEN3, id: "codex:ollama-qwen3:8b" };
    setHarnessModels("codex", [renamed]);
    const next = sessionAfterCatalogRefresh(chat("codex:qwen3:8b"));
    expect(next.model).toBe("codex:ollama-qwen3:8b");
  });

  it("gives a chat with no saved model the catalog's model", () => {
    setHarnessModels("codex", [QWEN3]);
    const next = sessionAfterCatalogRefresh(chat(""));
    expect(next.model).toBe("codex:qwen3:8b");
  });

  it("keeps the saved id while the catalog is still empty", () => {
    const before = chat("codex:qwen2.5:7b");
    expect(sessionAfterCatalogRefresh(before).model).toBe("codex:qwen2.5:7b");
  });
});
