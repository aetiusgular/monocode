import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
  type AgentModel,
} from "../../sessions/model/models";
import { parseCodexModelList, parseVision } from "../../../integrations/harness/providers/codex/codexCatalog";
import {
  clearTraitOverride,
  loadTraitOverrides,
  MAX_TRAIT_OVERRIDES,
  MODEL_TRAITS_KEY,
  modelBudgetWindow,
  modelCallsToolsReliably,
  modelReadsImages,
  modelTimeoutFactor,
  modelTraits,
  resetTraitOverridesCache,
  sanitizeContextWindow,
  sanitizeModelId,
  sanitizeTraitOverrides,
  saveTraitOverride,
} from "./modelTraits";
import { modelsToList } from "../ui/ModelsPage";

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

const LOCAL: AgentModel = {
  id: "codex:qwen2.5:7b",
  harness: "codex",
  name: "qwen2.5:7b",
  nativeId: "qwen2.5:7b",
};

beforeEach(() => {
  mockLocalStorage();
  resetTraitOverridesCache();
  resetHarnessModelOverlays();
});
afterEach(() => {
  resetTraitOverridesCache();
  resetHarnessModelOverlays();
});

describe("model traits", () => {
  it("knows Claude models read images and call tools reliably", () => {
    const traits = modelTraits("claude:opus-5");
    expect(traits.vision).toBe(true);
    expect(traits.tools).toBe("reliable");
    expect(traits.slow).toBe(false);
    expect(traits.source.tools).toBe("harness");
    expect(modelCallsToolsReliably("claude:sonnet-5")).toBe(true);
  });

  it("leaves a local model unknown until you set it (corner cases 2 and 4)", () => {
    setHarnessModels("codex", [LOCAL]);
    const traits = modelTraits(LOCAL.id);
    expect(traits.vision).toBeUndefined();
    expect(traits.tools).toBe("unknown");
    expect(traits.contextWindow).toBeUndefined();
    expect(modelReadsImages(LOCAL.id)).toBe(false);
    expect(modelCallsToolsReliably(LOCAL.id)).toBe(false);
    expect(modelTimeoutFactor(LOCAL.id)).toBe(1);
  });

  it("puts your settings above the catalog", () => {
    // Codex fallback metadata on a local home claims image input.
    setHarnessModels("codex", [{ ...LOCAL, vision: true, contextWindow: 272_000 }]);
    expect(modelTraits(LOCAL.id).source.vision).toBe("catalog");
    saveTraitOverride(LOCAL.id, {
      vision: false,
      tools: "none",
      slow: true,
      contextWindow: 16_384,
    });
    const traits = modelTraits(LOCAL.id);
    expect(traits.vision).toBe(false);
    expect(traits.tools).toBe("none");
    expect(traits.slow).toBe(true);
    expect(traits.contextWindow).toBe(16_384);
    expect(traits.source).toEqual({
      vision: "yours",
      tools: "yours",
      slow: "yours",
      contextWindow: "yours",
    });
    // Corner case 1 and 3: the 16k window and the slow 7B.
    expect(modelBudgetWindow(LOCAL.id)).toBe(16_384);
    expect(modelTimeoutFactor(LOCAL.id)).toBe(4);
  });

  it("works for an id no catalog knows", () => {
    saveTraitOverride("codex:not-listed", { tools: "weak" });
    expect(modelTraits("codex:not-listed").tools).toBe("weak");
    expect(modelTraits("nonsense").tools).toBe("unknown");
  });

  it("clears one field, then the entry", () => {
    saveTraitOverride(LOCAL.id, { tools: "weak", slow: true });
    saveTraitOverride(LOCAL.id, { tools: undefined });
    expect(loadTraitOverrides()[LOCAL.id]).toEqual({ slow: true });
    clearTraitOverride(LOCAL.id);
    expect(loadTraitOverrides()[LOCAL.id]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(MODEL_TRAITS_KEY) ?? "{}")).toEqual({});
  });

  it("keeps working when storage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });
    resetTraitOverridesCache();
    expect(loadTraitOverrides()).toEqual({});
    saveTraitOverride(LOCAL.id, { tools: "weak" });
    expect(modelTraits(LOCAL.id).tools).toBe("weak");
  });
});

describe("stored traits read back", () => {
  it("drops bad JSON", () => {
    localStorage.setItem(MODEL_TRAITS_KEY, "{not json");
    expect(loadTraitOverrides()).toEqual({});
  });

  it("drops bad entries and keeps good ones", () => {
    const clean = sanitizeTraitOverrides({
      "codex:a": { tools: "reliable", vision: "yes", contextWindow: 16_384 },
      "codex:b": { tools: "sometimes" },
      "codex:c": { contextWindow: 12 },
      "": { slow: true },
      "bad\nid": { slow: true },
      __proto__: { slow: true },
      list: [1, 2],
    });
    expect(Object.keys(clean)).toEqual(["codex:a"]);
    expect(clean["codex:a"]).toEqual({ tools: "reliable", contextWindow: 16_384 });
  });

  it("keeps at most the bound", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_TRAIT_OVERRIDES + 50; i += 1) {
      many[`codex:m${i}`] = { slow: true };
    }
    expect(Object.keys(sanitizeTraitOverrides(many))).toHaveLength(
      MAX_TRAIT_OVERRIDES,
    );
  });

  it("checks the context window and the model id", () => {
    expect(sanitizeContextWindow(16_384.9)).toBe(16_384);
    expect(sanitizeContextWindow(0)).toBeUndefined();
    expect(sanitizeContextWindow(Number.NaN)).toBeUndefined();
    expect(sanitizeContextWindow(1e12)).toBeUndefined();
    expect(sanitizeContextWindow("16384")).toBeUndefined();
    expect(sanitizeModelId("  codex:qwen2.5:7b ")).toBe("codex:qwen2.5:7b");
    expect(sanitizeModelId("x".repeat(201))).toBeUndefined();
    expect(sanitizeModelId("constructor")).toBeUndefined();
  });
});

describe("Codex input modalities", () => {
  it("reads image input as vision", () => {
    expect(parseVision({ inputModalities: ["text", "image"] })).toBe(true);
    expect(parseVision({ inputModalities: ["text"] })).toBe(false);
    expect(parseVision({ inputModalities: [] })).toBeUndefined();
    expect(parseVision({ inputModalities: "image" })).toBeUndefined();
    expect(parseVision({})).toBeUndefined();
  });

  it("carries vision from the model list", () => {
    const [withImages, textOnly, unsaid] = parseCodexModelList([
      { model: "gpt-x", inputModalities: ["text", "image"] },
      { model: "qwen2.5:7b", inputModalities: ["text"] },
      { model: "other" },
    ]);
    expect(withImages.vision).toBe(true);
    expect(textOnly.vision).toBe(false);
    expect("vision" in unsaid).toBe(false);
  });
});

describe("Models page list", () => {
  it("leaves out Claude, removes repeats and adds your own ids", () => {
    const rows = modelsToList(
      [
        { id: "claude:opus-5", harness: "claude", name: "Opus 5" },
        LOCAL,
        LOCAL,
        { id: "opencode:ollama/llama", harness: "opencode", name: "llama" },
      ],
      ["codex:qwen2.5:7b", "codex:typed-by-you"],
    );
    expect(rows.map((row) => row.id)).toEqual([
      "codex:qwen2.5:7b",
      "opencode:ollama/llama",
      "codex:typed-by-you",
    ]);
    expect(rows[0].harnessLabel).toBe("Codex");
    expect(rows[2].harnessLabel).toBe("Added by you");
  });
});
