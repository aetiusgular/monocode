import { createContext, useContext, useMemo, useRef } from "react";
import {
  harnessSupportsToolAccess,
  type ApprovalTool,
  type HarnessId,
  type ToolAccess,
  type ToolAccessRule,
} from "../../sessions/model/session";
import { setToolChoice, toolKeyApplies } from "../model/toolAccess";

/** What an approval card needs to turn one answer into a standing rule. */
export type ApprovalRules = {
  /** True when this chat's harness answers requests for the key by rule. */
  applies(key: string): boolean;
  /** Keep the rule for this chat. The caller still answers the request. */
  remember(tool: ApprovalTool, rule: ToolAccessRule): void;
};

/**
 * Null wherever a chat cannot keep per-tool rules: a host session, a Mono, a
 * harness that does not name its tools. The card then offers Allow and Deny
 * only.
 */
export const ApprovalRulesContext = createContext<ApprovalRules | null>(null);

export function useApprovalRules(): ApprovalRules | null {
  return useContext(ApprovalRulesContext);
}

/**
 * The context value for one session's transcript. It keeps its identity while
 * the rules change, so storing a rule does not re-render the transcript.
 * `onChange` is absent where the chat's rules cannot be saved.
 */
export function useSessionApprovalRules(
  harness: HarnessId,
  toolAccess: ToolAccess | undefined,
  onChange: ((toolAccess: ToolAccess) => void) | undefined,
): ApprovalRules | null {
  const latest = useRef({ toolAccess, onChange });
  latest.current = { toolAccess, onChange };
  const available = !!onChange && harnessSupportsToolAccess(harness);
  return useMemo(
    () =>
      available
        ? {
            applies: (key) => toolKeyApplies(harness, key),
            remember: (tool, rule) => {
              const { toolAccess: current, onChange: change } = latest.current;
              const next = setToolChoice(current, tool.key, rule);
              if (next !== current) change?.(next);
            },
          }
        : null,
    [available, harness],
  );
}
