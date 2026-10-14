import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  isTauri: () => false,
}));

import {
  modelLabelFor,
  resetHarnessModelOverlays,
  resolveModel,
  sessionModelLabel,
  setHarnessModels,
  type AgentModel,
} from "./models";
import { newSession, type Session } from "./session";
import { sessionFacts } from "../../session-panel/model/sessionFacts";
import { appendUser } from "../../../integrations/harness/core/apply";

/**
 * Mac finding 5.3: after the Codex path moved from the wrapper home to the
 * auto-detected one, the catalog lists only `qwen3:8b (Ollama on this Mac)`.
 * Older chats saved on `codex:qwen2.5:7b` then read that label, because
 * `resolveModel` falls back to the catalog's default for an id it no longer
 * lists. A chat keeps the label of the model it ran on.
 */

const DETECTED: AgentModel = {
  id: "codex:qwen3:8b",
  harness: "codex",
  name: "qwen3:8b (Ollama on this Mac)",
  nativeId: "qwen3:8b",
};
const WRAPPER: AgentModel = {
  id: "codex:qwen2.5:7b",
  harness: "codex",
  name: "Qwen2.5 7B",
  nativeId: "qwen2.5:7b",
};

beforeEach(() => {
  resetHarnessModelOverlays();
});
afterEach(() => {
  resetHarnessModelOverlays();
});

function oldChat(): Session {
  return {
    ...newSession("codex", "/Users/t/s7-gen", "codex:qwen2.5:7b"),
    id: "old",
    model: "codex:qwen2.5:7b",
  };
}

describe("5.3: a chat keeps the label of the model it ran on", () => {
  it("an older chat reads its own model after the catalog changed", () => {
    setHarnessModels("codex", [DETECTED]);
    const chat = oldChat();
    // What the sidebar read before.
    expect(resolveModel("codex", chat.model).name).toBe(
      "qwen3:8b (Ollama on this Mac)",
    );
    expect(sessionModelLabel("codex", chat.model)).toBe("qwen2.5:7b");
    const model = sessionFacts(chat).find((fact) => fact.label === "Model");
    expect(model?.value).toBe("qwen2.5:7b");
  });

  it("a turn sent on it is recorded with its own model", () => {
    setHarnessModels("codex", [DETECTED]);
    const sent = appendUser(oldChat(), "hello");
    const user = sent.blocks.find((block) => block.role === "user");
    expect(user?.turnModel).toEqual({
      harness: "codex",
      id: "codex:qwen2.5:7b",
      name: "qwen2.5:7b",
    });
  });

  it("while the catalog still lists it, the catalog name stays", () => {
    setHarnessModels("codex", [DETECTED, WRAPPER]);
    expect(sessionModelLabel("codex", "codex:qwen2.5:7b")).toBe("Qwen2.5 7B");
    expect(sessionModelLabel("codex", "codex:qwen3:8b")).toBe(
      "qwen3:8b (Ollama on this Mac)",
    );
  });

  it("a match by native id keeps the catalog name", () => {
    const resolved = { ...WRAPPER, id: "codex:qwen2.5:7b[1m]" };
    expect(modelLabelFor(resolved, "codex:qwen2.5:7b")).toBe("Qwen2.5 7B");
  });

  it("no saved model reads the default's name", () => {
    setHarnessModels("codex", [DETECTED]);
    expect(sessionModelLabel("codex", undefined)).toBe(
      "qwen3:8b (Ollama on this Mac)",
    );
  });

  it("Claude Code labels are unchanged", () => {
    const claude = resolveModel("claude", "claude:opus");
    expect(sessionModelLabel("claude", "claude:opus")).toBe(claude.name);
  });
});
