import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  attachHarnessSession,
  bindHarnessSession,
  canAttachHarnessSession,
  forgetHarnessSession,
  harnessReloadTurn,
  isLiveHarness,
  stopHarnessSession,
} from "../../integrations/harness/core/registry";
import {
  killAllChildren,
  killChild,
  saveChildrenForReload,
} from "../../integrations/harness/core/child";
import type { HarnessEvent } from "../../integrations/harness/core/types";
import { stopStreaming } from "../../integrations/harness/core/apply";
import { sessionToolsInput } from "../../features/session-tools/model/harnessInput";
import {
  hasInFlightSessions,
  inFlightRefs,
  isInFlightSession,
  markTurnInterrupted,
  quitWhileBusyMessage,
  wasTurnInterrupted,
  workspaceFromResumed,
  type ResumedWorkspace,
} from "../../features/sessions/model/inFlight";
import { leafIds, type WorkspaceTab } from "../../features/workspace/model/layout";
import { killPty } from "../../platform/tauri/pty";
import {
  projectTerminalFileIds,
  type DockSide,
  type ProjectTerminalDock,
} from "../../features/projects/model/projectTerminal";
import {
  sessionNeedsInput,
  sessionWorkCwd,
  type Block,
  type Session,
} from "../../features/sessions/model/session";
import { sessionChildHarnesses } from "../../features/sessions/model/handoff";
import {
  getSession,
  listInFlightSessions,
  listSessionsByProject,
  loadWorkspaceSnapshot,
  replaceInFlightSessions,
  saveWorkspaceSnapshot,
  shouldPersistSession,
  upsertSession,
  type SessionSummary,
} from "../../features/sessions/data/sessionStore";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "../../features/workspace/model/workspaceSnapshot";
import { holdWindowTabs, loadWindowTransfer } from "./windowTransferBootstrap";
import type { WindowTransferPayload } from "./windowTransfer";
import { lastProjectPath, normalizeProjectPath, sameProjectPath } from "../../features/projects/model/recents";
import type { ProjectReturnMemory } from "../../features/projects/model/projectReturn";

export type { ResumedWorkspace };
export { hasInFlightSessions };

export type BootWorkspace = {
  windowTransfer: WindowTransferPayload | null;
  resumed: ResumedWorkspace | null;
  /** Sidebar rows listed before first paint, so the rail is not empty. */
  history: SessionSummary[];
  historyCwd: string | null;
};

let resumedPromise: Promise<ResumedWorkspace | null> | null = null;
let bootPromise: Promise<BootWorkspace> | null = null;
let quitting = false;
let quitDialogOpen = false;
let bootingResumed: ResumedWorkspace | null = null;
/**
 * Set at boot for a window opened by Move to New Window. Its tabs never go
 * into the main workspace snapshot, which a launch and the main window's
 * reload open (#43).
 */
let movedWindow = false;
let liveWorkspace: {
  sessions: () => Session[];
  tabs: () => WorkspaceTab[];
  activeTabId: () => string;
  projectCwd: () => string;
  projectTerminals: () => ProjectTerminalDock[];
  projectReturnMemory: () => ProjectReturnMemory;
  lastDockSide: () => DockSide | null;
  keepTab?: (tab: WorkspaceTab) => boolean;
  flush: () => void;
} | null = null;

export function isAppQuitting(): boolean {
  return quitting;
}

export function setQuitWorkspace(
  sessions: () => Session[],
  tabs: () => WorkspaceTab[],
  activeTabId: () => string,
  projectCwd: () => string,
  projectTerminals: () => ProjectTerminalDock[],
  projectReturnMemory: () => ProjectReturnMemory,
  flush: () => void,
  lastDockSide: () => DockSide | null = () => null,
  keepTab?: (tab: WorkspaceTab) => boolean,
): () => void {
  liveWorkspace = {
    sessions,
    tabs,
    activeTabId,
    projectCwd,
    projectTerminals,
    projectReturnMemory,
    lastDockSide,
    keepTab,
    flush,
  };
  bootingResumed = null;
  return () => {
    if (liveWorkspace?.sessions === sessions) liveWorkspace = null;
  };
}

/**
 * Persist this window for a quit the coordinator has already confirmed.
 * Exiting is `confirm_quit`'s job, once every window has reported ready.
 */
export async function handleQuitRequested(): Promise<boolean> {
  if (liveWorkspace) {
    liveWorkspace.flush();
    quitting = true;
    try {
      await persistQuitState(
        liveWorkspace.sessions(),
        liveWorkspace.tabs(),
        liveWorkspace.activeTabId(),
        liveWorkspace.projectCwd(),
        liveWorkspace.projectReturnMemory(),
        "quit",
        liveWorkspace.projectTerminals(),
        liveWorkspace.lastDockSide() ?? undefined,
        liveWorkspace.keepTab,
      );
      return true;
    } catch {
      quitting = false;
      return false;
    }
  }
  const { resumed } = await loadBootWorkspace();
  const pending = resumed ?? bootingResumed;
  quitting = true;
  if (!pending) return true;
  try {
    await persistBootingResume(pending);
    return true;
  } catch {
    quitting = false;
    return false;
  }
}

/** Each window counts its own live turns; Rust sums them into one decision. */
export async function reportQuitPoll(id: number): Promise<void> {
  let inFlight = 0;
  if (liveWorkspace) {
    liveWorkspace.flush();
    // Every running turn, not just the resumable ones `inFlightRefs` keeps:
    // an Inbox Ask still counts as work nobody agreed to throw away.
    inFlight = liveWorkspace.sessions().filter(isInFlightSession).length;
  }
  await invoke("quit_poll_reply", { id, inFlight }).catch(() => undefined);
}

/** The one quit dialog, shown by whichever window the coordinator picked. */
export async function askQuitConfirmation(
  id: number,
  inFlight: number,
): Promise<void> {
  let confirmed = false;
  if (!quitDialogOpen) {
    quitDialogOpen = true;
    try {
      confirmed = await ask(quitWhileBusyMessage(inFlight), {
        title: "MonoCode",
        kind: "warning",
        okLabel: "Quit",
      });
    } catch {
      confirmed = false;
    } finally {
      quitDialogOpen = false;
    }
  }
  await invoke("quit_decision", { id, confirmed }).catch(() => undefined);
}

export async function commitQuit(id: number): Promise<void> {
  const persisted = await handleQuitRequested();
  await invoke("quit_ready", { id, persisted }).catch(() => undefined);
}

/**
 * A quit that stopped part-way because another window could not save. This
 * window is staying open, so it must go back to persisting on unload.
 */
export function abortQuit(): void {
  quitting = false;
}

/** Confirm and stop this window's work without terminating other windows. */
export async function closeBusyWindow(): Promise<void> {
  if (!liveWorkspace) return;
  liveWorkspace.flush();
  await confirmAndCloseWindow(
    liveWorkspace.sessions(),
    liveWorkspace.tabs(),
    liveWorkspace.activeTabId(),
    liveWorkspace.projectCwd(),
    liveWorkspace.projectReturnMemory(),
    liveWorkspace.projectTerminals(),
    liveWorkspace.lastDockSide() ?? undefined,
  );
}

export function loadResumedWorkspace(): Promise<ResumedWorkspace | null> {
  if (!resumedPromise) resumedPromise = loadResumedWorkspaceOnce();
  return resumedPromise;
}

/** Transfer and restore run once; callers share the same promise. */
export function loadBootWorkspace(): Promise<BootWorkspace> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const hintedCwd = lastProjectPath();
      const historyHint = listProjectHistory(hintedCwd);
      const windowTransfer = await loadWindowTransfer();
      if (windowTransfer) {
        movedWindow = true;
        const listed = await historyForCwd(
          windowTransfer.projectCwd,
          hintedCwd,
          historyHint,
        );
        return {
          windowTransfer,
          resumed: null,
          history: listed?.rows ?? [],
          historyCwd: listed?.cwd ?? null,
        };
      }
      const [resumed, hinted] = await Promise.all([
        loadResumedWorkspace(),
        historyHint,
      ]);
      const listed = await historyForCwd(
        resumed?.projectCwd ?? hintedCwd,
        hintedCwd,
        Promise.resolve(hinted),
      );
      return {
        windowTransfer: null,
        resumed,
        history: listed?.rows ?? [],
        historyCwd: listed?.cwd ?? null,
      };
    })();
  }
  return bootPromise;
}

async function listProjectHistory(
  cwd: string | null | undefined,
): Promise<{ cwd: string; rows: SessionSummary[] } | null> {
  if (!cwd || cwd === "~") return null;
  try {
    const rows = await listSessionsByProject(cwd);
    return { cwd: normalizeProjectPath(cwd), rows };
  } catch {
    return null;
  }
}

async function historyForCwd(
  cwd: string | null | undefined,
  hintedCwd: string | null | undefined,
  hinted: Promise<{ cwd: string; rows: SessionSummary[] } | null>,
): Promise<{ cwd: string; rows: SessionSummary[] } | null> {
  if (!cwd || cwd === "~") return null;
  if (hintedCwd && sameProjectPath(cwd, hintedCwd)) return hinted;
  return listProjectHistory(cwd);
}

async function loadResumedWorkspaceOnce(): Promise<ResumedWorkspace | null> {
  const [snapshotRaw, refs] = await Promise.all([
    loadWorkspaceSnapshot().catch(() => null),
    listInFlightSessions().catch(() => []),
  ]);
  const interrupted = new Set(refs.map((ref) => ref.sessionId));
  const snapshot = parseWorkspaceSnapshot(snapshotRaw);

  const ids = new Set<string>();
  if (snapshot) {
    for (const stub of snapshot.sessions) ids.add(stub.id);
    for (const tab of snapshot.tabs) {
      for (const id of leafIds(tab.layout)) ids.add(id);
    }
  }
  for (const ref of refs) ids.add(ref.sessionId);

  const loaded = new Map<string, Session>();
  await Promise.all(
    [...ids].map(async (id) => {
      const record = await getSession(id).catch(() => null);
      if (record) loaded.set(id, record);
    }),
  );

  let workspace = snapshot
    ? hydrateWorkspaceSnapshot(snapshot, loaded, interrupted)
    : null;
  if (!workspace && refs.length > 0) {
    const sessions: Session[] = [];
    for (const ref of refs) {
      const record = loaded.get(ref.sessionId);
      if (!record) continue;
      sessions.push(markTurnInterrupted(record));
    }
    workspace = workspaceFromResumed(sessions);
  }

  bootingResumed = workspace;
  if (workspace) {
    await Promise.all(
      workspace.sessions
        // Idle transcripts already came from disk. Rewriting every open chat
        // here serialized/indexed the entire workspace before first paint.
        .filter(
          (session) => interrupted.has(session.id) && shouldPersistSession(session),
        )
        .map((session) => upsertSession(session).catch(() => null)),
    );
  }
  return workspace;
}

export function bindResumedSessions(sessions: Session[]): void {
  for (const session of sessions) {
    if (
      session.worktreeRemoved ||
      !session.providerSessionId ||
      !isLiveHarness(session.harness)
    )
      continue;
    bindHarnessSession(
      session.harness,
      session.id,
      session.providerSessionId,
      sessionWorkCwd(session),
      session.providerAccountId,
      session.blocks,
    );
  }
}

export async function hideCurrentWindow(): Promise<void> {
  await invoke("hide_window");
}

export async function closeCurrentWindow(): Promise<void> {
  await invoke("destroy_window");
}

export async function confirmReload(
  hasUnsavedFiles: boolean,
): Promise<boolean> {
  if (!hasUnsavedFiles) return true;
  return ask("Reload MonoCode and discard unsaved changes?", {
    title: "MonoCode",
    kind: "warning",
    okLabel: "Reload",
  });
}

export async function persistLiveTranscripts(
  sessions: Session[],
): Promise<void> {
  await Promise.all(
    sessions
      .filter(shouldPersistSession)
      .map((session) => upsertSession(session).catch(() => null)),
  );
}

export async function persistQuitState(
  sessions: Session[],
  tabs: WorkspaceTab[],
  activeTabId: string,
  projectCwd: string,
  memory: ProjectReturnMemory,
  mode: "quit" | "unload" = "quit",
  projectTerminals: ProjectTerminalDock[] = [],
  lastDockSide?: DockSide,
  keepTab?: (tab: WorkspaceTab) => boolean,
): Promise<void> {
  const refs = inFlightRefs(sessions, tabs);
  const interrupted = new Set(refs.map((ref) => ref.sessionId));
  // A reload leaves the provider processes running in Rust: the turns that
  // can be taken back are handed to the next page before any await, so the
  // note is written before the page goes (Mac test 2.8). The transcript is
  // still saved interrupted below, for when taking it back fails.
  if (mode === "unload" && !movedWindow) {
    handOverForReload(
      sessions.filter((session) => interrupted.has(session.id)),
    );
  }
  // A quit ends the process, so a swallowed write is work that never comes
  // back: let it reject and let the caller call the quit off. An unload is a
  // reload, where best effort is enough and failing loudly helps nobody.
  const write = <T,>(pending: Promise<T>): Promise<T | null> =>
    mode === "quit" ? pending : pending.catch(() => null);
  const snapshot = () =>
    collectWorkspaceSnapshot(
      tabs,
      sessions,
      activeTabId,
      projectCwd,
      memory,
      projectTerminals,
      lastDockSide,
      // A moved window keeps every tab it holds.
      movedWindow ? undefined : keepTab,
    );
  // A moved window's tabs stay out of the main workspace snapshot. A reload
  // or close keeps them in its own slot, sent first so the reload finds them;
  // a quit drops them, so they are not reopened.
  const held =
    movedWindow && mode === "unload" ? write(holdWindowTabs(snapshot())) : null;

  await Promise.all(
    sessions.map(async (session) => {
      if (!shouldPersistSession(session)) return;
      const payload = interrupted.has(session.id)
        ? markTurnInterrupted(session)
        : session;
      await write(upsertSession(payload));
    }),
  );
  if (!movedWindow) await write(saveWorkspaceSnapshot(snapshot()));
  await held;
  // Vite/webview reload must not wipe a restored snapshot: those chats are idle
  // in this process until Continue runs. A moved window leaves the list to the
  // main window, whose boot reopens every chat on it as a tab.
  if (!movedWindow && (mode === "quit" || refs.length > 0)) {
    await write(replaceInFlightSessions(refs));
  }
}

async function persistBootingResume(workspace: ResumedWorkspace): Promise<void> {
  await Promise.all(
    workspace.sessions
      .filter(shouldPersistSession)
      .map((session) => upsertSession(session).catch(() => null)),
  );
  await saveWorkspaceSnapshot(
    collectWorkspaceSnapshot(
      workspace.tabs,
      workspace.sessions,
      workspace.activeTabId,
      workspace.projectCwd,
      workspace.projectReturnMemory ?? new Map(),
      workspace.projectTerminals ?? [],
      workspace.lastDockSide,
    ),
  ).catch(() => undefined);
  await replaceInFlightSessions(
    workspace.sessions
      .filter(wasTurnInterrupted)
      .map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
      })),
  ).catch(() => undefined);
}

async function confirmAndCloseWindow(
  sessions: Session[],
  tabs: WorkspaceTab[],
  activeTabId: string,
  projectCwd: string,
  memory: ProjectReturnMemory,
  projectTerminals: ProjectTerminalDock[] = [],
  lastDockSide?: DockSide,
): Promise<void> {
  if (quitDialogOpen) return;
  quitDialogOpen = true;
  try {
    const refs = inFlightRefs(sessions, tabs);
    if (refs.length > 0) {
      const ok = await ask(
        "Close this window and stop its running chats? Other windows will stay open.",
        { title: "MonoCode", kind: "warning", okLabel: "Close window" },
      );
      if (!ok) return;
    }
    quitting = true;
    try {
      await persistQuitState(
        sessions,
        tabs,
        activeTabId,
        projectCwd,
        memory,
        "quit",
        projectTerminals,
        lastDockSide,
      );
      await reapWindowRuntime(sessions, tabs, projectTerminals, false);
      await closeCurrentWindow();
    } catch {
      quitting = false;
    }
  } finally {
    quitDialogOpen = false;
  }
}

export async function reapWindowRuntime(
  sessions: Session[],
  tabs: WorkspaceTab[],
  projectTerminals: ProjectTerminalDock[] = [],
  includeAllChildren = true,
): Promise<void> {
  // Chats handed to the page that loads next keep their processes.
  const kept = includeAllChildren ? [...handedOver] : [];
  await Promise.all(
    sessions
      .filter((session) => !kept.includes(session.id))
      .map((session) =>
        Promise.all(
          sessionChildHarnesses(session).map((harness) =>
            forgetHarnessSession(harness, session.id),
          ),
        ),
      ),
  );
  await Promise.all(
    [...terminalFileIds(tabs), ...projectTerminalFileIds(projectTerminals)].map(
      (id) => killPty(id),
    ),
  );
  // Catalog probes, title generators, and usage scrapers are not session
  // children. Drop them so an unused Pi/Codex probe cannot outlive the window.
  if (includeAllChildren) await killAllChildren(kept).catch(() => undefined);
}

/**
 * What a reloading page hands the next one for each in-flight chat whose
 * provider process keeps running: the turn's prompt boundary and the calls
 * still open, which the saved transcript marks cancelled. `sessionStorage`
 * survives a reload in the same webview, not a quit.
 */
const RELOAD_TURNS_KEY = "monocode.reloadTurns";

type ReloadTurn = {
  sessionId: string;
  /**
   * What the turn was sent as. A plan turn must stay read-only after the
   * reload; a row without a readable intent is not taken back (X7).
   */
  intent: "plan" | "default";
  /** The user message ids the old page wrote for this turn (X8). */
  userMessageUuids: string[];
  providerTurnId?: string;
  openTools: {
    blockId: string;
    callId: string;
    kind?: string;
    title?: string;
    command?: string;
    status?: string;
  }[];
};

/** Chats this page handed over on unload; their children stay alive. */
const handedOver = new Set<string>();

function isOpenTool(block: Block): boolean {
  if (block.role !== "tool" || !block.tool?.callId) return false;
  if (block.streaming) return true;
  const status = block.tool.status?.toLowerCase() ?? "";
  return (
    status === "in_progress" || status === "pending" || status === "running"
  );
}

function reloadTurn(session: Session): ReloadTurn | null {
  if (
    !session.busy ||
    !session.providerSessionId ||
    session.worktreeRemoved ||
    // An open approval or question was asked before the reload; the next
    // page never sees it again, and the turn would hang on it.
    sessionNeedsInput(session) ||
    !canAttachHarnessSession(session.harness)
  )
    return null;
  let userIndex = -1;
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    if (session.blocks[i].role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return null;
  // The registry knows what the running turn was sent as; without that it
  // is not handed over (X7).
  const sent = harnessReloadTurn(session.id);
  if (!sent) return null;
  return {
    sessionId: session.id,
    intent: sent.intent,
    userMessageUuids: sent.userMessageUuids,
    ...(session.blocks[userIndex].providerTurnId
      ? { providerTurnId: session.blocks[userIndex].providerTurnId }
      : {}),
    openTools: session.blocks.slice(userIndex + 1).flatMap((block) =>
      isOpenTool(block)
        ? [
            {
              blockId: block.id,
              callId: block.tool!.callId!,
              kind: block.tool!.kind,
              title: block.tool!.title,
              command: block.tool!.command,
              status: block.tool!.status,
            },
          ]
        : [],
    ),
  };
}

/** Never throws: the unload's own saves must still run. */
function handOverForReload(sessions: Session[]): void {
  handedOver.clear();
  try {
    const turns = sessions.flatMap((session) => reloadTurn(session) ?? []);
    saveChildrenForReload(turns.map((turn) => turn.sessionId));
    if (turns.length)
      sessionStorage.setItem(RELOAD_TURNS_KEY, JSON.stringify(turns));
    else sessionStorage.removeItem(RELOAD_TURNS_KEY);
    // Only once both notes are down are the processes spared.
    for (const turn of turns) handedOver.add(turn.sessionId);
  } catch {
    // No storage: the next page falls back to Continue.
  }
}

let reloadTurnsTaken: ReloadTurn[] | null = null;

/** Once per page load: a StrictMode remount finds nothing left to take. */
function takeReloadTurns(): ReloadTurn[] {
  if (reloadTurnsTaken) return [];
  reloadTurnsTaken = [];
  try {
    const raw = sessionStorage.getItem(RELOAD_TURNS_KEY);
    sessionStorage.removeItem(RELOAD_TURNS_KEY);
    const rows: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(rows)) {
      reloadTurnsTaken = rows.filter(
        (row): row is ReloadTurn =>
          !!row &&
          typeof row.sessionId === "string" &&
          Array.isArray(row.openTools),
      );
    }
  } catch {
    // Nothing to take back.
  }
  return reloadTurnsTaken;
}

/** The row's intent and prompt ids as written, or null when unreadable. */
function reloadTurnIntent(
  turn: ReloadTurn,
): Pick<ReloadTurn, "intent" | "userMessageUuids"> | null {
  const { intent, userMessageUuids } = turn as {
    intent?: unknown;
    userMessageUuids?: unknown;
  };
  if (intent !== "plan" && intent !== "default") return null;
  // At least one id: with none, the turn's own result would be ignored as
  // late and the re-attached turn would never end (review Y2).
  if (
    !Array.isArray(userMessageUuids) ||
    userMessageUuids.length === 0 ||
    !userMessageUuids.every((uuid) => typeof uuid === "string" && uuid)
  )
    return null;
  return { intent, userMessageUuids };
}

/**
 * Undo what the unload saved for a turn that is being taken back: drop the
 * interrupt note, reopen the calls it cancelled, and mark the chat busy
 * again, so Continue does not start a second turn meanwhile.
 */
export function reopenReloadedTurn(
  session: Session,
  turn: ReloadTurn,
): Session {
  const open = new Map(turn.openTools.map((tool) => [tool.blockId, tool]));
  const blocks = (
    wasTurnInterrupted(session) ? session.blocks.slice(0, -1) : session.blocks
  ).map((block) => {
    const saved = open.get(block.id);
    if (!saved || !block.tool || block.tool.callId !== saved.callId)
      return block;
    return {
      ...block,
      streaming: true,
      tool: { ...block.tool, status: saved.status },
    };
  });
  return { ...session, blocks, busy: true };
}

/** How the app's session state reaches a re-attached turn. */
export type ReattachSink = {
  /** Queue a harness event for the chat, like a live turn's. */
  onEvent: (sessionId: string, event: HarnessEvent) => void;
  /** Deliver every queued event now. */
  flush: () => void;
  /** Replace one chat's session state. */
  update: (sessionId: string, change: (session: Session) => Session) => void;
};

/**
 * After a reload: takes back every in-flight turn the old page handed over
 * whose provider process still runs with the same pid. Each such chat is
 * reopened busy at once; when its turn ends it is settled like any turn, and
 * when it cannot be taken back it is marked interrupted for Continue, as
 * without this. Call it with the harness bridge held.
 */
export async function attachResumedSessions(
  sessions: Session[],
  sink: ReattachSink,
): Promise<void> {
  const turns = takeReloadTurns();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  await Promise.all(
    turns.map(async (turn) => {
      const session = byId.get(turn.sessionId);
      // Without its intent the turn might be a plan turn that would act
      // once taken back: it stays interrupted, for Continue (X7).
      const sent = reloadTurnIntent(turn);
      if (!session?.providerSessionId || !wasTurnInterrupted(session) || !sent) {
        // The old page spared this process; nothing here takes it back.
        await killChild(turn.sessionId).catch(() => undefined);
        return;
      }
      sink.update(session.id, (current) => reopenReloadedTurn(current, turn));
      const workCwd = sessionWorkCwd(session);
      let outcome: { attached: boolean } = { attached: false };
      try {
        outcome = await attachHarnessSession({
          harness: session.harness,
          sessionId: session.id,
          cwd: workCwd,
          model: session.model,
          modelSettings: session.modelSettings,
          providerAccountId: session.providerAccountId,
          runtimeMode: session.runtimeMode,
          ephemeral: session.ephemeral === true,
          intent: sent.intent,
          userMessageUuids: sent.userMessageUuids,
          ...sessionToolsInput(session, workCwd),
          providerSessionId: session.providerSessionId,
          ...(turn.providerTurnId
            ? { providerTurnId: turn.providerTurnId }
            : {}),
          openTools: turn.openTools,
          onEvent: (event) => sink.onEvent(session.id, event),
        });
      } catch {
        // Settled below as a turn that could not be taken back.
      }
      // Not taken back: stop the spared process, as the unload would have,
      // keeping the conversation for Continue.
      if (!outcome.attached)
        await stopHarnessSession(session.harness, session.id).catch(
          () => undefined,
        );
      sink.flush();
      sink.update(session.id, (current) =>
        outcome.attached
          ? stopStreaming(current)
          : markTurnInterrupted(current),
      );
    }),
  );
}

/** For tests: forget this page's reload hand-over. */
export function __resetReloadHandover(): void {
  handedOver.clear();
  reloadTurnsTaken = null;
}


function terminalFileIds(tabs: WorkspaceTab[]): string[] {
  const ids: string[] = [];
  for (const tab of tabs) {
    for (const pane of [...tab.editorPanes, ...(tab.terminalPanes ?? [])]) {
      for (const file of pane.files) {
        if (file.terminal) ids.push(file.id);
      }
    }
  }
  return ids;
}
