import { useSyncExternalStore } from "react";

/**
 * Off switches for the calls MonoCode itself makes to outside hosts. Every
 * switch is on by default, which keeps today's behaviour. Off means the call
 * is not made at all: each caller checks `outboundCallAllowed` before it
 * sends anything.
 */
export type OutboundCallId =
  "link-previews" | "usage" | "version-check" | "star-check" | "github-lookups";

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
  {
    id: "github-lookups",
    label: "GitHub lookups",
    hosts: ["api.github.com (through gh)"],
    description:
      "Asks gh which GitHub repository and fork parent a project has, and whether its branch has a pull request, at launch, on the Inbox's background check, when a project opens, when a window gains focus, and when a first message names an issue or pull request by number. The pull request bar also reads its pull request's checks and auto-merge state when it shows, every minute while auto-fix or auto-merge is on, and again 5, 15 and 45 seconds after a lookup fails, also after one you asked for while this is off. Off, none of these run on their own: the Inbox, the pull request bar and linked issues fill in when you open the Inbox, press Check now on the bar, or act on a pull request. Every gh MonoCode starts runs with gh's telemetry off.",
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
    "github-lookups": true,
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

/** When Link previews was last turned on from off, epoch ms. */
export const LINK_PREVIEWS_ON_SINCE_KEY = "monocode.linkPreviewsOnSince";

/** 0 when the switch was never turned off and on again. */
export function linkPreviewsOnSince(): number {
  try {
    const value = Number(localStorage.getItem(LINK_PREVIEWS_ON_SINCE_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Whether a user message may show a fetched link preview (5.9). Only a
 * message sent while previews were on: the flag stamped at send time, or for
 * a message saved before the flag existed, a send time after the switch was
 * last turned on. Turning the switch on never fetches for older messages.
 */
export function linkPreviewAllowedFor(
  message: { linkPreviews?: boolean; sentAt?: number; startedAt?: number },
  allowedNow: boolean = outboundCallAllowed("link-previews"),
  onSince: number = linkPreviewsOnSince(),
): boolean {
  if (!allowedNow) return false;
  if (typeof message.linkPreviews === "boolean") return message.linkPreviews;
  if (!onSince) return true;
  const at = message.sentAt ?? message.startedAt;
  return at != null && at >= onSince;
}

export function setOutboundCallAllowed(
  id: OutboundCallId,
  allowed: boolean,
): void {
  if (!isOutboundCallId(id) || typeof allowed !== "boolean") return;
  if (id === "link-previews" && allowed && !loadOutboundCalls()[id]) {
    try {
      localStorage.setItem(LINK_PREVIEWS_ON_SINCE_KEY, String(Date.now()));
    } catch {
      // Private mode or quota: stamped messages still decide on their own.
    }
  }
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
