import type { Session } from "../../sessions/model/session";
import { chatSwitch, useChatSwitchVersion } from "../model/chatSwitch";
import {
  answerRequest,
  pendingFor,
  useComputerUseVersion,
} from "../model/client";
import { ApprovalCard } from "./ApprovalCard";

/**
 * The agent's open requests for this chat, one card each, over the chat's
 * pane. Nothing is granted until you click Allow.
 */
export function ComputerUseCards({ session }: { session: Session }) {
  useComputerUseVersion();
  useChatSwitchVersion();
  const requests = pendingFor(session.id);
  if (requests.length === 0) return null;
  const sw = chatSwitch(session.id);
  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-28 z-30 flex flex-col items-end gap-2"
      data-computer-use-cards
    >
      {requests.map((request) => (
        <ApprovalCard
          key={request.requestId}
          app={request.resolved}
          reason={request.reason}
          refusal={request.refusal}
          session={session}
          withoutVision={sw.withoutVision}
          onAllow={() => answerRequest(request, true, session.harness)}
          onDeny={() => answerRequest(request, false, session.harness)}
        />
      ))}
    </div>
  );
}
