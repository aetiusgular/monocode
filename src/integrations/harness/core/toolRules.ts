import type { HarnessToolAccess } from "./types";

/** A chat's per-tool rules, as an adapter's approval handler looks them up. */
export type ToolRules = { always: Set<string>; never: Set<string> };

export function toolRules(access?: HarnessToolAccess): ToolRules {
  return {
    always: new Set(access?.always ?? []),
    never: new Set(access?.never ?? []),
  };
}

/** The standing answer for a tool key, or null when the user is asked. */
export function ruleDecision(
  rules: ToolRules,
  key: string | undefined,
): "allow" | "deny" | null {
  if (!key) return null;
  // A tool cannot hold both rules; if a caller passes both, blocking wins.
  if (rules.never.has(key)) return "deny";
  return rules.always.has(key) ? "allow" : null;
}
