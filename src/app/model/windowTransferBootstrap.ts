import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getSession } from "../../features/sessions/data/sessionStore";
import {
  newDefaultSession,
  type Session,
} from "../../features/sessions/model/session";
import { leafIds, newTab } from "../../features/workspace/model/layout";
import {
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "../../features/workspace/model/workspaceSnapshot";
import { lastProjectPath } from "../../features/projects/model/recents";
import type { WindowTransferPayload } from "./windowTransfer";

/**
 * Labels of windows opened by Move to New Window, as `window_transfer.rs`
 * gives them. The label stays through a reload, so a moved window never boots
 * the main workspace.
 */
export const MOVED_WINDOW_PREFIX = "moved-";

/** What Rust holds for a moved window (`HeldTabs` in window_transfer.rs). */
export type HeldWindowTabs =
  | { kind: "transfer"; json: string }
  | { kind: "tabs"; json: string };

let transferPromise: Promise<WindowTransferPayload | null> | null = null;

/**
 * What this window boots from, read once per webview (safe under React
 * StrictMode double-mount). Null for the main window and any other window,
 * which boot the main workspace. A moved window gets the tabs it was given,
 * after a reload the tabs it last held, and with nothing held (an app
 * restart, say) one blank chat: never the main workspace.
 */
export function loadWindowTransfer(): Promise<WindowTransferPayload | null> {
  if (!transferPromise) transferPromise = loadOnce();
  return transferPromise;
}

async function loadOnce(): Promise<WindowTransferPayload | null> {
  if (!isMovedWindow()) return null;
  const held = await invoke<HeldWindowTabs | null>("load_window_tabs").catch(
    () => null,
  );
  return (await windowFromHeld(held).catch(() => null)) ?? blankWindow();
}

function isMovedWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label.startsWith(MOVED_WINDOW_PREFIX);
  } catch {
    return false;
  }
}

/** Keep this moved window's tabs in memory, for its next reload. */
export async function holdWindowTabs(
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  await invoke("hold_window_tabs", { tabs: JSON.stringify(snapshot) });
}

async function windowFromHeld(
  held: HeldWindowTabs | null | undefined,
): Promise<WindowTransferPayload | null> {
  if (!held || typeof held.json !== "string") return null;
  const raw: unknown = JSON.parse(held.json);
  if (held.kind === "transfer") return parseTransfer(raw);
  if (held.kind === "tabs") return hydrateHeldTabs(raw);
  return null;
}

function parseTransfer(raw: unknown): WindowTransferPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Partial<WindowTransferPayload>;
  if (
    !Array.isArray(payload.tabs) ||
    payload.tabs.length === 0 ||
    !Array.isArray(payload.sessions) ||
    typeof payload.activeTabId !== "string" ||
    typeof payload.projectCwd !== "string"
  ) {
    return null;
  }
  return {
    ...(payload as WindowTransferPayload),
    dirtyFileIds: Array.isArray(payload.dirtyFileIds)
      ? payload.dirtyFileIds
      : [],
  };
}

/**
 * The tabs a moved window held, with their chats read back from the session
 * store, the way the main window reopens its saved workspace. Only this
 * window's own chats are read. A turn cut off by the reload was marked
 * interrupted when the page unloaded (`persistQuitState`).
 */
async function hydrateHeldTabs(
  raw: unknown,
): Promise<WindowTransferPayload | null> {
  const snapshot = parseWorkspaceSnapshot(raw);
  if (!snapshot) return null;
  const ids = new Set<string>();
  for (const stub of snapshot.sessions) ids.add(stub.id);
  for (const tab of snapshot.tabs) {
    for (const id of leafIds(tab.layout)) ids.add(id);
  }
  const loaded = new Map<string, Session>();
  await Promise.all(
    [...ids].map(async (id) => {
      const record = await getSession(id).catch(() => null);
      if (record) loaded.set(id, record);
    }),
  );
  const workspace = hydrateWorkspaceSnapshot(snapshot, loaded);
  if (!workspace) return null;
  return {
    tabs: workspace.tabs,
    sessions: workspace.sessions,
    activeTabId: workspace.activeTabId,
    projectCwd: workspace.projectCwd,
    dirtyFileIds: [],
    ...(workspace.projectTerminals?.length
      ? { projectTerminals: workspace.projectTerminals }
      : {}),
  };
}

/** A moved window with nothing held opens empty rather than as the main one. */
function blankWindow(): WindowTransferPayload {
  const projectCwd = lastProjectPath() ?? "~";
  const session = newDefaultSession(projectCwd);
  const tab = newTab(session.id);
  return {
    tabs: [tab],
    sessions: [session],
    activeTabId: tab.id,
    projectCwd,
    dirtyFileIds: [],
  };
}
