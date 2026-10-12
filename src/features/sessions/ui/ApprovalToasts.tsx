import { CircleAlert } from "../../../shared/ui/icons";
import { useState } from "react";
import { createPortal } from "react-dom";
import { allowsProjectNotification } from "../../notifications/model/notificationPreferences";
import { knownNotificationProject } from "../../notifications/model/notificationProjects";
import { useProjectNotificationPreferences } from "../../notifications/hooks/useProjectNotificationPreferences";
import type { ApprovalDecision } from "../../../integrations/harness";
import type { PendingApprovalNotice } from "../../notifications/model/approvalToast";
import {
  alwaysAllowHostOptions,
  networkApprovalView,
  type ApprovalOptions,
} from "../../tool-access/model/networkApproval";
import { LAYER } from "../../../shared/lib/layers";
import {
  HARNESS_TITLE,
  sessionDisplayTitle,
  type Session,
} from "../model/session";
import { HarnessIcon } from "./HarnessIcon";

type Notice = PendingApprovalNotice & { session: Session };

type Props = {
  notices: Notice[];
  topOffset?: number;
  onFocusSession: (sessionId: string) => void;
  onApproval: (
    sessionId: string,
    requestId: number,
    decision: ApprovalDecision,
    options?: ApprovalOptions,
  ) => void;
};

export function ApprovalToasts({
  notices,
  onFocusSession,
  onApproval,
  topOffset = 12,
}: Props) {
  useProjectNotificationPreferences();
  if (notices.length === 0) return null;

  return createPortal(
    <div
      aria-live="polite"
      style={{ zIndex: LAYER.toast, top: topOffset }}
      className="pointer-events-none fixed right-3 flex w-[min(360px,calc(100vw-24px))] flex-col gap-2"
    >
      {notices.map((notice) => (
        <ProjectApprovalToast
          key={`${notice.sessionId}:${notice.kind}:${notice.requestId}`}
          notice={notice}
          onFocusSession={onFocusSession}
          onApproval={onApproval}
        />
      ))}
    </div>,
    document.body,
  );
}

function ProjectApprovalToast(props: {
  notice: Notice;
  onFocusSession: Props["onFocusSession"];
  onApproval: Props["onApproval"];
}) {
  const path = props.notice.session.cwd;
  // The keyed gate stays mounted even while hidden. Resuming notifications
  // must not turn a pending request into a new popup.
  const [occurredAt] = useState(Date.now);
  const project = knownNotificationProject(path);

  if (
    !project ||
    !allowsProjectNotification({
      projectId: project.id,
      category: "agentInput",
      occurredAt,
    })
  )
    return null;
  return <ApprovalToastCard {...props} />;
}

export function ApprovalToastCard({
  notice,
  onFocusSession,
  onApproval,
}: {
  notice: Notice;
  onFocusSession: (sessionId: string) => void;
  onApproval: Props["onApproval"];
}) {
  const { session, label, requestId } = notice;
  const title = sessionDisplayTitle(session.title, session.harness);
  const harness = HARNESS_TITLE[session.harness];

  const openSession = () => onFocusSession(session.id);
  // Host text comes from the harness: plain text only, never a link.
  const network =
    notice.kind === "approval" ? networkApprovalView(notice.block?.approval) : null;

  return (
    <article
      className="approval-toast pointer-events-auto overflow-hidden rounded-xl border border-content/20 border-dashed bg-content/10 shadow-xl backdrop-blur-xl"
      role="status"
    >
      <button
        type="button"
        onClick={openSession}
        className="flex w-full flex-col gap-2 px-3.5 py-3 text-left hover:bg-content/5"
      >
        <span className="flex items-center gap-2">
          <HarnessIcon harness={session.harness} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug text-content">
            {title}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber-400">
            <CircleAlert className="size-3.5" strokeWidth={1.75} />
            <span>{notice.kind === "question" ? "Question" : "Approval"}</span>
          </span>
        </span>
        <span className="line-clamp-3 text-[12px] leading-relaxed text-content/70">
          {label}
        </span>
        {network ? (
          <span className="break-all text-[11px] text-content/60">
            Network access to {network.host} ({network.protocol})
          </span>
        ) : null}
        <span className="text-[11px] text-content/40">{harness}</span>
      </button>
      {/* A sign-in is answered on its card, where the page can be opened. */}
      {notice.kind === "question" ||
      (notice.kind === "approval" && notice.block?.approval?.signIn) ? null : (
        <div className="flex gap-2 border-t border-stroke px-3.5 py-2.5">
          <button
            type="button"
            className="flex-1 rounded-md bg-content px-2.5 py-1 text-[11px] font-medium text-background-base hover:bg-content/80"
            onClick={() => onApproval(session.id, requestId, "allow")}
          >
            Allow
          </button>
          {network?.alwaysAllowHost ? (
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded-md bg-content/10 px-2.5 py-1 text-[11px] font-medium text-content/80 hover:bg-content/20"
              onClick={() =>
                onApproval(
                  session.id,
                  requestId,
                  "allow",
                  alwaysAllowHostOptions(network.alwaysAllowHost!),
                )
              }
            >
              Always allow {network.alwaysAllowHost}
            </button>
          ) : null}
          <button
            type="button"
            className="flex-1 rounded-md bg-content/10 px-2.5 py-1 text-[11px] font-medium text-content/70 hover:bg-content/20"
            onClick={() => onApproval(session.id, requestId, "deny")}
          >
            Deny
          </button>
        </div>
      )}
    </article>
  );
}
