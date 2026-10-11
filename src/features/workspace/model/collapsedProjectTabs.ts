import { useSyncExternalStore } from "react";
import { loadCollapsedTabGroups, saveCollapsedTabGroups } from "./tabGroups";

/**
 * Project groups the title bar shows folded to their chip, keyed by
 * `projectKey`. The title bar flips them and App reads them to skip hidden
 * tabs when cycling, so the set lives outside both components. Saved under
 * the collapsed tab-group key, which the removed Classic layout used the
 * same way.
 */

const listeners = new Set<() => void>();
let collapsed: ReadonlySet<string> | null = null;

function current(): ReadonlySet<string> {
  if (!collapsed) collapsed = loadCollapsedTabGroups();
  return collapsed;
}

export function collapsedProjectTabGroups(): ReadonlySet<string> {
  return current();
}

export function setProjectTabGroupCollapsed(key: string, next: boolean): void {
  const before = current();
  if (before.has(key) === next) return;
  const after = new Set(before);
  if (next) after.add(key);
  else after.delete(key);
  collapsed = after;
  saveCollapsedTabGroups(after);
  for (const listener of listeners) listener();
}

export function toggleProjectTabGroup(key: string): void {
  setProjectTabGroupCollapsed(key, !current().has(key));
}

export function subscribeCollapsedProjectTabGroups(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCollapsedProjectTabGroups(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeCollapsedProjectTabGroups,
    current,
    current,
  );
}

/** Tests: forget the cached set so the next read comes from storage. */
export function resetCollapsedProjectTabGroups(): void {
  collapsed = null;
}
