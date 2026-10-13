import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts: Record<string, unknown>[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "project_context_read") return { text: null, hash: "h:" };
    if (command === "project_context_save") return `h:${args.text}`;
    throw new Error(command);
  }),
}));
vi.mock("../../../integrations/harness/core/registry", () => ({
  canRunHarnessTextPrompt: () => true,
  runHarnessTextPrompt: vi.fn(async (input: Record<string, unknown>) => {
    prompts.push(input);
    return "NONE";
  }),
}));

import {
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../../sessions/model/models";
import type { Block } from "../../sessions/model/session";
import { suggestMemories, suggestModelId } from "./suggest";

const blocks: Block[] = [
  { id: "1", role: "user", text: "Use pnpm." },
  { id: "2", role: "assistant", text: "Done." },
];

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

beforeEach(() => {
  prompts.length = 0;
  resetHarnessModelOverlays();
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
});

describe("Mac finding 2.9: Suggest memories sends the native model id", () => {
  it("sends qwen2.5:7b, not codex:qwen2.5:7b, for a local Codex model", async () => {
    setHarnessModels("codex", [
      {
        id: "codex:qwen2.5:7b",
        harness: "codex",
        name: "qwen2.5:7b",
        nativeId: "qwen2.5:7b",
      },
    ]);
    await suggestMemories({
      id: "s1",
      cwd: "/code/app",
      harness: "codex",
      model: "codex:qwen2.5:7b",
      providerAccountId: "local",
      modelSettings: { reasoningEffort: "low" },
      blocks,
    });
    expect(prompts[0]).toMatchObject({
      harness: "codex",
      model: "qwen2.5:7b",
      modelSettings: { reasoningEffort: "low" },
    });
  });

  it("maps an id no catalog lists by its slug", () => {
    expect(suggestModelId("codex:qwen2.5:7b")).toBe("qwen2.5:7b");
  });

  it("sends Claude's CLI id for a Claude model", async () => {
    await suggestMemories({
      id: "s2",
      cwd: "/code/app",
      harness: "claude",
      model: "claude:opus-5-5",
      blocks,
    });
    expect(prompts[0]).toMatchObject({
      harness: "claude",
      model: "claude-opus-5-5",
    });
  });

  it("leaves the model out, for the harness default, when none is known", async () => {
    await suggestMemories({
      id: "s3",
      cwd: "/code/app",
      harness: "codex",
      model: "",
      modelSettings: { reasoningEffort: "low" },
      blocks,
    });
    expect(prompts[0]).not.toHaveProperty("model");
    expect(prompts[0]).not.toHaveProperty("modelSettings");
    expect(suggestModelId(undefined)).toBeUndefined();
    expect(suggestModelId("  ")).toBeUndefined();
  });
});
