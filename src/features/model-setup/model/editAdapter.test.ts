import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  codexEditAdapter,
  editAdapterAvailability,
  editAdapterConfig,
  editAdapterOn,
} from "./editAdapter";
import {
  modelProviders,
  sanitizeProviderEntry,
  saveModelProvider,
  setProviderEditAdapter,
  type ModelProviderEntry,
} from "./modelProviders";
import {
  resetTraitOverridesCache,
  saveTraitOverride,
} from "../../model-traits/model/modelTraits";
import { buildThreadStartParams } from "../../../integrations/harness/providers/codex/codexProtocol";
import { EditAdapterSwitch } from "../ui/EditAdapterSwitch";
import { DEFAULT_INSTRUCTIONS } from "./modelSetup";

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
  model: "qwen3:8b",
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  resetTraitOverridesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetTraitOverridesCache();
});

describe("edit adapter availability", () => {
  it("runs only for a local provider with an id Codex lets MonoCode override", () => {
    saveModelProvider(LOCAL);
    saveModelProvider({ ...LOCAL, id: "rented_box", kind: "rented", baseUrl: "http://127.0.0.1:9000/v1" });
    saveModelProvider({ ...LOCAL, id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    saveModelProvider({ ...LOCAL, id: "my.box" });
    saveModelProvider({ ...LOCAL, id: "lmstudio", kind: "lmstudio" });
    expect(editAdapterAvailability({ id: "ollama_local" })).toEqual({ available: true });
    // A tunnel to a rented GPU is hosted, so the adapter is not offered.
    expect(editAdapterAvailability({ id: "rented_box" }).available).toBe(false);
    expect(editAdapterAvailability({ id: "openrouter" }).available).toBe(false);
    expect(editAdapterAvailability({ id: "my.box" }).available).toBe(false);
    expect(editAdapterAvailability({ id: "lmstudio" }).available).toBe(false);
    // Unknown counts as hosted.
    expect(editAdapterAvailability({ id: "nobody" }).available).toBe(false);
  });

  it("defaults on unless the model is marked a reliable tool caller, and your switch wins", () => {
    saveModelProvider(LOCAL);
    expect(editAdapterOn(LOCAL)).toBe(true);
    saveTraitOverride("qwen3:8b", { tools: "reliable" });
    expect(editAdapterOn(LOCAL)).toBe(false);
    expect(editAdapterOn(LOCAL, "qwen2.5:7b")).toBe(true);
    expect(editAdapterOn({ ...LOCAL, editAdapter: true })).toBe(true);
    expect(editAdapterOn({ ...LOCAL, editAdapter: false }, "qwen2.5:7b")).toBe(false);
  });
});

describe("stored switch", () => {
  it("keeps a boolean, drops anything else, and can go back to the default", () => {
    expect(sanitizeProviderEntry({ ...LOCAL, editAdapter: false })?.editAdapter).toBe(false);
    expect(sanitizeProviderEntry({ ...LOCAL, editAdapter: "yes" })?.editAdapter).toBeUndefined();
    saveModelProvider(LOCAL);
    setProviderEditAdapter("ollama_local", false);
    expect(modelProviders()[0].editAdapter).toBe(false);
    setProviderEditAdapter("ollama_local", undefined);
    expect("editAdapter" in modelProviders()[0]).toBe(false);
  });
});

describe("codex session route", () => {
  const input = { sessionId: "s1", cwd: "/Users/me/codex-scratch", modelProvider: "ollama_local", model: "qwen2.5:7b" };

  it("opens the route on the provider's server and the session folder", async () => {
    saveModelProvider(LOCAL);
    const open = vi.fn(async () => "http://127.0.0.1:50000/s/abc");
    const adapter = await codexEditAdapter(input, open);
    expect(open).toHaveBeenCalledWith("s1", "http://127.0.0.1:11434/v1", "/Users/me/codex-scratch");
    expect(editAdapterConfig(adapter)).toEqual({
      "model_providers.ollama_local.base_url": "http://127.0.0.1:50000/s/abc",
    });
    expect(adapter.key).toContain("ollama_local");
  });

  it("finds the provider through the chat's Codex account when no provider is picked", async () => {
    saveModelProvider(LOCAL);
    const open = vi.fn(async () => "http://127.0.0.1:50000/s/abc");
    const adapter = await codexEditAdapter({ sessionId: "s1", cwd: "/x", providerAccountId: "acct-ollama" }, open);
    expect(adapter.providerId).toBe("ollama_local");
  });

  it("stays out of the way when off, unknown or hosted, without a call to the app", async () => {
    const open = vi.fn(async () => "unused");
    // The wrapper script case: no provider MonoCode knows.
    expect(await codexEditAdapter(input, open)).toEqual({ key: "" });
    saveModelProvider({ ...LOCAL, editAdapter: false });
    expect(await codexEditAdapter(input, open)).toEqual({ key: "" });
    saveModelProvider({ ...LOCAL, id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    expect(await codexEditAdapter({ ...input, modelProvider: "openrouter" }, open)).toEqual({ key: "" });
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to the model server directly when the route cannot open", async () => {
    saveModelProvider(LOCAL);
    const adapter = await codexEditAdapter(input, async () => {
      throw new Error("edit adapter could not listen");
    });
    expect(adapter.key).toBe("");
    expect(adapter.error).toContain("could not listen");
    expect(editAdapterConfig(adapter)).toBeUndefined();
  });
});

describe("thread params", () => {
  it("carry the override as thread config on start and resume, and nothing when off", () => {
    const base = { cwd: "/x", runtimeMode: "supervised" as const };
    const on = buildThreadStartParams({
      ...base,
      providerConfig: { "model_providers.ollama_local.base_url": "http://127.0.0.1:1/s/t" },
    });
    expect(on.config).toEqual({ "model_providers.ollama_local.base_url": "http://127.0.0.1:1/s/t" });
    expect("config" in buildThreadStartParams(base)).toBe(false);
    expect("config" in buildThreadStartParams({ ...base, providerConfig: {} })).toBe(false);
  });
});

describe("instructions file", () => {
  it("keeps the apply_patch how-to the adapter swaps out (edit_adapter/rewrite.rs, APPLY_PATCH_HOWTO)", () => {
    const lines = DEFAULT_INSTRUCTIONS.split("\n");
    const start = lines.indexOf("Edit files by running apply_patch through exec_command:");
    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start + 1).some((line) => line.trimEnd() === "EOF")).toBe(true);
  });
});

describe("switch on the Models page", () => {
  it("shows for a local provider, says when the default is in force, and hides for a hosted one", () => {
    saveModelProvider(LOCAL);
    const html = renderToStaticMarkup(createElement(EditAdapterSwitch, { entry: LOCAL }));
    expect(html).toContain("Edit adapter for small models");
    expect(html).toContain("(default)");
    expect(html).toContain('data-edit-adapter="on"');
    const hosted = { ...LOCAL, id: "openrouter", kind: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1" };
    saveModelProvider(hosted);
    expect(renderToStaticMarkup(createElement(EditAdapterSwitch, { entry: hosted }))).toBe("");
    const builtIn = { ...LOCAL, id: "lmstudio", kind: "lmstudio" as const };
    saveModelProvider(builtIn);
    expect(renderToStaticMarkup(createElement(EditAdapterSwitch, { entry: builtIn }))).toContain("unavailable");
  });
});
