import type { ComponentProps } from "react";
import { AgentTranscript } from "../../sessions/ui/AgentTranscript";
import { ApprovalRulesContext, type ApprovalRules } from "./approvalRules";

/**
 * The transcript inside the provider its approval cards read their chat's
 * rules from. A pane's transcript is rendered by the transcript pool, outside
 * the pane's own tree, so a provider placed around it in the pane would not
 * reach it. The pool also sets `visible` and `parked` on the element it is
 * given and compares its props, so the provider travels as one element with
 * the transcript's props, and `approvalRules` must keep its identity.
 */
export function TranscriptWithApprovalRules({
  approvalRules,
  ...transcript
}: ComponentProps<typeof AgentTranscript> & {
  approvalRules: ApprovalRules | null;
}) {
  return (
    <ApprovalRulesContext.Provider value={approvalRules}>
      <AgentTranscript {...transcript} />
    </ApprovalRulesContext.Provider>
  );
}
