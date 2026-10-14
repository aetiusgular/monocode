import { useSyncExternalStore } from "react";
import type { BuiltPreamble } from "./preamble";

/**
 * Per-chat switches for the preamble (rule 9 of the step 3c plan: anything
 * that costs context is switched on per chat), kept in this browser's storage
 * by session id so a reload keeps them. Memory can be switched off for
 * reading and writing, which covers what incognito chats do in the Claude app.
 */
export type ChatContextPrefs = {
  /** Project memory is neither read into nor written from this chat. */
  memoryOff?: boolean;
};

const KEY = "monocode.chatContext";
const MAX = 1000;
const CHANGED = "monocode:chat-context-changed";

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function loadAll(): Record<string, ChatContextPrefs> {
  try {
    const raw = storage()?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, ChatContextPrefs> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (id === "__proto__" || !value || typeof value !== "object") continue;
      if ((value as ChatContextPrefs).memoryOff === true)
        out[id] = { memoryOff: true };
    }
    return out;
  } catch {
    return {};
  }
}

export function chatContextPrefs(sessionId: string): ChatContextPrefs {
  return loadAll()[sessionId] ?? {};
}

export function setChatMemoryOff(sessionId: string, off: boolean): void {
  const all = loadAll();
  if (off) all[sessionId] = { ...all[sessionId], memoryOff: true };
  else delete all[sessionId];
  const ids = Object.keys(all);
  // Oldest insertions go first when the list is full.
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX))) delete all[id];
  try {
    storage()?.setItem(KEY, JSON.stringify(all));
  } catch {
    // The switch then lasts until the app reloads.
  }
  notify();
}

export function forgetChatContext(sessionId: string): void {
  const all = loadAll();
  if (!(sessionId in all)) return;
  delete all[sessionId];
  try {
    storage()?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Nothing to keep.
  }
  reports.delete(sessionId);
  notify();
}

/** What the last turn's preamble held, for the session panel. */
export type PreambleReport = Pick<
  BuiltPreamble,
  "chars" | "budget" | "included" | "omitted" | "overBudget"
> & {
  /**
   * How it went: the whole note by message, MonoCode's own parts by message
   * ("app"), natively at launch, or not at all (unchanged).
   */
  channel: "message" | "app" | "native" | "unchanged" | "none";
  /**
   * Finding 2.2: your instructions or project notes changed after this
   * chat's conversation started. They apply to new chats only.
   */
  stale?: boolean;
  at: number;
};

const reports = new Map<string, PreambleReport>();
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const listener of listeners) listener();
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(CHANGED));
}

export function reportPreamble(
  sessionId: string,
  report: PreambleReport,
): void {
  reports.set(sessionId, report);
  notify();
}

/** Re-render the Context section and the stale line after a receipt. */
export function notifyChatContext(): void {
  notify();
}

export function preambleReport(sessionId: string): PreambleReport | undefined {
  return reports.get(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when a switch or a report changes. */
export function useChatContextVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
