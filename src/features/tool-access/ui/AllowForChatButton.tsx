import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { Block } from "../../sessions/model/session";
import type { ApprovalOptions } from "../model/networkApproval";
import { useApprovalRules } from "./approvalRules";

/** What the card sends when "Allow for this chat" is picked. */
export const FOR_CHAT_OPTIONS: ApprovalOptions = Object.freeze({
  forChat: true,
});

const TITLE =
  "Allow this now and keep allowing it in this chat, also after a restart. " +
  "File changes are allowed only inside the chat's folders; anything else asks again.";

/**
 * "Allow for this chat" beside Allow and Deny. It saves the chat's "always"
 * rule for the tool, which persists with the chat, then allows the request.
 * Shown only where the chat can keep rules for this tool, and never for a
 * network request, which has its own host choice.
 */
export function AllowForChatButton({
  approval,
  onApproval,
}: {
  approval: NonNullable<Block["approval"]>;
  onApproval: (
    requestId: number,
    decision: ApprovalDecision,
    options?: ApprovalOptions,
  ) => void;
}) {
  const rules = useApprovalRules();
  const tool = approval.tool;
  if (!rules || !tool || !rules.applies(tool.key) || approval.network)
    return null;
  return (
    <button
      type="button"
      title={TITLE}
      data-allow-for-chat
      className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/80 hover:bg-content/20"
      onClick={() => {
        // The rule goes first, so the next request in this turn already sees it.
        rules.remember(tool, "always");
        onApproval(approval.requestId, "allow", FOR_CHAT_OPTIONS);
      }}
    >
      Allow for this chat
    </button>
  );
}
