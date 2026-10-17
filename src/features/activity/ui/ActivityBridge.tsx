import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApprovalOptions } from "../../tool-access/model/networkApproval";
import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import { readSiteRules } from "../../browser-tools/model/siteRules";
import { chatFolders } from "../../tool-access/model/chatFolders";
import type {
  HarnessId,
  Session,
  ToolAccess,
} from "../../sessions/model/session";
import {
  approvalsRecorder,
  type ApprovalsRecorder,
} from "../model/approvalsRecord";
import { installActivityTap } from "../model/activityTap";
import { applyFloor } from "../model/collectorSettings";

type BridgeSession = Pick<
  Session,
  "id" | "harness" | "cwd" | "worktreeCwd" | "extraDirs" | "toolAccess"
>;

export type ChatContextPayload = {
  chatId: string;
  harness: HarnessId;
  folders: string[];
};

/** What the check knows about a chat: its harness and the folders it writes in. */
export function chatContextOf(session: BridgeSession): ChatContextPayload {
  return {
    chatId: session.id,
    harness: session.harness,
    folders: chatFolders(session.worktreeCwd ?? session.cwd, session.extraDirs),
  };
}

/**
 * Brings the sessions the app holds up to date in the recorder and the Rust
 * side. Pure apart from its two outputs, for tests.
 */
export function syncSessions(
  sessions: readonly BridgeSession[],
  sent: Map<string, string>,
  recorder: Pick<ApprovalsRecorder, "noteSession" | "forgetSession">,
  sendContext: (context: ChatContextPayload) => void,
): void {
  const live = new Set<string>();
  for (const session of sessions) {
    live.add(session.id);
    recorder.noteSession({
      id: session.id,
      harness: session.harness,
      toolAccess: session.toolAccess as ToolAccess | undefined,
    });
    const context = chatContextOf(session);
    const key = JSON.stringify(context);
    if (sent.get(session.id) !== key) {
      sent.set(session.id, key);
      sendContext(context);
    }
  }
  for (const id of [...sent.keys()]) {
    if (live.has(id)) continue;
    sent.delete(id);
    recorder.forgetSession(id);
  }
}

function sendContext(context: ChatContextPayload): void {
  try {
    if (!isTauri()) return;
    void invoke("activity_set_chat", { context }).catch(() => undefined);
  } catch {
    // The check then treats the chat as having no folders.
  }
}

/**
 * Mounted once in the app. Installs the event tap, keeps the recorder and
 * the check's chat list current, and reads the browser site rules when the
 * sessions change. Renders nothing.
 */
export function ActivityBridge({
  sessions,
}: {
  sessions: readonly BridgeSession[];
}) {
  const sent = useRef(new Map<string, string>());

  useEffect(() => {
    const remove = installActivityTap((sessionId, event) => {
      approvalsRecorder.noteHarnessEvent(sessionId, event);
      if (event.type === "approval.resolved")
        approvalsRecorder.noteSiteRules(readSiteRules());
    });
    void applyFloor();
    return remove;
  }, []);

  useEffect(() => {
    try {
      syncSessions(sessions, sent.current, approvalsRecorder, sendContext);
      approvalsRecorder.noteSiteRules(readSiteRules());
    } catch {
      // The log never stops the app.
    }
  }, [sessions]);

  return null;
}

type OnApproval = (
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
  options?: ApprovalOptions,
) => void;

const wrapped = new WeakMap<OnApproval, OnApproval>();

/**
 * The pane's approval callback, with your choice noted first ("Always allow
 * <host>"). Cached per callback, so the props keep their identity.
 */
export function withApprovalNotes(onApproval: OnApproval): OnApproval {
  const known = wrapped.get(onApproval);
  if (known) return known;
  const next: OnApproval = (sessionId, requestId, decision, options) => {
    try {
      approvalsRecorder.noteChoice(sessionId, requestId, decision, options);
    } catch {
      // Recording never stops the answer.
    }
    onApproval(sessionId, requestId, decision, options);
  };
  wrapped.set(onApproval, next);
  return next;
}

/**
 * The pane's props, with `onApproval` wrapped. Typed as optional so it can be
 * spread after the original property in the app's props object.
 */
export function approvalPaneProps(onApproval: OnApproval): {
  onApproval?: OnApproval;
} {
  return { onApproval: withApprovalNotes(onApproval) };
}
