import { invoke } from "@tauri-apps/api/core";
import { modelCallsToolsReliably } from "../../model-traits/model/modelTraits";
import { sanitizeModelProvider } from "./modelProvider";
import {
  findModelProvider,
  providerForAccount,
  type ModelProviderEntry,
} from "./modelProviders";
import { providerLocality } from "./providerLocality";

/**
 * Edit adapter for small models (session 10). A loopback proxy in MonoCode,
 * between Codex and a local model server, that offers the model plain
 * `edit_file` and `write_file` tools and turns each call into the
 * `apply_patch` command Codex already checks and applies. Codex keeps its
 * approval card, sandbox and diff.
 *
 * Codex reaches the proxy through the thread's `config` override of the
 * provider's `base_url`, sent on `thread/start` and `thread/resume`, so no
 * file holds the port.
 */

/** Codex's built-in providers. Their config cannot be overridden by name. */
const BUILT_IN_IDS = new Set(["openai", "ollama", "lmstudio", "oss"]);

export type EditAdapterAvailability =
  { available: true } | { available: false; reason: string };

/** Whether the adapter can run for a provider at all, and why not. */
export function editAdapterAvailability(
  entry: Pick<ModelProviderEntry, "id">,
): EditAdapterAvailability {
  if (providerLocality(entry.id) !== "local")
    return {
      available: false,
      reason: "Only for a model server on this Mac.",
    };
  if (BUILT_IN_IDS.has(entry.id) || entry.id.includes("."))
    return {
      available: false,
      reason:
        "Needs a provider id that is not one of Codex's built-in names and has no dot.",
    };
  return { available: true };
}

/**
 * Whether the adapter runs for a provider and model: your switch when you set
 * it, else on when the model is not marked a reliable tool caller.
 */
export function editAdapterOn(
  entry: Pick<ModelProviderEntry, "id" | "editAdapter" | "model">,
  modelId?: string,
): boolean {
  if (!editAdapterAvailability(entry).available) return false;
  if (entry.editAdapter !== undefined) return entry.editAdapter;
  const model = modelId || entry.model;
  return !model || !modelCallsToolsReliably(model);
}

export type CodexEditAdapter = {
  /** Part of the Codex reuse key: a change reopens the thread. */
  key: string;
  providerId?: string;
  baseUrl?: string;
  /** Why the adapter was meant to run and could not; Codex then goes direct. */
  error?: string;
};

type OpenRoute = (
  sessionId: string,
  upstream: string,
  cwd: string,
) => Promise<string>;

const openRoute: OpenRoute = (sessionId, upstream, cwd) =>
  invoke<string>("edit_adapter_open", { sessionId, upstream, cwd });

/**
 * The adapter route for a Codex session, when the session runs on the named
 * Codex account the Models page wrote for its provider and the adapter is on
 * for it. A matching provider id alone is not enough: a wrapper script home
 * or the default home can carry the same id (`ollama_local`) with its own
 * base URL, and the override would replace it (Mac test 2.3, 7.9). Off,
 * unknown, another home or failed means Codex talks to the model server
 * directly, as before.
 */
export async function codexEditAdapter(
  input: {
    sessionId: string;
    cwd: string;
    model?: string;
    modelProvider?: string;
    providerAccountId?: string;
  },
  open: OpenRoute = openRoute,
): Promise<CodexEditAdapter> {
  const id =
    sanitizeModelProvider(input.modelProvider) ??
    providerForAccount(input.providerAccountId)?.id;
  const entry = findModelProvider(id)?.entry;
  if (!entry || !editAdapterOn(entry, input.model)) return { key: "" };
  if (!editAdapterAccountMatches(entry, input.providerAccountId))
    return { key: "" };
  try {
    const baseUrl = await open(input.sessionId, entry.baseUrl, input.cwd);
    return { key: `${entry.id}\n${baseUrl}`, providerId: entry.id, baseUrl };
  } catch (error) {
    return { key: "", error: String(error) };
  }
}

/** Whether the session runs on the account model setup wrote for `entry`. */
export function editAdapterAccountMatches(
  entry: Pick<ModelProviderEntry, "accountId">,
  providerAccountId: string | undefined,
): boolean {
  return Boolean(entry.accountId) && entry.accountId === providerAccountId;
}

/** The thread `config` entry that points Codex at the adapter. */
export function editAdapterConfig(
  adapter: CodexEditAdapter,
): Record<string, string> | undefined {
  if (!adapter.providerId || !adapter.baseUrl) return undefined;
  return {
    [`model_providers.${adapter.providerId}.base_url`]: adapter.baseUrl,
  };
}
