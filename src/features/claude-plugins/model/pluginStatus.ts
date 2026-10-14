import { useSyncExternalStore } from "react";
import type { ManageResult } from "./pluginManage";

/**
 * Where a plugin action's result line shows: under the installed list (update
 * and uninstall, whose row can vanish), in the install form, or in the
 * marketplaces section.
 */
export type PluginStatusPlace = "installed" | "install" | "marketplaces";

export type PluginStatus = {
  place: PluginStatusPlace;
  result: ManageResult;
};

// One line for the whole page: the latest action's own result, so an older
// action's line never stands in for a newer one (Mac 4.12).
let current: PluginStatus | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function reportPluginStatus(
  place: PluginStatusPlace,
  result: ManageResult,
): void {
  current = { place, result };
  emit();
}

export function clearPluginStatus(place?: PluginStatusPlace): void {
  if (!current || (place && current.place !== place)) return;
  current = null;
  emit();
}

export function getPluginStatus(): PluginStatus | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The latest action's result when it belongs to `place`, else null. */
export function usePluginStatus(place: PluginStatusPlace): ManageResult | null {
  const status = useSyncExternalStore(
    subscribe,
    getPluginStatus,
    getPluginStatus,
  );
  return status?.place === place ? status.result : null;
}

/** A finished change that printed nothing still gets a line of its own. */
export function withFallbackMessage(
  result: ManageResult,
  done: string,
): ManageResult {
  if (result.ok && !result.message.trim()) return { ok: true, message: done };
  return result;
}
