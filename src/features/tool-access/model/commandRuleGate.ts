/**
 * The last check before a kept command rule answers a Claude Code Bash
 * request without the card. The rule says which words may run; this asks
 * whether the project around those words still runs only what the user saw.
 *
 * - git: a read-only git subcommand still runs a command the repository's
 *   own config names (`core.fsmonitor`, a pager, a diff or filter driver from
 *   `.gitattributes`, an alias) or a hook git runs when it refreshes the
 *   index. The agent can write those files, so a git rule answers only when
 *   Rust finds none. Any failure shows the card.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  commandRuleFromKey,
  shellWords,
  type CommandRule,
} from "./commandRules";

export type RuleGateInvoke = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;

const GIT_WORD = /(^|[^A-Za-z0-9_.-])git($|[^A-Za-z0-9_.-])/;

const tauriInvoke: RuleGateInvoke = (command, args) => invoke(command, args);

/** What a rule's command starts with, as words. Null when it cannot be read. */
export function ruleWords(rule: CommandRule): string[] | null {
  return rule.kind === "prefix"
    ? rule.prefix.split(" ")
    : shellWords(rule.command);
}

/** Why the card shows although a rule covers the command. */
export type RuleGateResult =
  { allow: true } | { allow: false; reason: "git-config" | "unreadable" };

/**
 * Whether the rule kept under `key` may answer a request in `cwd` without
 * the card. Fails closed: an error, a missing folder or an answer that is not
 * a plain boolean shows the card.
 */
export async function commandRuleGate(
  key: string,
  cwd: string,
  call: RuleGateInvoke = tauriInvoke,
): Promise<RuleGateResult> {
  const rule = commandRuleFromKey(key);
  if (!rule) return { allow: false, reason: "unreadable" };
  const words = ruleWords(rule);
  // Any rule whose words name git, also an exact rule the shell reading
  // cannot split (`cd x && git status`).
  if (words?.[0] === "git" || GIT_WORD.test(formatWords(rule))) {
    if (!cwd) return { allow: false, reason: "git-config" };
    try {
      const names = await call<unknown>("git_repo_names_commands", { cwd });
      return names === false
        ? { allow: true }
        : { allow: false, reason: "git-config" };
    } catch {
      return { allow: false, reason: "git-config" };
    }
  }
  return { allow: true };
}

function formatWords(rule: CommandRule): string {
  return rule.kind === "prefix" ? rule.prefix : rule.command;
}
