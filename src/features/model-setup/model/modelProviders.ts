import { useSyncExternalStore } from "react";
import { sanitizeModelProvider } from "./modelProvider";
import { isLoopbackUrl, parseHttpUrl } from "./loopback";

/**
 * Model providers set up on the Models page. Each one is a server Codex
 * talks to through the Responses route, written into its own Codex home (a
 * named Codex account) so a local home never holds a hosted provider.
 *
 * The list lives in localStorage under `monocode.modelProviders`. It holds
 * no key: an OpenRouter key stays in the environment variable the provider
 * names, never in this list or in any file the screen writes.
 */
export type ModelProviderKind =
  | "ollama"
  | "llamacpp"
  | "lmstudio"
  | "vllm"
  | "openrouter"
  /** A rented or remote machine, even when reached through a loopback tunnel. */
  | "rented"
  | "custom";

export type ModelProviderEntry = {
  /** Codex provider id, the `model_providers.<id>` key. */
  id: string;
  label: string;
  kind: ModelProviderKind;
  /** Responses route base, for example `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** Named Codex account whose home holds this provider. */
  accountId?: string;
  /** Model slug the server expects. */
  model?: string;
  contextWindow?: number;
  /** Environment variable holding the key, for a hosted provider. */
  envKey?: string;
};

export const MODEL_PROVIDERS_KEY = "monocode.modelProviders";
export const MODEL_PROVIDERS_CHANGE_EVENT = "monocode:modelproviderschange";
export const MAX_MODEL_PROVIDERS = 50;
const MAX_LABEL = 80;
const MAX_MODEL = 200;

const KINDS: readonly ModelProviderKind[] = [
  "ollama",
  "llamacpp",
  "lmstudio",
  "vllm",
  "openrouter",
  "rented",
  "custom",
];

/**
 * Providers Codex knows without any config. `openai` is hosted. The two
 * open-source ones point at this machine by default.
 */
export const BUILT_IN_PROVIDERS: Readonly<
  Record<string, { label: string; baseUrl: string }>
> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  lmstudio: { label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
};

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control characters never reach a label or a config file.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!text || text.length > max) return undefined;
  return text;
}

/** A stored entry read back, or undefined when any required part is bad. */
export function sanitizeProviderEntry(
  value: unknown,
): ModelProviderEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = sanitizeModelProvider(raw.id);
  if (!id || id === "openai") return undefined;
  const kind = KINDS.includes(raw.kind as ModelProviderKind)
    ? (raw.kind as ModelProviderKind)
    : undefined;
  if (!kind) return undefined;
  const url = parseHttpUrl(
    typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
  );
  if (!url || url.username || url.password) return undefined;
  const entry: ModelProviderEntry = {
    id,
    label: cleanText(raw.label, MAX_LABEL) ?? id,
    kind,
    baseUrl: url.toString().replace(/\/$/, ""),
  };
  if (typeof raw.accountId === "string" && ACCOUNT_ID.test(raw.accountId))
    entry.accountId = raw.accountId;
  const model = cleanText(raw.model, MAX_MODEL);
  if (model && !/[\s"'\\]/.test(model)) entry.model = model;
  if (
    typeof raw.contextWindow === "number" &&
    Number.isInteger(raw.contextWindow) &&
    raw.contextWindow >= 1_024 &&
    raw.contextWindow <= 10_000_000
  )
    entry.contextWindow = raw.contextWindow;
  if (typeof raw.envKey === "string" && ENV_KEY.test(raw.envKey))
    entry.envKey = raw.envKey;
  return entry;
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

let cache: { raw: string | null; list: ModelProviderEntry[] } | undefined;

/** Every provider you set up, sanitized, in the order they were added. */
export function modelProviders(): ModelProviderEntry[] {
  const store = storage();
  let raw: string | null = null;
  try {
    raw = store?.getItem(MODEL_PROVIDERS_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (cache && cache.raw === raw) return cache.list;
  let list: ModelProviderEntry[] = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        for (const item of parsed.slice(0, MAX_MODEL_PROVIDERS)) {
          const entry = sanitizeProviderEntry(item);
          if (!entry || seen.has(entry.id)) continue;
          seen.add(entry.id);
          list.push(entry);
        }
      }
    } catch {
      list = [];
    }
  }
  cache = { raw, list };
  return list;
}

function write(list: ModelProviderEntry[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      MODEL_PROVIDERS_KEY,
      JSON.stringify(list.slice(0, MAX_MODEL_PROVIDERS)),
    );
  } catch {
    return;
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(MODEL_PROVIDERS_CHANGE_EVENT));
}

/** Adds or replaces one provider. Returns false when the entry is invalid. */
export function saveModelProvider(entry: ModelProviderEntry): boolean {
  const clean = sanitizeProviderEntry(entry);
  if (!clean) return false;
  const list = modelProviders().filter((item) => item.id !== clean.id);
  if (list.length >= MAX_MODEL_PROVIDERS) return false;
  write([...list, clean]);
  return true;
}

export function removeModelProvider(id: string): void {
  write(modelProviders().filter((item) => item.id !== id));
}

/** A provider by id: yours first, then Codex's built-in ones. */
export function findModelProvider(
  id: string | undefined,
):
  | { id: string; label: string; baseUrl: string; entry?: ModelProviderEntry }
  | undefined {
  const clean = sanitizeModelProvider(id);
  if (!clean) return undefined;
  const entry = modelProviders().find((item) => item.id === clean);
  if (entry)
    return { id: entry.id, label: entry.label, baseUrl: entry.baseUrl, entry };
  const builtIn = BUILT_IN_PROVIDERS[clean];
  return builtIn ? { id: clean, ...builtIn } : undefined;
}

/** The provider a named Codex account was set up for, when the screen wrote it. */
export function providerForAccount(
  accountId: string | undefined,
): ModelProviderEntry | undefined {
  if (!accountId) return undefined;
  return modelProviders().find((item) => item.accountId === accountId);
}

/** Whether a provider's server is on this machine, by its parsed base URL. */
export function entryIsLocal(entry: { baseUrl: string }): boolean {
  return isLoopbackUrl(entry.baseUrl);
}

export function subscribeModelProviders(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === MODEL_PROVIDERS_KEY) listener();
  };
  window.addEventListener(MODEL_PROVIDERS_CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(MODEL_PROVIDERS_CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useModelProviders(): ModelProviderEntry[] {
  return useSyncExternalStore(
    subscribeModelProviders,
    modelProviders,
    modelProviders,
  );
}
