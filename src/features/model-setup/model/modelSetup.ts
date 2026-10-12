import { invoke } from "@tauri-apps/api/core";
import { sanitizeModelProvider } from "./modelProvider";
import { isLoopbackUrl, parseHttpUrl } from "./loopback";
import { buildCatalog } from "./catalogTemplate";
import type { ModelProviderEntry, ModelProviderKind } from "./modelProviders";

/** A server found on this machine by the loopback probe. */
export type DetectedServer = {
  kind: ModelProviderKind;
  baseUrl: string;
  models: string[];
};

export type WrittenHome = {
  dir: string;
  files: string[];
  backup?: string | null;
};

/**
 * The short instructions file from the 8 Oct run, which cut Codex's opening
 * request to about 4,100 tokens at a 16,384 token context. It names the tool
 * `exec_command`: Codex has no tool called `shell`, and a call to a tool that
 * was not offered disappears without an error on Ollama.
 */
export const DEFAULT_INSTRUCTIONS = `You are a coding agent working in the user's repository.

Run commands with the exec_command tool. There is no tool named shell.
Read a file before you change it.
Edit files by running apply_patch through exec_command:

apply_patch <<'EOF'
*** Begin Patch
*** Update File: path/to/file
@@ context line
-old line
+new line
*** End Patch
EOF

Keep answers short. Say what you changed.
`;

export const KIND_LABEL: Record<ModelProviderKind, string> = {
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  lmstudio: "LM Studio",
  vllm: "vLLM",
  openrouter: "OpenRouter",
  rented: "Rented machine",
  custom: "Other server",
};

/** Kinds whose server is never this machine, whatever the URL says. */
export function kindIsHosted(kind: ModelProviderKind): boolean {
  return kind === "openrouter" || kind === "rented";
}

export type SetupDraft = {
  kind: ModelProviderKind;
  providerId: string;
  label: string;
  baseUrl: string;
  model: string;
  contextWindow: string;
  envKey: string;
  instructions: string;
};

export type DraftCheck =
  | {
      ok: true;
      providerId: string;
      baseUrl: string;
      contextWindow?: number;
      envKey?: string;
      local: boolean;
    }
  | { ok: false; error: string };

/** Checks a draft the way the Rust writer will, so errors show before a write. */
export function checkDraft(draft: SetupDraft): DraftCheck {
  const providerId = sanitizeModelProvider(draft.providerId);
  if (!providerId || providerId === "openai")
    return {
      ok: false,
      error:
        "Provider id: letters, digits, dot, dash or underscore. Not openai.",
    };
  const url = parseHttpUrl(draft.baseUrl);
  if (!url || url.username || url.password)
    return {
      ok: false,
      error: "Base URL: an http or https address with no user name.",
    };
  const model = draft.model.trim();
  if (!model || model.length > 200 || /[\s"'\\]/.test(model))
    return { ok: false, error: "Model: the name the server expects." };
  let contextWindow: number | undefined;
  if (draft.contextWindow.trim()) {
    const value = Number(draft.contextWindow.trim());
    if (!Number.isInteger(value) || value < 1_024 || value > 10_000_000)
      return { ok: false, error: "Context window: 1,024 to 10,000,000." };
    contextWindow = value;
  }
  const envKey = draft.envKey.trim() || undefined;
  if (envKey && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(envKey))
    return {
      ok: false,
      error: "Key variable: capital letters, digits and underscores.",
    };
  if (draft.instructions.length > 64 * 1024)
    return { ok: false, error: "Instructions: at most 64 KB." };
  const local = !kindIsHosted(draft.kind) && isLoopbackUrl(url.toString());
  return {
    ok: true,
    providerId,
    baseUrl: url.toString().replace(/\/$/, ""),
    contextWindow,
    envKey,
    local,
  };
}

export async function detectModelServers(): Promise<DetectedServer[]> {
  const found = await invoke<DetectedServer[]>("model_setup_detect");
  return Array.isArray(found) ? found : [];
}

/** Writes the Codex home for a checked draft into the given named account. */
export async function writeCodexHome(
  accountId: string,
  draft: SetupDraft,
  check: Extract<DraftCheck, { ok: true }>,
): Promise<WrittenHome> {
  const model = draft.model.trim();
  const label = draft.label.trim() || KIND_LABEL[draft.kind];
  return invoke<WrittenHome>("model_setup_write_codex_home", {
    spec: {
      accountId,
      providerId: check.providerId,
      providerName: label,
      baseUrl: check.baseUrl,
      model,
      contextWindow: check.contextWindow ?? null,
      envKey: check.envKey ?? null,
      instructions: draft.instructions,
      catalog: buildCatalog({
        model,
        displayName: `${model} (${label})`,
        contextWindow: check.contextWindow,
        instructions: draft.instructions,
      }),
    },
  });
}

/** The list entry saved once a home is written. */
export function entryFromDraft(
  accountId: string,
  draft: SetupDraft,
  check: Extract<DraftCheck, { ok: true }>,
): ModelProviderEntry {
  return {
    id: check.providerId,
    label: draft.label.trim() || KIND_LABEL[draft.kind],
    kind: draft.kind,
    baseUrl: check.baseUrl,
    accountId,
    model: draft.model.trim(),
    ...(check.contextWindow ? { contextWindow: check.contextWindow } : {}),
    ...(check.envKey ? { envKey: check.envKey } : {}),
  };
}

/** A draft filled from a detected server. */
export function draftFromDetected(server: DetectedServer): SetupDraft {
  return {
    kind: server.kind,
    providerId: `${server.kind}_local`,
    label: `${KIND_LABEL[server.kind]} on this Mac`,
    baseUrl: server.baseUrl,
    model: server.models[0] ?? "",
    contextWindow: "16384",
    envKey: "",
    instructions: DEFAULT_INSTRUCTIONS,
  };
}

export function emptyDraft(kind: ModelProviderKind = "ollama"): SetupDraft {
  const defaults: Record<ModelProviderKind, string> = {
    ollama: "http://127.0.0.1:11434/v1",
    lmstudio: "http://127.0.0.1:1234/v1",
    llamacpp: "http://127.0.0.1:8080/v1",
    vllm: "http://127.0.0.1:8000/v1",
    openrouter: "https://openrouter.ai/api/v1",
    rented: "http://127.0.0.1:8080/v1",
    custom: "http://127.0.0.1:8080/v1",
  };
  return {
    kind,
    providerId: kindIsHosted(kind) ? kind : `${kind}_local`,
    label: KIND_LABEL[kind],
    baseUrl: defaults[kind],
    model: "",
    contextWindow: kind === "openrouter" ? "" : "16384",
    envKey: kind === "openrouter" ? "OPENROUTER_API_KEY" : "",
    instructions: DEFAULT_INSTRUCTIONS,
  };
}
