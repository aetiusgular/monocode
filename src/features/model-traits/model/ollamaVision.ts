import { invoke, isTauri } from "@tauri-apps/api/core";
import { findModel } from "../../sessions/model/models";
import type { Session } from "../../sessions/model/session";
import { findModelProvider } from "../../model-setup/model/modelProviders";
import { isLoopbackUrl } from "../../model-setup/model/loopback";
import { sessionModelProvider } from "../../model-setup/model/sessionProvider";
import {
  loadTraitOverrides,
  MODEL_TRAITS_CHANGE_EVENT,
  modelTraits,
} from "./modelTraits";

/**
 * Vision for a model on Ollama, from Ollama itself (Mac test 4.11).
 *
 * Codex's metadata for a model it does not know claims image input: its
 * `default_input_modalities` is text and image (Codex 0.161.0
 * `protocol/src/openai_models.rs:191-192`). So the catalog cannot be trusted
 * for a local model. Ollama's `POST /api/show` lists what the model can do
 * in `capabilities`, `"vision"` among them
 * (https://github.com/ollama/ollama/blob/main/docs/api.md, "Show Model
 * Information"; `types/model/capability.go`). The window's content policy
 * keeps it from calling Ollama, so the app asks, on loopback only
 * (`model_setup_ollama_capabilities`).
 *
 * Until the answer is in, and when the call fails, vision is unknown, which
 * callers treat as "not able".
 */

export type OllamaRoute = { baseUrl: string; model: string };

type Entry =
  | { state: "pending" }
  | { state: "known"; vision: boolean }
  | { state: "failed"; at: number };

/** A failed ask is tried again after this, in case Ollama was starting. */
const RETRY_MS = 30_000;
const MAX_ENTRIES = 200;

const cache = new Map<string, Entry>();

function inApp(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

function changed(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MODEL_TRAITS_CHANGE_EVENT));
  }
}

/**
 * Whether Ollama says the model reads images: true or false once it has
 * answered, undefined while asking or after a failure. The first call for a
 * base URL and model starts the ask; the answer is kept for the window's
 * life.
 */
export function ollamaVision(route: OllamaRoute): boolean | undefined {
  const key = `${route.baseUrl}\n${route.model}`;
  const entry = cache.get(key);
  if (entry?.state === "known") return entry.vision;
  if (entry?.state === "pending") return undefined;
  if (entry?.state === "failed" && Date.now() - entry.at < RETRY_MS) {
    return undefined;
  }
  if (!inApp() || !isLoopbackUrl(route.baseUrl)) return undefined;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { state: "pending" });
  invoke<unknown>("model_setup_ollama_capabilities", {
    baseUrl: route.baseUrl,
    model: route.model,
  })
    .then((capabilities) => {
      if (!Array.isArray(capabilities)) throw new Error("malformed");
      cache.set(key, {
        state: "known",
        vision: capabilities.includes("vision"),
      });
      changed();
    })
    .catch(() => {
      cache.set(key, { state: "failed", at: Date.now() });
      changed();
    });
  return undefined;
}

export type OllamaSession = Pick<Session, "harness"> &
  Partial<Pick<Session, "model" | "modelProvider" | "providerAccountId">>;

/**
 * The Ollama server and model name a chat runs on, when its provider is
 * Ollama: one you set up with kind "ollama", or Codex's built-in `ollama`.
 */
export function sessionOllama(
  session: OllamaSession,
  modelId: string | undefined = session.model,
): OllamaRoute | undefined {
  const provider = findModelProvider(sessionModelProvider(session));
  if (!provider) return undefined;
  const isOllama = provider.entry
    ? provider.entry.kind === "ollama"
    : provider.id === "ollama";
  if (!isOllama) return undefined;
  const prefix = `${session.harness}:`;
  const model =
    (modelId ? findModel(modelId)?.nativeId : undefined) ??
    (modelId?.startsWith(prefix) ? modelId.slice(prefix.length) : modelId) ??
    provider.entry?.model;
  if (!model) return undefined;
  return { baseUrl: provider.baseUrl, model };
}

/**
 * Whether a feature may send this chat's model images. On Ollama, Ollama's
 * answer stands in for the catalog and the harness; your own setting under
 * Settings, Models still wins.
 */
export function sessionModelReadsImages(
  session: OllamaSession,
  modelId: string,
): boolean {
  const route = sessionOllama(session, modelId);
  if (!route) return modelTraits(modelId).vision === true;
  return (
    modelTraits(modelId, loadTraitOverrides(), {
      vision: ollamaVision(route),
    }).vision === true
  );
}

/** For tests: forget every answer. */
export function resetOllamaVisionForTest(): void {
  cache.clear();
}
