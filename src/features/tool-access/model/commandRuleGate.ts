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
 * - npm, pnpm, yarn: the rule answers only while the script it runs, its pre
 *   and post scripts and the project's `.npmrc` are as they were when the
 *   user allowed it (see `scriptRuleStore`). Changed, missing or unreadable
 *   shows the card, which names the rule as changed.
 */
import { invoke } from "@tauri-apps/api/core";
import type { PreviewConfigFiles } from "../../app-preview/model/launchConfig";
import { sha256Hex } from "../../app-preview/model/sha256";
import {
  commandRuleFromKey,
  packageScriptOf,
  shellWords,
  type CommandRule,
} from "./commandRules";
import { scriptRuleFingerprint } from "./scriptRuleStore";

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
  | { allow: true }
  | {
      allow: false;
      reason: "git-config" | "unreadable" | "script-changed";
    };

/**
 * Whether the rule kept under `key` may answer a request in `cwd` without
 * the card. Fails closed: an error, a missing folder or an answer that is not
 * a plain boolean shows the card.
 */
export async function commandRuleGate(
  key: string,
  cwd: string,
  call: RuleGateInvoke = tauriInvoke,
  chat = "",
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
  const script = packageScriptOf(rule);
  if (script !== null) {
    const kept = scriptRuleFingerprint(chat, key);
    const now = await packageScriptFingerprint(cwd, script, call);
    return kept !== undefined && now !== null && kept === now
      ? { allow: true }
      : { allow: false, reason: "script-changed" };
  }
  return { allow: true };
}

/** The scripts in a project's `package.json`, and its `.npmrc` hash. */
export type PackageScripts = {
  scripts: Record<string, string>;
  npmrcSha256: string | null;
};

/**
 * The project's package scripts, read by Rust from `package.json` in `cwd`
 * (held inside it). Null when they cannot be read in full: no folder, a
 * `package.json` or `.npmrc` that is a link out, too large or not text, or
 * JSON that does not parse. A folder with no `package.json` has no scripts.
 */
export async function readPackageScripts(
  cwd: string,
  call: RuleGateInvoke = tauriInvoke,
): Promise<PackageScripts | null> {
  if (!cwd) return null;
  let files: PreviewConfigFiles;
  try {
    files = await call<PreviewConfigFiles>("preview_read_config", {
      root: cwd,
    });
  } catch {
    return null;
  }
  if (!files || typeof files !== "object") return null;
  if (
    (files.skipped ?? []).some(
      (reason) =>
        typeof reason !== "string" ||
        reason.startsWith("package.json") ||
        reason.startsWith(".npmrc"),
    )
  )
    return null;
  const npmrc = files.npmrcSha256 ?? null;
  if (npmrc !== null && !/^[0-9a-f]{64}$/.test(npmrc)) return null;
  const scripts: Record<string, string> = {};
  if (typeof files.packageJson === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(files.packageJson);
    } catch {
      return null;
    }
    const raw =
      parsed && typeof parsed === "object"
        ? (parsed as { scripts?: unknown }).scripts
        : undefined;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [name, body] of Object.entries(raw as Record<string, unknown>))
        if (typeof body === "string") scripts[name] = body;
    }
  } else if (files.packageJson !== undefined && files.packageJson !== null) {
    return null;
  }
  return { scripts, npmrcSha256: npmrc };
}

const own = (scripts: Record<string, string>, name: string) =>
  Object.prototype.hasOwnProperty.call(scripts, name) ? scripts[name] : null;

/**
 * SHA-256 over what a package manager runs for `script`: its body, its
 * `pre` and `post` scripts, and the project's `.npmrc`.
 */
export function scriptFingerprint(
  project: PackageScripts,
  script: string,
): string {
  return sha256Hex(
    JSON.stringify([
      "monocode.command-rule-script.v1",
      script,
      own(project.scripts, script),
      own(project.scripts, `pre${script}`),
      own(project.scripts, `post${script}`),
      project.npmrcSha256,
    ]),
  );
}

/** `scriptFingerprint` read fresh from disk. Null when it cannot be read. */
export async function packageScriptFingerprint(
  cwd: string,
  script: string,
  call: RuleGateInvoke = tauriInvoke,
): Promise<string | null> {
  const project = await readPackageScripts(cwd, call);
  return project ? scriptFingerprint(project, script) : null;
}

function formatWords(rule: CommandRule): string {
  return rule.kind === "prefix" ? rule.prefix : rule.command;
}
