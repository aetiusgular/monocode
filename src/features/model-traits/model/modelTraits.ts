import { useSyncExternalStore } from "react";
import {
  findModel,
  type AgentModel,
  type ToolCalling,
} from "../../sessions/model/models";
import type { HarnessId } from "../../sessions/model/session";

/**
 * What a feature may assume about a model: whether it reads images, how well
 * it calls tools, whether it is slow, and its context window.
 *
 * Sources, strongest first:
 * 1. What you set under Settings, Models. A local model's catalog entry is a
 *    default, not a fact (step 3c, section 5), so your value wins.
 * 2. What the harness catalog reported: Codex `inputModalities`, the context
 *    window.
 * 3. Static traits for a harness whose models are all known: Claude models
 *    read images and call tools reliably.
 * 4. Unknown. Callers treat unknown as "not able".
 */
export type ModelTraits = {
  /** Reads images. `undefined` is unknown. */
  vision?: boolean;
  tools: ToolCalling;
  slow: boolean;
  /** Tokens, when known. */
  contextWindow?: number;
  /** Where each trait came from, for the Models page. */
  source: {
    vision: TraitSource;
    tools: TraitSource;
    slow: TraitSource;
    contextWindow: TraitSource;
  };
};

export type TraitSource = "yours" | "catalog" | "harness" | "unknown";

/** Your settings for one model id. Every field is optional. */
export type TraitOverride = {
  vision?: boolean;
  tools?: ToolCalling;
  slow?: boolean;
  contextWindow?: number;
};

const STATIC_TRAITS: Partial<
  Record<HarnessId, { vision: boolean; tools: ToolCalling; slow: boolean }>
> = {
  claude: { vision: true, tools: "reliable", slow: false },
};

export const MODEL_TRAITS_KEY = "monocode.modelTraits";
export const MODEL_TRAITS_CHANGE_EVENT = "monocode:modeltraitschange";
/** Bounds what a stored file can hold. */
export const MAX_TRAIT_OVERRIDES = 200;
export const MIN_CONTEXT_WINDOW = 1_024;
export const MAX_CONTEXT_WINDOW = 10_000_000;
const MAX_MODEL_ID_LENGTH = 200;

const TOOL_CALLING: readonly ToolCalling[] = [
  "reliable",
  "weak",
  "none",
  "unknown",
];

export function isToolCalling(value: unknown): value is ToolCalling {
  return (
    typeof value === "string" && TOOL_CALLING.includes(value as ToolCalling)
  );
}

/** A context window you typed, or undefined when it is out of range. */
export function sanitizeContextWindow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const whole = Math.floor(value);
  if (whole < MIN_CONTEXT_WINDOW || whole > MAX_CONTEXT_WINDOW)
    return undefined;
  return whole;
}

/** A model id safe to use as a key: trimmed, short, no control characters. */
export function sanitizeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > MAX_MODEL_ID_LENGTH) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) return undefined;
  if (id === "__proto__" || id === "constructor" || id === "prototype") {
    return undefined;
  }
  return id;
}

function sanitizeOverride(value: unknown): TraitOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const out: TraitOverride = {};
  if (typeof raw.vision === "boolean") out.vision = raw.vision;
  if (isToolCalling(raw.tools)) out.tools = raw.tools;
  if (typeof raw.slow === "boolean") out.slow = raw.slow;
  const ctx = sanitizeContextWindow(raw.contextWindow);
  if (ctx != null) out.contextWindow = ctx;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Stored overrides read back: valid entries only, bounded in number. */
export function sanitizeTraitOverrides(
  value: unknown,
): Record<string, TraitOverride> {
  const out: Record<string, TraitOverride> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= MAX_TRAIT_OVERRIDES) break;
    const id = sanitizeModelId(key);
    const override = sanitizeOverride(entry);
    if (!id || !override) continue;
    out[id] = override;
    count += 1;
  }
  return out;
}

let cache: Record<string, TraitOverride> | null = null;

export function loadTraitOverrides(): Record<string, TraitOverride> {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = localStorage.getItem(MODEL_TRAITS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  cache = sanitizeTraitOverrides(parsed);
  return cache;
}

function storeOverrides(next: Record<string, TraitOverride>) {
  cache = sanitizeTraitOverrides(next);
  try {
    localStorage.setItem(MODEL_TRAITS_KEY, JSON.stringify(cache));
  } catch {
    // Private mode or quota: the change holds for this window only.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MODEL_TRAITS_CHANGE_EVENT));
  }
}

/**
 * Set or clear your traits for one model. A field set to `undefined` is
 * cleared. An empty result removes the model's entry.
 */
export function saveTraitOverride(
  modelId: string,
  patch: Partial<Record<keyof TraitOverride, unknown>>,
): void {
  const id = sanitizeModelId(modelId);
  if (!id) return;
  const current = { ...loadTraitOverrides() };
  const merged: Record<string, unknown> = { ...(current[id] ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const clean = sanitizeOverride(merged);
  if (clean) current[id] = clean;
  else delete current[id];
  storeOverrides(current);
}

export function clearTraitOverride(modelId: string): void {
  const id = sanitizeModelId(modelId);
  if (!id) return;
  const current = { ...loadTraitOverrides() };
  if (!(id in current)) return;
  delete current[id];
  storeOverrides(current);
}

/** Test seam: forget the in-memory copy so the next load reads storage. */
export function resetTraitOverridesCache(): void {
  cache = null;
}

let version = 0;
function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const bump = () => {
    version += 1;
    onChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== MODEL_TRAITS_KEY && event.key !== null) return;
    cache = null;
    bump();
  };
  window.addEventListener(MODEL_TRAITS_CHANGE_EVENT, bump);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(MODEL_TRAITS_CHANGE_EVENT, bump);
    window.removeEventListener("storage", onStorage);
  };
}

/** Re-renders when any override changes, in this window or another. */
export function useTraitOverridesVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

function harnessOf(id: string): HarnessId | undefined {
  const colon = id.indexOf(":");
  return colon > 0 ? (id.slice(0, colon) as HarnessId) : undefined;
}

/**
 * The traits a feature may rely on for a model, by id or by catalog entry.
 * An id no catalog knows still gets your overrides and its harness's static
 * traits.
 */
export function modelTraits(
  model: AgentModel | string,
  overrides: Record<string, TraitOverride> = loadTraitOverrides(),
): ModelTraits {
  const entry = typeof model === "string" ? findModel(model) : model;
  const id = typeof model === "string" ? model : model.id;
  const harness = entry?.harness ?? harnessOf(id);
  const yours = overrides[id] ?? (entry ? overrides[entry.id] : undefined);
  const fixed = harness ? STATIC_TRAITS[harness] : undefined;

  const vision =
    yours?.vision !== undefined
      ? { value: yours.vision, source: "yours" as const }
      : entry?.vision !== undefined
        ? { value: entry.vision, source: "catalog" as const }
        : fixed
          ? { value: fixed.vision, source: "harness" as const }
          : { value: undefined, source: "unknown" as const };
  const tools =
    yours?.tools !== undefined
      ? { value: yours.tools, source: "yours" as const }
      : entry?.tools !== undefined
        ? { value: entry.tools, source: "catalog" as const }
        : fixed
          ? { value: fixed.tools, source: "harness" as const }
          : { value: "unknown" as const, source: "unknown" as const };
  const slow =
    yours?.slow !== undefined
      ? { value: yours.slow, source: "yours" as const }
      : entry?.slow !== undefined
        ? { value: entry.slow, source: "catalog" as const }
        : fixed
          ? { value: fixed.slow, source: "harness" as const }
          : { value: false, source: "unknown" as const };
  const catalogWindow =
    entry?.contextWindow && entry.contextWindow > 0
      ? entry.contextWindow
      : undefined;
  const contextWindow =
    yours?.contextWindow !== undefined
      ? { value: yours.contextWindow, source: "yours" as const }
      : catalogWindow !== undefined
        ? { value: catalogWindow, source: "catalog" as const }
        : { value: undefined, source: "unknown" as const };

  return {
    ...(vision.value !== undefined ? { vision: vision.value } : {}),
    tools: tools.value,
    slow: slow.value,
    ...(contextWindow.value !== undefined
      ? { contextWindow: contextWindow.value }
      : {}),
    source: {
      vision: vision.source,
      tools: tools.source,
      slow: slow.source,
      contextWindow: contextWindow.source,
    },
  };
}

/** Whether a feature may count on the model to call tools. */
export function modelCallsToolsReliably(model: AgentModel | string): boolean {
  return modelTraits(model).tools === "reliable";
}

/** Whether a feature may send the model images. */
export function modelReadsImages(model: AgentModel | string): boolean {
  return modelTraits(model).vision === true;
}

/** How much to stretch a helper timeout for this model (rule 5: 4 when slow). */
export function modelTimeoutFactor(model: AgentModel | string): number {
  return modelTraits(model).slow ? 4 : 1;
}

/** The context window a feature should budget for, or undefined. */
export function modelBudgetWindow(
  model: AgentModel | string,
): number | undefined {
  return modelTraits(model).contextWindow;
}
