import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { buildCatalog } from "./catalogTemplate";
import {
  checkDraft,
  DEFAULT_INSTRUCTIONS,
  detectModelServers,
  draftFromDetected,
  emptyDraft,
  entryFromDraft,
  writeCodexHome,
} from "./modelSetup";
import { saveModelProvider } from "./modelProviders";
import { ModelSetupSection } from "../ui/ModelSetupSection";

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

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.mocked(invoke).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("catalog", () => {
  it("is one text-only entry with reasoning off", () => {
    const catalog = buildCatalog({
      model: "qwen2.5:7b",
      displayName: "Qwen",
      contextWindow: 16_384,
      instructions: "x",
    });
    expect(catalog.models).toHaveLength(1);
    const entry = catalog.models[0];
    expect(entry.slug).toBe("qwen2.5:7b");
    expect(entry.context_window).toBe(16_384);
    expect(entry.input_modalities).toEqual(["text"]);
    expect(entry.default_reasoning_level).toBeNull();
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.supports_reasoning_summaries).toBe(false);
    expect(entry.apply_patch_tool_type).toBeNull();
    expect(
      (entry.model_messages as Record<string, unknown>).instructions_template,
    ).toBe("x");
    expect(JSON.stringify(catalog)).not.toContain("You are Codex");
  });
});

describe("draft check", () => {
  it("accepts a local Ollama draft", () => {
    const draft = { ...emptyDraft("ollama"), model: "qwen2.5:7b" };
    const check = checkDraft(draft);
    expect(check).toMatchObject({
      ok: true,
      providerId: "ollama_local",
      local: true,
      contextWindow: 16_384,
    });
  });

  it("marks hosted and rented servers not private", () => {
    expect(
      checkDraft({ ...emptyDraft("openrouter"), model: "qwen/qwen3.8-27b" }),
    ).toMatchObject({ ok: true, local: false, envKey: "OPENROUTER_API_KEY" });
    // A tunnel listens on loopback and is still a machine you do not own.
    expect(
      checkDraft({ ...emptyDraft("rented"), model: "qwen" }),
    ).toMatchObject({ ok: true, local: false });
    expect(
      checkDraft({
        ...emptyDraft("custom"),
        baseUrl: "http://localhost:@other.host/v1",
        model: "m",
      }).ok,
    ).toBe(false);
  });

  it("refuses what the writer refuses", () => {
    const good = { ...emptyDraft("ollama"), model: "m" };
    expect(checkDraft({ ...good, providerId: "openai" }).ok).toBe(false);
    expect(checkDraft({ ...good, providerId: "-c" }).ok).toBe(false);
    expect(checkDraft({ ...good, baseUrl: "file:///x" }).ok).toBe(false);
    expect(checkDraft({ ...good, baseUrl: "http://a:b@127.0.0.1/" }).ok).toBe(
      false,
    );
    expect(checkDraft({ ...good, model: "a b" }).ok).toBe(false);
    expect(checkDraft({ ...good, contextWindow: "12" }).ok).toBe(false);
    expect(checkDraft({ ...good, envKey: "sk-live-123" }).ok).toBe(false);
    expect(checkDraft({ ...good, instructions: "x".repeat(70_000) }).ok).toBe(
      false,
    );
  });

  it("starts from a detected server", () => {
    const draft = draftFromDetected({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: ["qwen2.5:7b", "llama3.1:8b"],
    });
    expect(draft.model).toBe("qwen2.5:7b");
    expect(draft.instructions).toBe(DEFAULT_INSTRUCTIONS);
    expect(DEFAULT_INSTRUCTIONS).toContain("exec_command");
    expect(DEFAULT_INSTRUCTIONS).not.toMatch(/\bshell tool\b/);
  });
});

describe("writer call", () => {
  it("sends a typed spec with no key", async () => {
    vi.mocked(invoke).mockResolvedValue({ dir: "/d", files: ["a", "b", "c"] });
    const draft = { ...emptyDraft("openrouter"), model: "qwen/qwen3.8-27b" };
    const check = checkDraft(draft);
    if (!check.ok) throw new Error(check.error);
    await writeCodexHome("account-1", draft, check);
    const [command, args] = vi.mocked(invoke).mock.calls[0];
    expect(command).toBe("model_setup_write_codex_home");
    const spec = (args as { spec: Record<string, unknown> }).spec;
    expect(spec).toMatchObject({
      accountId: "account-1",
      providerId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      envKey: "OPENROUTER_API_KEY",
      contextWindow: null,
    });
    expect(JSON.stringify(spec)).not.toMatch(/sk-|apiKey/);
    expect(entryFromDraft("account-1", draft, check)).toMatchObject({
      id: "openrouter",
      kind: "openrouter",
      accountId: "account-1",
    });
  });

  it("detection returns an empty list on a bad reply", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await detectModelServers()).toEqual([]);
  });
});

describe("setup section", () => {
  it("lists providers with a local or hosted mark", () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
    });
    saveModelProvider({
      id: "rented",
      label: "3090",
      kind: "rented",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    const html = renderToStaticMarkup(createElement(ModelSetupSection));
    expect(html).toContain('data-model-provider="ollama_local"');
    expect(html).toMatch(
      /data-model-provider="ollama_local".*?data-locality="local"/s,
    );
    expect(html).toMatch(
      /data-model-provider="rented".*?data-locality="hosted"/s,
    );
    expect(html).toContain("Find servers on this Mac");
  });

  it("renders with no providers and no storage", () => {
    vi.stubGlobal("localStorage", undefined);
    const html = renderToStaticMarkup(createElement(ModelSetupSection));
    expect(html).toContain("data-model-setup");
  });
});
