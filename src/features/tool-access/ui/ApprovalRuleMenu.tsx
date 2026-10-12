import type { ApprovalOptions } from "../model/networkApproval";
import { FOR_CHAT_OPTIONS } from "./AllowForChatButton";
import { useRef, useState } from "react";
import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import { MoreHorizontal } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import type { Block, ToolAccessRule } from "../../sessions/model/session";
import { useApprovalRules } from "./approvalRules";

const ITEM =
  "block w-full break-words rounded-lg px-2.5 py-1.5 text-left text-[12px] leading-4 text-content/85 hover:bg-content/8";

/**
 * The overflow control beside Allow and Deny on an approval card. It answers
 * the request and keeps the answer as this chat's rule for the tool. Renders
 * nothing where the request names no tool or the chat keeps no rules.
 */
export function ApprovalRuleMenu({
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
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const tool = approval.tool;
  if (!rules || !tool || !rules.applies(tool.key)) return null;
  const choose = (rule: ToolAccessRule) => {
    setOpen(false);
    // The rule goes first, so the harness knows why a blocked call is refused.
    rules.remember(tool, rule);
    if (rule === "always")
      onApproval(approval.requestId, "allow", FOR_CHAT_OPTIONS);
    else onApproval(approval.requestId, "deny");
  };
  return (
    <>
      <button
        ref={opener}
        type="button"
        title="Remember for this chat"
        aria-label={`Remember a choice for ${tool.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-approval-rule-menu
        onClick={() => setOpen((shown) => !shown)}
        className="grid w-6 place-items-center rounded-md bg-content/10 text-content/70 hover:bg-content/20"
      >
        <MoreHorizontal className="size-3.5" />
      </button>
      {open ? (
        <Popover
          anchor={opener}
          side="bottom"
          align="start"
          width={250}
          constrainHeight={false}
          role="menu"
          aria-label={`Remember a choice for ${tool.label}`}
          className="p-1"
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") opener.current?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => choose("always")}
          >
            Always allow {tool.label} in this chat
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => choose("never")}
          >
            Never allow {tool.label} in this chat
          </button>
        </Popover>
      ) : null}
    </>
  );
}
