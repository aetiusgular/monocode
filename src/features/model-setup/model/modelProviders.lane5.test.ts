import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLoopbackHost, isLoopbackUrl, urlHost } from "./loopback";
import {
  MODEL_PROVIDERS_KEY,
  findModelProvider,
  modelProviders,
  removeModelProvider,
  sanitizeProviderEntry,
  saveModelProvider,
} from "./modelProviders";
import { providerLocality } from "./providerLocality";
import {
  autoModeAllowed,
  sessionModelProvider,
  sessionProviderLabel,
  sessionProviderLocality,
} from "./sessionProvider";

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
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loopback", () => {
  it("accepts only this machine", () => {
    expect(isLoopbackUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1234/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8080/v1")).toBe(true);
    expect(isLoopbackUrl("http://127.8.9.10/")).toBe(true);
    expect(isLoopbackUrl("https://LOCALHOST/v1")).toBe(true);
  });

  it("refuses look-alikes a prefix check would pass", () => {
    expect(isLoopbackUrl("http://localhost:@other.host/")).toBe(false);
    expect(isLoopbackUrl("http://localhost.other.host/")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.nip.io/")).toBe(false);
    expect(isLoopbackUrl("http://user:pw@127.0.0.1/")).toBe(false);
    expect(isLoopbackUrl("http://128.0.0.1/")).toBe(false);
    expect(isLoopbackUrl("http://0.0.0.0:11434/")).toBe(false);
    expect(isLoopbackUrl("http://10.0.0.5/")).toBe(false);
    expect(isLoopbackUrl("file:///etc/passwd")).toBe(false);
    expect(isLoopbackUrl("ftp://127.0.0.1/")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
  });

  it("shows a host without credentials", () => {
    expect(urlHost("http://a:b@openrouter.ai/api/v1")).toBe("openrouter.ai");
    expect(urlHost("nope")).toBeUndefined();
  });
});

describe("provider list", () => {
  it("saves, reads back and removes", () => {
    expect(
      saveModelProvider({
        id: "ollama_local",
        label: "Ollama on this Mac",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1/",
        accountId: "local-qwen",
        model: "qwen2.5:7b",
        contextWindow: 16_384,
      }),
    ).toBe(true);
    expect(modelProviders()).toEqual([
      {
        id: "ollama_local",
        label: "Ollama on this Mac",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        accountId: "local-qwen",
        model: "qwen2.5:7b",
        contextWindow: 16_384,
      },
    ]);
    removeModelProvider("ollama_local");
    expect(modelProviders()).toEqual([]);
  });

  it("drops anything a stored value could smuggle", () => {
    expect(
      sanitizeProviderEntry({
        id: "-c",
        kind: "ollama",
        baseUrl: "http://localhost",
      }),
    ).toBeUndefined();
    expect(
      sanitizeProviderEntry({
        id: "x",
        kind: "shell",
        baseUrl: "http://localhost",
      }),
    ).toBeUndefined();
    expect(
      sanitizeProviderEntry({ id: "x", kind: "custom", baseUrl: "file:///x" }),
    ).toBeUndefined();
    expect(
      sanitizeProviderEntry({
        id: "x",
        kind: "custom",
        baseUrl: "http://u:p@localhost",
      }),
    ).toBeUndefined();
    // Nobody may redefine OpenAI as a local server.
    expect(
      sanitizeProviderEntry({
        id: "openai",
        kind: "custom",
        baseUrl: "http://localhost",
      }),
    ).toBeUndefined();
    const entry = sanitizeProviderEntry({
      id: "x",
      kind: "custom",
      baseUrl: "http://localhost:1/v1",
      accountId: "../../etc",
      model: 'q"; rm -rf ~',
      envKey: "lower case",
      contextWindow: 5,
      label: "a\u0007b",
    });
    expect(entry).toEqual({
      id: "x",
      label: "ab",
      kind: "custom",
      baseUrl: "http://localhost:1/v1",
    });
  });

  it("survives a broken stored value", () => {
    localStorage.setItem(MODEL_PROVIDERS_KEY, "{not json");
    expect(modelProviders()).toEqual([]);
    localStorage.setItem(
      MODEL_PROVIDERS_KEY,
      JSON.stringify([
        { id: "a", kind: "vllm", baseUrl: "http://127.0.0.1:8000/v1" },
        { id: "a", kind: "vllm", baseUrl: "http://evil/" },
        7,
      ]),
    );
    expect(modelProviders().map((item) => item.baseUrl)).toEqual([
      "http://127.0.0.1:8000/v1",
    ]);
  });

  it("works when storage throws (corner case 14, private window)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(modelProviders()).toEqual([]);
    expect(
      saveModelProvider({
        id: "a",
        label: "a",
        kind: "vllm",
        baseUrl: "http://127.0.0.1/v1",
      }),
    ).toBe(true);
  });
});

describe("providerLocality", () => {
  it("reads the base URL, not the name", () => {
    saveModelProvider({
      id: "box",
      label: "Box",
      kind: "vllm",
      baseUrl: "http://192.168.1.9:8000/v1",
    });
    saveModelProvider({
      id: "mine",
      label: "Mine",
      kind: "llamacpp",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    saveModelProvider({
      id: "tunnel",
      label: "3090",
      kind: "rented",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    saveModelProvider({
      id: "openrouter",
      label: "OpenRouter",
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      envKey: "OPENROUTER_API_KEY",
    });
    expect(providerLocality("mine")).toBe("local");
    expect(providerLocality("box")).toBe("hosted");
    // A rented GPU behind an SSH tunnel is hosted, though its URL is loopback.
    expect(providerLocality("tunnel")).toBe("hosted");
    expect(providerLocality("openrouter")).toBe("hosted");
  });

  it("knows Codex's built-ins and nothing else", () => {
    expect(providerLocality("openai")).toBe("hosted");
    expect(providerLocality("ollama")).toBe("local");
    expect(providerLocality("lmstudio")).toBe("local");
    expect(providerLocality("someone-else")).toBe("unknown");
    expect(providerLocality(undefined)).toBe("unknown");
    expect(providerLocality("$(x)")).toBe("unknown");
  });

  it("lets your entry override a built-in id", () => {
    saveModelProvider({
      id: "ollama",
      label: "Ollama box",
      kind: "ollama",
      baseUrl: "http://10.0.0.2:11434/v1",
    });
    expect(findModelProvider("ollama")?.label).toBe("Ollama box");
    expect(providerLocality("ollama")).toBe("hosted");
  });
});

describe("session provider", () => {
  it("follows the chat, then the account the screen wrote", () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      accountId: "local",
    });
    expect(
      sessionModelProvider({ harness: "codex", providerAccountId: "local" }),
    ).toBe("ollama_local");
    expect(
      sessionModelProvider({
        harness: "codex",
        modelProvider: "openai",
        providerAccountId: "local",
      }),
    ).toBe("openai");
    expect(
      sessionModelProvider({
        harness: "claude",
        modelProvider: "ollama_local",
      }),
    ).toBeUndefined();
    expect(
      sessionProviderLabel({ harness: "codex", providerAccountId: "local" }),
    ).toBe("Ollama");
    expect(
      sessionProviderLocality({ harness: "codex", providerAccountId: "local" }),
    ).toBe("local");
    // The wrapper script: MonoCode cannot see the provider.
    expect(sessionProviderLocality({ harness: "codex" })).toBe("unknown");
    expect(sessionProviderLocality({ harness: "claude" })).toBe("hosted");
    expect(sessionProviderLocality({ harness: "opencode" })).toBe("unknown");
  });

  it("hides Auto only once the chat is known to run off OpenAI", () => {
    saveModelProvider({
      id: "ollama_local",
      label: "Ollama",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      accountId: "local",
    });
    expect(autoModeAllowed({ harness: "codex" })).toBe(true);
    expect(autoModeAllowed({ harness: "codex", modelProvider: "openai" })).toBe(
      true,
    );
    expect(
      autoModeAllowed({ harness: "codex", modelProvider: "ollama_local" }),
    ).toBe(false);
    expect(
      autoModeAllowed({ harness: "codex", providerAccountId: "local" }),
    ).toBe(false);
    expect(autoModeAllowed({ harness: "claude" })).toBe(true);
  });
});
