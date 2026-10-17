import { useSyncExternalStore } from "react";

/**
 * Harness telemetry switches (wave 3, lane A). Local only: the receiver is on
 * loopback and nothing it gets leaves the Mac.
 *
 * - `enabled`: Claude Code and Codex chats export their own OpenTelemetry
 *   events to MonoCode's receiver. On by default, as the plan's call 5 says.
 * - `logPrompts`: the harnesses include prompt text. Off by default.
 *
 * Read at a harness's start. The stored text is also part of each harness's
 * restart key (claude.ts `settingsKeyFor`, codex.ts `ensureLive`), which read
 * `HARNESS_TELEMETRY_KEY` from storage themselves, so a change restarts the
 * harness on the chat's next turn.
 */
export type HarnessTelemetrySettings = {
  enabled: boolean;
  logPrompts: boolean;
};

/** The storage key. claude.ts and codex.ts name it literally; keep in step. */
export const HARNESS_TELEMETRY_KEY = "monocode.harnessTelemetry";
export const HARNESS_TELEMETRY_CHANGE_EVENT = "monocode:harnesstelemetrychange";

export function defaultHarnessTelemetry(): HarnessTelemetrySettings {
  return { enabled: true, logPrompts: false };
}

export function sanitizeHarnessTelemetry(
  value: unknown,
): HarnessTelemetrySettings {
  const out = defaultHarnessTelemetry();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.logPrompts === "boolean") out.logPrompts = raw.logPrompts;
  return out;
}

let cache: HarnessTelemetrySettings | null = null;

export function loadHarnessTelemetry(): HarnessTelemetrySettings {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = localStorage.getItem(HARNESS_TELEMETRY_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  cache = sanitizeHarnessTelemetry(parsed);
  return cache;
}

/** The restart key part: the stored text, as the harness adapters read it. */
export function harnessTelemetryKey(): string {
  try {
    return localStorage.getItem(HARNESS_TELEMETRY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setHarnessTelemetry(
  patch: Partial<HarnessTelemetrySettings>,
): void {
  const next = sanitizeHarnessTelemetry({ ...loadHarnessTelemetry(), ...patch });
  cache = next;
  try {
    localStorage.setItem(HARNESS_TELEMETRY_KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the switch still holds for this run.
  }
  try {
    window.dispatchEvent(new Event(HARNESS_TELEMETRY_CHANGE_EVENT));
  } catch {
    // No window (tests).
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== HARNESS_TELEMETRY_KEY) return;
    cache = null;
    onChange();
  };
  window.addEventListener(HARNESS_TELEMETRY_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(HARNESS_TELEMETRY_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useHarnessTelemetry(): HarnessTelemetrySettings {
  return useSyncExternalStore(
    subscribe,
    loadHarnessTelemetry,
    loadHarnessTelemetry,
  );
}

/** For tests: forget the cached read. */
export function __resetHarnessTelemetryCache(): void {
  cache = null;
}
