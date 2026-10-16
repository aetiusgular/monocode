import {
  leafIds,
  type WorkspaceTab,
} from "../../features/workspace/model/layout";
import type { ProjectTerminalDock } from "../../features/projects/model/projectTerminal";
import type { Session } from "../../features/sessions/model/session";

export type WindowTransferPayload = {
  tabs: WorkspaceTab[];
  sessions: Session[];
  activeTabId: string;
  projectCwd: string;
  dirtyFileIds: string[];
  projectTerminals?: ProjectTerminalDock[];
};

export function collectWindowTransfer(
  tabs: WorkspaceTab[],
  sessions: Session[],
  tabIds: string[],
  activeTabId: string,
  dirtyFiles: Set<string>,
  fallbackCwd: string,
  projectTerminals: ProjectTerminalDock[] = [],
): WindowTransferPayload | null {
  const idSet = new Set(tabIds);
  const movingTabs = tabs.filter((tab) => idSet.has(tab.id));
  if (movingTabs.length === 0) return null;

  const sessionIds = new Set<string>();
  for (const tab of movingTabs) {
    for (const id of leafIds(tab.layout)) sessionIds.add(id);
  }

  const movingSessions = sessions.filter((session) =>
    sessionIds.has(session.id),
  );
  const dirtyInTabs = new Set<string>();
  for (const tab of movingTabs) {
    for (const pane of [...tab.editorPanes, ...(tab.terminalPanes ?? [])]) {
      for (const file of pane.files) {
        if (dirtyFiles.has(file.id)) dirtyInTabs.add(file.id);
      }
    }
  }

  const activeTabIdInGroup = idSet.has(activeTabId)
    ? activeTabId
    : movingTabs[0].id;

  return {
    tabs: movingTabs,
    sessions: movingSessions,
    activeTabId: activeTabIdInGroup,
    projectCwd: movingSessions[0]?.cwd ?? fallbackCwd,
    dirtyFileIds: [...dirtyInTabs],
    ...(projectTerminals.length > 0 ? { projectTerminals } : {}),
  };
}

/**
 * The chats a new window binds to their provider conversations before its
 * first turn (Mac 4.14). A window keeps which conversation each chat resumes
 * in its own memory, so a moved chat arrives with none; without this its
 * first prompt started a new Claude Code conversation (`--session-id`) or a
 * new Codex thread instead of resuming its own. A moved chat is bound the way
 * a chat restored after a restart is.
 */
export function bootSessionsToBind(
  windowTransfer: Pick<WindowTransferPayload, "sessions"> | null | undefined,
  resumed: { sessions: Session[] } | null | undefined,
): Session[] {
  return windowTransfer?.sessions ?? resumed?.sessions ?? [];
}

/** Whether a tab can move to a window of its own, and if not, why. */
export type PopOutCheck = { ok: true } | { ok: false; reason: string };

/**
 * Shown with the menu item. A window opened from a transfer keeps its tabs in
 * memory for its own reloads and never in the saved workspace, so they are
 * not reopened after a quit; the chats are saved as usual and stay in History.
 */
export const POP_OUT_NOTE =
  "After a quit, tabs in the new window are not reopened. Their chats stay in History.";

type PopOutSession = Pick<
  Session,
  | "id"
  | "cwd"
  | "blocks"
  | "busy"
  | "resendingEdited"
  | "sendingQueuedMessageId"
  | "queuedMessages"
  | "backgroundTasks"
  | "pendingSwitch"
  | "worktreePreparing"
  | "pendingQuestion"
  | "orchestrationLeadId"
>;

/** Why a chat is not idle, or null when it is. */
export function sessionNotIdle(session: PopOutSession): string | null {
  if (
    session.busy ||
    session.resendingEdited ||
    session.sendingQueuedMessageId
  ) {
    return "a turn is running";
  }
  if (session.queuedMessages?.length) return "messages are queued";
  if (session.backgroundTasks?.length) return "background work is running";
  if (session.pendingSwitch) return "a harness switch is pending";
  if (session.worktreePreparing) return "its worktree is being made";
  if (session.pendingQuestion) return "it is waiting for your answer";
  if (
    session.blocks.some(
      (block) => block.approval && block.approval.decided === undefined,
    )
  ) {
    return "it is waiting for an approval";
  }
  return null;
}

/**
 * Rules for moving one tab to a new window. Only idle chats move: a chat is
 * stopped here and bound again in the new window, which every harness
 * supports between turns. Terminals, unsaved files, orchestration and remote
 * chats belong to this window's processes and state, so a tab holding one
 * stays. A window keeps at least one tab.
 */
export function popOutCheck(
  tabs: WorkspaceTab[],
  sessions: PopOutSession[],
  tabId: string,
  dirtyFiles: Set<string>,
  isRemote: (cwd: string) => boolean = () => false,
): PopOutCheck {
  const tab = tabs.find((entry) => entry.id === tabId);
  if (!tab) return { ok: false, reason: "This tab is gone." };
  if (tabs.length < 2) {
    return { ok: false, reason: "A window keeps at least one tab." };
  }
  const files = [
    ...tab.editorPanes.flatMap((pane) => pane.files),
    ...(tab.terminalPanes ?? []).flatMap((pane) => pane.files),
  ];
  if (files.some((file) => file.terminal)) {
    return {
      ok: false,
      reason: "Close its terminals first. They run in this window.",
    };
  }
  if (files.some((file) => dirtyFiles.has(file.id))) {
    return { ok: false, reason: "Save its files first." };
  }
  const ids = new Set(leafIds(tab.layout));
  for (const session of sessions) {
    if (!ids.has(session.id)) continue;
    if (session.orchestrationLeadId) {
      return { ok: false, reason: "Orchestration chats stay in their window." };
    }
    if (isRemote(session.cwd)) {
      return { ok: false, reason: "Remote chats stay in their window." };
    }
    const busy = sessionNotIdle(session);
    if (busy) {
      return {
        ok: false,
        reason: `Wait until the chat is idle: ${busy}.`,
      };
    }
  }
  return { ok: true };
}

/** What moving a tab needs from the window it leaves. */
export type PopOutSteps = {
  payload: WindowTransferPayload;
  /** Stop a chat's harness processes. Idle, so no turn is cancelled. */
  stopSession: (session: Session) => Promise<void>;
  /** Hand the payload to the next window that opens. */
  stage: (json: string) => Promise<void>;
  openWindow: () => Promise<void>;
  /**
   * Drop a staged payload nobody took. Without it a New Window opened in the
   * next minute would take the tabs that stayed here, and two windows would
   * drive the same provider conversations.
   */
  unstage?: () => Promise<void>;
  /** Take the tabs out of this window without asking again. */
  closeTabs: (tabIds: string[]) => void;
};

/**
 * Stop, then hand over, then open, then close here. A failure before the
 * window opens clears the handed-over payload and leaves the tabs where they
 * were; their chats start again on
 * their next turn, bound to the same provider session.
 */
export async function popOutTabs(steps: PopOutSteps): Promise<PopOutCheck> {
  const { payload } = steps;
  for (const session of payload.sessions) {
    await steps.stopSession(session).catch(() => undefined);
  }
  try {
    await steps.stage(JSON.stringify(payload));
    await steps.openWindow();
  } catch (err) {
    // A failed stage may still have left a payload; clear it either way.
    await steps.unstage?.().catch(() => undefined);
    return {
      ok: false,
      reason: `Could not open a new window: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  steps.closeTabs(payload.tabs.map((tab) => tab.id));
  return { ok: true };
}

/** The title bar reaches the app through this, not through props. */
export type PopOutHost = {
  check: (tabId: string) => PopOutCheck;
  popOut: (tabId: string) => Promise<PopOutCheck>;
};

let popOutHost: PopOutHost | null = null;

export function setPopOutHost(host: PopOutHost | null): void {
  popOutHost = host;
}

export function getPopOutHost(): PopOutHost | null {
  return popOutHost;
}
