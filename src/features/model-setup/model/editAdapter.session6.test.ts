import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEditAdapter, editAdapterAccountMatches } from "./editAdapter";
import { saveModelProvider, type ModelProviderEntry } from "./modelProviders";
import { resetTraitOverridesCache } from "../../model-traits/model/modelTraits";

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

const LOCAL: ModelProviderEntry = {
  id: "ollama_local",
  label: "Ollama",
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  accountId: "acct-ollama",
  model: "qwen2.5-coder:7b",
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  resetTraitOverridesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetTraitOverridesCache();
});

describe("Mac fix 2.3 / 7.9: the edit adapter only on the account model setup wrote", () => {
  const base = {
    sessionId: "s1",
    cwd: "/Users/me/my repo",
    model: "qwen2.5-coder:7b",
  };

  it("leaves the old wrapper script home alone though its provider id matches", async () => {
    saveModelProvider(LOCAL);
    const open = vi.fn(async () => "http://127.0.0.1:50000/s/abc");
    // The wrapper home: the chat picked provider ollama_local but runs on the
    // default account (no named account), with its own base URL in its config.
    expect(
      await codexEditAdapter({ ...base, modelProvider: "ollama_local" }, open),
    ).toEqual({ key: "" });
    // Another named account (an older home written by hand).
    expect(
      await codexEditAdapter(
        {
          ...base,
          modelProvider: "ollama_local",
          providerAccountId: "acct-wrapper",
        },
        open,
      ),
    ).toEqual({ key: "" });
    expect(open).not.toHaveBeenCalled();
  });

  it("runs on the named account model setup wrote, with or without a picked provider", async () => {
    saveModelProvider(LOCAL);
    const open = vi.fn(async () => "http://127.0.0.1:50000/s/abc");
    const a = await codexEditAdapter(
      {
        ...base,
        modelProvider: "ollama_local",
        providerAccountId: "acct-ollama",
      },
      open,
    );
    expect(a.providerId).toBe("ollama_local");
    const b = await codexEditAdapter(
      { ...base, providerAccountId: "acct-ollama" },
      open,
    );
    expect(b.providerId).toBe("ollama_local");
  });

  it("never matches an entry saved without an account", () => {
    expect(editAdapterAccountMatches({}, undefined)).toBe(false);
    expect(editAdapterAccountMatches({ accountId: "a" }, undefined)).toBe(
      false,
    );
    expect(editAdapterAccountMatches({ accountId: "a" }, "a")).toBe(true);
  });
});
