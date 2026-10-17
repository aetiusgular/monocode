import { useSyncExternalStore } from "react";

/**
 * Computer use, switched on per chat. The switch only offers the tool to the
 * chat's harness: every app still needs its own approval card, and the
 * approvals themselves live in the app for this run (see `client.ts`).
 *
 * Kept in browser storage under one key, as `{ [chatId]: ChatSwitch }`, so a
 * reload or a quit keeps it. A value an agent wrote there grants nothing.
 */
export type ChatSwitch = {
  on: boolean;
  /**
   * Offer computer use although the model is not known to read images. The
   * accessibility tree still works for most native apps; canvas and video do
   * not (note W, section 3.7).
   */
  withoutVision?: boolean;
};

export const COMPUTER_USE_KEY = "monocode.computerUse.chats.v1";
const CHANGE_EVENT = "monocode:computer-use-switch";
/** Chats kept; the rest are dropped oldest first. */
const MAX_CHATS = 500;

let cache: Record<string, ChatSwitch> | null = null;
let version = 0;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Only well-formed entries survive a read. */
export function sanitizeSwitches(raw: unknown): Record<string, ChatSwitch> {
  const out: Record<string, ChatSwitch> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [chatId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!chatId || chatId.length > 200) continue;
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (entry.on !== true) continue;
    out[chatId] = {
      on: true,
      ...(entry.withoutVision === true ? { withoutVision: true } : {}),
    };
  }
  return out;
}

export function loadSwitches(): Record<string, ChatSwitch> {
  if (cache) return cache;
  const store = storage();
  let parsed: unknown = null;
  try {
    const text = store?.getItem(COMPUTER_USE_KEY);
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  cache = sanitizeSwitches(parsed);
  return cache;
}

export function chatSwitch(chatId: string | undefined): ChatSwitch {
  if (!chatId) return { on: false };
  return loadSwitches()[chatId] ?? { on: false };
}

export function setChatSwitch(chatId: string, next: ChatSwitch): void {
  if (!chatId) return;
  const all = { ...loadSwitches() };
  delete all[chatId];
  if (next.on) {
    all[chatId] = {
      on: true,
      ...(next.withoutVision ? { withoutVision: true } : {}),
    };
  }
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CHATS))) {
    delete all[id];
  }
  cache = all;
  version += 1;
  try {
    storage()?.setItem(COMPUTER_USE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the switch holds for this window only.
  }
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // No window (tests).
  }
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const bump = () => {
    version += 1;
    onChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== COMPUTER_USE_KEY && event.key !== null) return;
    cache = null;
    bump();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Re-renders when any chat's switch changes, in this window or another. */
export function useChatSwitchVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

/** For tests: forget the cached copy. */
export function resetChatSwitchCache(): void {
  cache = null;
}
