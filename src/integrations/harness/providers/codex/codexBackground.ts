import {
  sanitizeBackgroundItems,
  MAX_BACKGROUND_ITEMS,
  type BackgroundItem,
} from "../../core/background";
import { asRecord, stringField } from "./codexProtocol";
import { codexLiveThread_l1 } from "./codex";

/** The one call these helpers make on a Codex app-server connection. */
export type CodexRequester = {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
};

const LIST_TIMEOUT_MS = 10_000;
const TERMINATE_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 50;
const MAX_PAGES = 4;

/**
 * Codex's background terminal methods are experimental (rust-v0.161.0). A
 * home or version without them answers "method not found" or refuses the
 * experimental call; either means "no list here", not a failure to show.
 */
export function isMissingMethodError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error ?? "")
  ).toLowerCase();
  return (
    message.includes("method not found") ||
    message.includes("unknown method") ||
    message.includes("unknown variant") ||
    message.includes("experimental") ||
    message.includes("-32601")
  );
}

/** One `ThreadBackgroundTerminal` as a Running row. */
export function codexTerminalItem(value: unknown): BackgroundItem | null {
  const row = asRecord(value);
  const processId = stringField(row, "processId");
  if (!processId) return null;
  const command = stringField(row, "command")?.trim();
  const [item] = sanitizeBackgroundItems([
    {
      id: processId,
      kind: "shell",
      title: command || `Process ${processId}`,
      status: "running",
      stoppable: true,
      source: "harness",
    },
  ]);
  return item ?? null;
}

/**
 * Lists the thread's background terminals, a few pages at most. Null when
 * this Codex has no such method.
 */
export async function listCodexBackgroundTerminals(
  rpc: CodexRequester,
  threadId: string,
): Promise<BackgroundItem[] | null> {
  const items: BackgroundItem[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response: unknown = await rpc.request(
        "thread/backgroundTerminals/list",
        { threadId, cursor, limit: PAGE_LIMIT },
        LIST_TIMEOUT_MS,
      );
      const record = asRecord(response);
      const data = Array.isArray(record?.data) ? record.data : [];
      for (const row of data) {
        const item = codexTerminalItem(row);
        if (item && !items.some((entry) => entry.id === item.id)) {
          items.push(item);
        }
      }
      cursor = stringField(record, "nextCursor") ?? null;
      if (!cursor || items.length >= MAX_BACKGROUND_ITEMS) break;
    }
  } catch (error) {
    if (isMissingMethodError(error)) return null;
    throw error;
  }
  return items.slice(0, MAX_BACKGROUND_ITEMS);
}

/** Ends one background terminal. False when Codex says it was not running. */
export async function terminateCodexBackgroundTerminal(
  rpc: CodexRequester,
  threadId: string,
  processId: string,
): Promise<boolean> {
  try {
    const response: unknown = await rpc.request(
      "thread/backgroundTerminals/terminate",
      { threadId, processId },
      TERMINATE_TIMEOUT_MS,
    );
    return asRecord(response)?.terminated === true;
  } catch (error) {
    if (isMissingMethodError(error)) return false;
    throw error;
  }
}

/** The adapter's `listBackgroundTasks`: the live thread's terminals. */
export async function listCodexBackgroundTasks(
  sessionId: string,
): Promise<BackgroundItem[] | null> {
  const live = codexLiveThread_l1(sessionId);
  if (!live) return null;
  return listCodexBackgroundTerminals(live.rpc, live.threadId);
}

/** The adapter's `stopBackgroundTask`: terminate by Codex's process id. */
export async function stopCodexBackgroundTask(
  sessionId: string,
  processId: string,
): Promise<boolean> {
  const live = codexLiveThread_l1(sessionId);
  if (!live) return false;
  return terminateCodexBackgroundTerminal(live.rpc, live.threadId, processId);
}
