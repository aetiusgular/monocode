import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  invoked: [] as Array<{ cmd: string; args: unknown }>,
  answer: (_args: unknown): Promise<unknown> => Promise.resolve([]),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (cmd: string, args: unknown) => {
    calls.invoked.push({ cmd, args });
    return calls.answer(args);
  },
}));

import {
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../../sessions/model/models";
import {
  resetTraitOverridesCache,
  saveTraitOverride,
} from "../../model-traits/model/modelTraits";
import { computerUseBlock } from "./offer";

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// A Codex chat on the Models page's Ollama provider. Codex's fallback
// metadata for an unknown model claims image input, so the catalog says
// vision (Mac test 4.11).
const session = {
  id: "c1",
  harness: "codex" as const,
  model: "codex:qwen2.5:7b",
  modelProvider: "ollama_local",
};
const context = {
  isMac: true,
  cliPath: "/Applications/MonoCode.app/Contents/MacOS/monocode",
  switchFor: () => ({ on: true }),
};

beforeEach(async () => {
  mockLocalStorage();
  localStorage.setItem(
    "monocode.modelProviders",
    JSON.stringify([
      {
        id: "ollama_local",
        label: "Ollama",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    ]),
  );
  resetTraitOverridesCache();
  resetHarnessModelOverlays();
  setHarnessModels("codex", [
    {
      id: "codex:qwen2.5:7b",
      harness: "codex",
      name: "qwen2.5:7b",
      nativeId: "qwen2.5:7b",
      vision: true,
    },
  ]);
  calls.invoked = [];
  const ollama = await import("../../model-traits/model/ollamaVision").catch(
    () => null,
  );
  ollama?.resetOllamaVisionForTest();
});
afterEach(() => {
  resetHarnessModelOverlays();
});

describe("vision for a model on Ollama comes from Ollama (4.11)", () => {
  it("blocks the offer when Ollama does not list vision, despite Codex's fallback", async () => {
    calls.answer = () => Promise.resolve(["completion", "tools"]);
    computerUseBlock(session, context);
    await flush();
    expect(computerUseBlock(session, context)).toBe("vision");
    expect(calls.invoked).toEqual([
      {
        cmd: "model_setup_ollama_capabilities",
        args: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" },
      },
    ]);
  });

  it("offers when Ollama lists vision, and asks once per base URL and model", async () => {
    calls.answer = () => Promise.resolve(["completion", "vision"]);
    computerUseBlock(session, context);
    await flush();
    expect(computerUseBlock(session, context)).toBeUndefined();
    computerUseBlock(session, context);
    expect(calls.invoked).toHaveLength(1);
  });

  it("treats a failed call, or the wait for it, as unknown: blocked", async () => {
    calls.answer = () => Promise.reject(new Error("Ollama did not answer."));
    expect(computerUseBlock(session, context)).toBe("vision");
    await flush();
    expect(computerUseBlock(session, context)).toBe("vision");
  });

  it("lets your own setting win over Ollama", async () => {
    calls.answer = () => Promise.resolve(["completion"]);
    saveTraitOverride("codex:qwen2.5:7b", { vision: true });
    computerUseBlock(session, context);
    await flush();
    expect(computerUseBlock(session, context)).toBeUndefined();
  });

  it("leaves a chat on another provider to the catalog, and asks nothing", async () => {
    const hosted = { ...session, modelProvider: "openai" };
    expect(computerUseBlock(hosted, context)).toBeUndefined();
    expect(calls.invoked).toEqual([]);
  });
});
