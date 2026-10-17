import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import type { HarnessId } from "../../sessions/model/session";

/**
 * The app side of computer use. Grants live in the app's Rust process for
 * this run, never in browser storage: a reload keeps them, a quit ends them.
 * Every call here is a user's click; agents reach grants only through the
 * approval card.
 */

export type AppWarning = "terminal" | "finder" | "systemSettings";

export type GrantView = {
  chatId: string;
  bundleId: string;
  appName?: string;
  grantedAt: number;
  endedAt?: number;
  approvalId: string;
};

export type ChatComputerUse = {
  active: GrantView[];
  /** A runtime is running for this chat now. */
  running: boolean;
};

export type AppInfo = {
  bundleId: string;
  name?: string;
  /** Where the app lives, as the helper found it. Display only. */
  path?: string;
  warning?: AppWarning;
};

/** An agent asked for an app; the card waits for the user. */
export type AccessRequestView = {
  requestId: string;
  chatId: string;
  /** What the model named, cleaned to one line. */
  app: string;
  reason: string;
  /** The app MonoCode resolved it to; absent when it could not. */
  resolved?: AppInfo;
  /** Why the request cannot be granted, when it cannot. */
  refusal?: string;
  askedAt: number;
};

export type HelperState =
  /** Not macOS. */
  | "unsupported"
  /** The helper app is not installed beside MonoCode. */
  | "missing"
  /** Installed; it starts on the first grant. */
  | "stopped"
  | "running";

export type ComputerUseStatus = {
  helper: HelperState;
  /** Where MonoCode looks for the helper, for Settings. */
  helperPath?: string;
  runningChats: string[];
  pending: AccessRequestView[];
};

export type StopReport = {
  /** The runtime was running and is now ended. */
  stopped: boolean;
  /** Grants the stop ended. */
  ended: number;
  /** Mouse buttons the helper found held after the stop and released. */
  releasedButtons: string[];
  /** Set when the helper could not confirm the buttons. */
  warning?: string;
};

export const REQUEST_EVENT = "computer-use://request";
export const CHANGED_EVENT = "computer-use://changed";

const EMPTY_STATUS: ComputerUseStatus = {
  helper: "unsupported",
  runningChats: [],
  pending: [],
};

let status: ComputerUseStatus = EMPTY_STATUS;
let grantsByChat: Record<string, GrantView[]> = {};
let cliPath: string | undefined;
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders on any computer-use change in this window. */
export function useComputerUseVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

function inApp(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** The desktop executable, known once `loadComputerUse` has run. */
export function computerUseCliPath(): string | undefined {
  return cliPath;
}

export function computerUseStatus(): ComputerUseStatus {
  return status;
}

/** Active grants for a chat, as last read. Empty until read. */
export function chatGrants(chatId: string | undefined): GrantView[] {
  return chatId ? (grantsByChat[chatId] ?? []) : [];
}

export function chatRunning(chatId: string | undefined): boolean {
  return !!chatId && status.runningChats.includes(chatId);
}

export function pendingFor(chatId: string | undefined): AccessRequestView[] {
  return chatId
    ? status.pending.filter((request) => request.chatId === chatId)
    : [];
}

/** Reads the status, and the grants of the chats given. Never throws. */
export async function refreshComputerUse(chatIds: string[] = []): Promise<void> {
  if (!inApp()) return;
  try {
    status = sanitizeStatus(await invoke<unknown>("computer_use_status"));
  } catch {
    status = EMPTY_STATUS;
  }
  const ids = [...new Set([...chatIds, ...Object.keys(grantsByChat)])];
  const next: Record<string, GrantView[]> = {};
  for (const chatId of ids) {
    try {
      next[chatId] = sanitizeGrants(
        await invoke<unknown>("computer_use_grants", { chatId }),
      );
    } catch {
      next[chatId] = [];
    }
  }
  grantsByChat = next;
  bump();
}

/** Once per window: the executable path and the first status. */
export async function loadComputerUse(): Promise<void> {
  if (!inApp()) return;
  if (!cliPath) {
    try {
      const path = await invoke<string>("app_cli_path");
      if (typeof path === "string" && path) cliPath = path;
    } catch {
      cliPath = undefined;
    }
  }
  await refreshComputerUse();
}

/** The user's click on Allow: one app, this chat. */
export async function grantApp(
  chatId: string,
  harness: HarnessId,
  app: AppInfo,
): Promise<GrantView | { error: string }> {
  try {
    const grant = await invoke<unknown>("computer_use_grant", {
      chatId,
      harness,
      bundleId: app.bundleId,
      appName: app.name ?? null,
    });
    await refreshComputerUse([chatId]);
    const [clean] = sanitizeGrants([grant]);
    return clean ?? { error: "The grant came back malformed." };
  } catch (error) {
    return { error: String(error) };
  }
}

export async function revokeApp(chatId: string, bundleId: string): Promise<void> {
  try {
    await invoke("computer_use_revoke", { chatId, bundleId });
  } catch {
    // Already ended.
  }
  await refreshComputerUse([chatId]);
}

/** The answer to an agent's request card. */
export async function answerRequest(
  request: AccessRequestView,
  allow: boolean,
  harness: HarnessId,
): Promise<string | undefined> {
  try {
    await invoke("computer_use_answer", {
      requestId: request.requestId,
      allow,
      harness,
    });
    await refreshComputerUse([request.chatId]);
    return undefined;
  } catch (error) {
    await refreshComputerUse([request.chatId]);
    return String(error);
  }
}

/** Ends the chat's runtime and every grant it holds (C4). */
export async function stopComputerUse(chatId: string): Promise<StopReport> {
  try {
    const report = sanitizeStop(
      await invoke<unknown>("computer_use_stop", { chatId }),
    );
    await refreshComputerUse([chatId]);
    return report;
  } catch (error) {
    await refreshComputerUse([chatId]);
    return {
      stopped: false,
      ended: 0,
      releasedButtons: [],
      warning: String(error),
    };
  }
}

/** Looks an app up by bundle id or name through the helper. */
export async function resolveApp(query: string): Promise<AppInfo | null> {
  if (!inApp()) return null;
  try {
    return sanitizeApp(await invoke<unknown>("computer_use_resolve_app", { query }));
  } catch {
    return null;
  }
}

/** Keeps this window in step with the app: requests and changes. */
export function useComputerUseEvents(): void {
  useEffect(() => {
    if (!inApp()) return;
    let closed = false;
    const unlisten: UnlistenFn[] = [];
    void loadComputerUse();
    const hook = (name: string) =>
      listen(name, () => {
        void refreshComputerUse();
      })
        .then((stop) => {
          if (closed) stop();
          else unlisten.push(stop);
        })
        .catch(() => {});
    void hook(REQUEST_EVENT);
    void hook(CHANGED_EVENT);
    return () => {
      closed = true;
      for (const stop of unlisten) stop();
    };
  }, []);
}

// --- Shapes from the app are checked before use. ---

function str(value: unknown, max = 500): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const WARNINGS: readonly AppWarning[] = ["terminal", "finder", "systemSettings"];

export function sanitizeApp(raw: unknown): AppInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const bundleId = str(value.bundleId, 255);
  if (!bundleId) return null;
  const warning = WARNINGS.find((w) => w === value.warning);
  return {
    bundleId,
    ...(str(value.name, 200) ? { name: str(value.name, 200) } : {}),
    ...(str(value.path, 1024) ? { path: str(value.path, 1024) } : {}),
    ...(warning ? { warning } : {}),
  };
}

export function sanitizeGrants(raw: unknown): GrantView[] {
  if (!Array.isArray(raw)) return [];
  const out: GrantView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const chatId = str(value.chatId, 200);
    const bundleId = str(value.bundleId, 255);
    const grantedAt = num(value.grantedAt);
    const approvalId = str(value.approvalId, 200);
    if (!chatId || !bundleId || grantedAt === undefined || !approvalId) continue;
    const endedAt = num(value.endedAt);
    const appName = str(value.appName, 200);
    out.push({
      chatId,
      bundleId,
      grantedAt,
      approvalId,
      ...(appName ? { appName } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    });
  }
  return out;
}

const HELPER_STATES: readonly HelperState[] = [
  "unsupported",
  "missing",
  "stopped",
  "running",
];

export function sanitizeStatus(raw: unknown): ComputerUseStatus {
  if (!raw || typeof raw !== "object") return EMPTY_STATUS;
  const value = raw as Record<string, unknown>;
  const helper = HELPER_STATES.find((s) => s === value.helper) ?? "unsupported";
  const runningChats = Array.isArray(value.runningChats)
    ? value.runningChats.filter(
        (id): id is string => typeof id === "string" && id.length <= 200,
      )
    : [];
  const pending: AccessRequestView[] = [];
  for (const item of Array.isArray(value.pending) ? value.pending : []) {
    if (!item || typeof item !== "object") continue;
    const request = item as Record<string, unknown>;
    const requestId = str(request.requestId, 200);
    const chatId = str(request.chatId, 200);
    const app = str(request.app, 255);
    const askedAt = num(request.askedAt);
    if (!requestId || !chatId || app === undefined || askedAt === undefined) {
      continue;
    }
    const resolved = sanitizeApp(request.resolved);
    const refusal = str(request.refusal, 500);
    pending.push({
      requestId,
      chatId,
      app,
      reason: str(request.reason, 400) ?? "",
      askedAt,
      ...(resolved ? { resolved } : {}),
      ...(refusal ? { refusal } : {}),
    });
  }
  const helperPath = str(value.helperPath, 2048);
  return {
    helper,
    runningChats,
    pending,
    ...(helperPath ? { helperPath } : {}),
  };
}

export function sanitizeStop(raw: unknown): StopReport {
  if (!raw || typeof raw !== "object") {
    return { stopped: false, ended: 0, releasedButtons: [] };
  }
  const value = raw as Record<string, unknown>;
  const warning = str(value.warning, 500);
  return {
    stopped: value.stopped === true,
    ended: num(value.ended) ?? 0,
    releasedButtons: Array.isArray(value.releasedButtons)
      ? value.releasedButtons.filter(
          (b): b is string => typeof b === "string" && b.length <= 20,
        )
      : [],
    ...(warning ? { warning } : {}),
  };
}

/** For tests: forget everything read. */
export function resetComputerUseClient(): void {
  status = EMPTY_STATUS;
  grantsByChat = {};
  cliPath = undefined;
  version = 0;
}

/** For tests: set what the app would have answered. */
export function setComputerUseStateForTest(next: {
  status?: ComputerUseStatus;
  grants?: Record<string, GrantView[]>;
  cliPath?: string;
}): void {
  if (next.status) status = next.status;
  if (next.grants) grantsByChat = next.grants;
  if (next.cliPath !== undefined) cliPath = next.cliPath;
  bump();
}
