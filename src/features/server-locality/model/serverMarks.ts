import { useSyncExternalStore } from "react";

/**
 * Your marks on MCP servers: "local" for a server that keeps what it is given
 * on this Mac, "hosted" for one that sends it to a service. Keyed by the
 * server name a session sees. A mark beats every rule in `serverLocality`.
 *
 * A server that calls a hosted API is hosted even when it runs on the Mac
 * (build plan, privacy model): only you can say a stdio server does not.
 */
export type ServerMark = "local" | "hosted";

export const SERVER_MARKS_KEY = "monocode.serverLocality";
export const MAX_SERVER_MARKS = 200;
const MAX_NAME = 200;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeServerName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > MAX_NAME) return undefined;
  // Control characters never belong in a server name.
  if (/[\u0000-\u001f\u007f]/.test(name)) return undefined;
  if (FORBIDDEN.has(name)) return undefined;
  return name;
}

export function sanitizeServerMarks(value: unknown): Record<string, ServerMark> {
  const out: Record<string, ServerMark> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, mark] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_SERVER_MARKS) break;
    const name = sanitizeServerName(key);
    if (!name || (mark !== "local" && mark !== "hosted")) continue;
    out[name] = mark;
    count += 1;
  }
  return out;
}

let cache: Record<string, ServerMark> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadServerMarks(): Record<string, ServerMark> {
  if (cache) return cache;
  let parsed: unknown = undefined;
  try {
    const raw = storage()?.getItem(SERVER_MARKS_KEY);
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  cache = sanitizeServerMarks(parsed);
  return cache;
}

function store(next: Record<string, ServerMark>): void {
  cache = sanitizeServerMarks(next);
  try {
    storage()?.setItem(SERVER_MARKS_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: the mark lasts for this app run only.
  }
  version += 1;
  for (const notify of listeners) notify();
}

/** Mark a server, or clear its mark with `undefined`. */
export function setServerMark(name: string, mark: ServerMark | undefined): void {
  const key = sanitizeServerName(name);
  if (!key) return;
  const current = { ...loadServerMarks() };
  if (mark === undefined) {
    if (!(key in current)) return;
    delete current[key];
  } else {
    if (
      current[key] !== mark &&
      !(key in current) &&
      Object.keys(current).length >= MAX_SERVER_MARKS
    ) {
      return;
    }
    current[key] = mark;
  }
  store(current);
}

export function serverMark(name: string): ServerMark | undefined {
  const key = sanitizeServerName(name);
  return key ? loadServerMarks()[key] : undefined;
}

/** Test seam: forget the in-memory copy so the next load reads storage. */
export function resetServerMarksCache(): void {
  cache = null;
}

export function subscribeServerMarks(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Re-renders when a mark changes. The value is a counter, not the marks. */
export function useServerMarksVersion(): number {
  return useSyncExternalStore(
    subscribeServerMarks,
    () => version,
    () => version,
  );
}
