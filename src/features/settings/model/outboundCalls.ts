import { useSyncExternalStore } from "react";

/**
 * Off switches for the calls MonoCode itself makes to outside hosts. Every
 * switch is on by default, which keeps today's behaviour. Off means the call
 * is not made at all: each caller checks `outboundCallAllowed` before it
 * sends anything.
 */
export type OutboundCallId =
  "link-previews" | "usage" | "version-check" | "star-check";

export type OutboundCall = {
  id: OutboundCallId;
  label: string;
  /** The hosts the call reaches, as shown in Settings. */
  hosts: readonly string[];
  description: string;
};

export const OUTBOUND_CALLS: readonly OutboundCall[] = [
  {
    id: "link-previews",
    label: "Link previews",
    hosts: ["the linked site", "api.github.com (through gh)"],
    description:
      "Fetches the title and icon of the first link in a message you send. GitHub issue and pull request links are read through gh. Off, the link stays a plain link.",
  },
  {
    id: "usage",
    label: "Usage figures",
    hosts: [
      "api.anthropic.com",
      "opencode.ai",
      "chatgpt.com",
      "server.codeium.com",
    ],
    description:
      "Reads plan usage for Claude Code, OpenCode Go, Pi and Devin accounts. Off, the usage meters show that usage is off. Codex usage comes from the Codex process and is not covered here.",
  },
  {
    id: "version-check",
    label: "Version check at launch",
    hosts: ["registry.npmjs.org"],
    description:
      "Looks up the newest Claude Code, Codex, OpenCode and Pi releases once per launch and offers an update.",
  },
  {
    id: "star-check",
    label: "GitHub star check",
    hosts: ["api.github.com (through gh)"],
    description:
      "Asks gh whether your GitHub account starred the MonoCode repository, on launch and when a window gains focus. Off, the star prompt stays hidden.",
  },
];

export type OutboundCallSettings = Record<OutboundCallId, boolean>;

export const OUTBOUND_CALLS_KEY = "monocode.outboundCalls";
export const OUTBOUND_CALLS_CHANGE_EVENT = "monocode:outboundcallschange";

/** Shown where a call's result would be when its switch is off. */
export const OUTBOUND_CALL_OFF_MESSAGE =
  "Off in Settings, General, Outbound calls";

const IDS: readonly OutboundCallId[] = OUTBOUND_CALLS.map((call) => call.id);

export function isOutboundCallId(value: unknown): value is OutboundCallId {
  return typeof value === "string" && IDS.includes(value as OutboundCallId);
}

export function defaultOutboundCalls(): OutboundCallSettings {
  return {
    "link-previews": true,
    usage: true,
    "version-check": true,
    "star-check": true,
  };
}

/** Stored settings read back: known ids with boolean values, the rest default. */
export function sanitizeOutboundCalls(value: unknown): OutboundCallSettings {
  const out = defaultOutboundCalls();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  for (const id of IDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const entry = raw[id];
    if (typeof entry === "boolean") out[id] = entry;
  }
  return out;
}

let cache: OutboundCallSettings | null = null;

export function loadOutboundCalls(): OutboundCallSettings {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = localStorage.getItem(OUTBOUND_CALLS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  cache = sanitizeOutboundCalls(parsed);
  return cache;
}

/** Synchronous read for the place a call fires. Unknown ids are refused. */
export function outboundCallAllowed(id: OutboundCallId): boolean {
  if (!isOutboundCallId(id)) return false;
  return loadOutboundCalls()[id];
}

export function setOutboundCallAllowed(
  id: OutboundCallId,
  allowed: boolean,
): void {
  if (!isOutboundCallId(id) || typeof allowed !== "boolean") return;
  const next = { ...loadOutboundCalls(), [id]: allowed };
  cache = sanitizeOutboundCalls(next);
  try {
    localStorage.setItem(OUTBOUND_CALLS_KEY, JSON.stringify(cache));
  } catch {
    // Private mode or quota: the change holds for this window only.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OUTBOUND_CALLS_CHANGE_EVENT));
  }
}

/** Test seam: forget the in-memory copy so the next load reads storage. */
export function resetOutboundCallsCache(): void {
  cache = null;
}

/** Calls `onChange` when a switch changes, in this window or another. */
export function subscribeOutboundCalls(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== OUTBOUND_CALLS_KEY && event.key !== null) return;
    cache = null;
    onChange();
  };
  window.addEventListener(OUTBOUND_CALLS_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(OUTBOUND_CALLS_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Every switch, re-rendering when one changes. */
export function useOutboundCalls(): OutboundCallSettings {
  return useSyncExternalStore(
    subscribeOutboundCalls,
    loadOutboundCalls,
    loadOutboundCalls,
  );
}

export function useOutboundCallAllowed(id: OutboundCallId): boolean {
  return useSyncExternalStore(
    subscribeOutboundCalls,
    () => outboundCallAllowed(id),
    () => outboundCallAllowed(id),
  );
}
