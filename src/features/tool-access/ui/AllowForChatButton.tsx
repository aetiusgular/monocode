import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { Block } from "../../sessions/model/session";
import type { ApprovalOptions } from "../model/networkApproval";
import { COMMAND_RULE_TOOL, commandRuleFromKey } from "../model/commandRules";
import { CODEX_COMMAND_TOOL } from "../model/toolAccess";
import { useApprovalRules } from "./approvalRules";

/** What the card sends when "Allow for this chat" is picked. */
export const FOR_CHAT_OPTIONS: ApprovalOptions = Object.freeze({
  forChat: true,
});

const TITLE =
  "Allow this now and keep allowing it in this chat, also after a restart. " +
  "File changes are allowed only inside the chat's folders; anything else asks again.";

const CODEX_COMMAND_TITLE =
  "Allow this command now and for the rest of this chat. Codex keeps the grant for this exact command only; other commands still ask.";

/**
 * What the button keeps for a request, and the words on its tooltip. Null
 * where it is not offered.
 *
 * - Claude Code's Bash: a rule for this command's prefix, as Claude Code's
 *   own prompt words it ("don't ask again for: npm test *"). Never the whole
 *   Bash tool: without a command rule the button is not shown.
 * - Codex commands: no rule. Codex keeps the grant for this exact command
 *   (`acceptForSession`).
 * - Anything else: the chat's "always" rule for the tool. File changes it
 *   allows stay held to the chat's folders.
 */
export function allowForChatPlan(approval: NonNullable<Block["approval"]>): {
  keep: NonNullable<Block["approval"]>["tool"] | null;
  title: string;
  /**
   * The command prefix the button itself names ("Allow `git grep` in this
   * chat"), so the rule is visible without the tooltip. Absent for any
   * other plan.
   */
  prefix?: string;
  /** True when the rule is this exact command only. */
  exact?: boolean;
} | null {
  const tool = approval.tool;
  if (!tool || approval.network) return null;
  if (tool.key === COMMAND_RULE_TOOL) {
    const rule = commandRuleFromKey(approval.chatRule?.key);
    if (!approval.chatRule || !rule) return null;
    const what =
      rule.kind === "prefix"
        ? `commands that start with "${rule.prefix}"`
        : `the command "${rule.command}"`;
    return {
      keep: approval.chatRule,
      title: `Allow ${what} in this chat, also after a restart. Any other command still asks.`,
      ...(rule.kind === "prefix" ? { prefix: rule.prefix } : { exact: true }),
    };
  }
  if (tool.key === CODEX_COMMAND_TOOL) {
    return { keep: null, title: CODEX_COMMAND_TITLE };
  }
  return { keep: tool, title: TITLE };
}

/**
 * "Allow for this chat" beside Allow and Deny. It saves the chat's rule (see
 * `allowForChatPlan`), which persists with the chat, then allows the request.
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
  if (!rules || !tool || !rules.applies(tool.key)) return null;
  const plan = allowForChatPlan(approval);
  if (!plan || (plan.keep && !rules.applies(plan.keep.key))) return null;
  const keep = plan.keep;
  return (
    <button
      type="button"
      title={plan.title}
      data-allow-for-chat
      className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/80 hover:bg-content/20"
      onClick={() => {
        // The rule goes first, so the next request in this turn already sees it.
        if (keep) rules.remember(keep, "always");
        onApproval(approval.requestId, "allow", FOR_CHAT_OPTIONS);
      }}
    >
      {plan.prefix ? (
        <>
          Allow <code className="font-mono">{plan.prefix}</code> in this chat
        </>
      ) : plan.exact ? (
        "Allow this exact command in this chat"
      ) : (
        "Allow for this chat"
      )}
    </button>
  );
}
