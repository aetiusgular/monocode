/**
 * Per-chat rules for one Claude Code command, as Claude Code's own prompt
 * offers them: "Yes, and don't ask again for: npm test *".
 *
 * A rule is kept in the chat's tool access under the key `Bash(<rule>)`, in
 * Claude Code's rule syntax:
 * - `npm test *` (or the older `npm test:*`): the command is `npm test` or
 *   starts with `npm test ` followed by more words.
 * - anything else: that exact command, nothing more.
 *
 * Matching is literal and conservative. A command that chains, pipes or
 * redirects (`;`, `&&`, `||`, `|`, `&`, backticks, `$(`, `<`, `>`, a line
 * break) never matches a prefix rule: `npm test && rm -rf ~` starts with
 * `npm test` and must still ask. Such a command matches only an exact rule
 * for the same text, which the user approved word for word.
 *
 * The whole Bash tool is never allowed by these rules. That stays the
 * explicit "Always allow Bash in this chat" choice.
 */

/** The tool the rules are for. */
export const COMMAND_RULE_TOOL = "Bash";

const MAX_RULE_LENGTH = 190;

/** Characters that let one command line run, feed or write more than one command. */
const COMPOUND = /[;&|`<>\n\r]|\$\(/;
/** Control characters never belong in a stored rule. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Commands that run whatever follows them. A prefix rule starting with one
 * would allow any program, so only an exact rule is kept for them.
 */
const RUNS_ANYTHING = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "env",
  "sudo",
  "doas",
  "su",
  "xargs",
  "eval",
  "exec",
  "command",
  "builtin",
  "nohup",
  "time",
  "timeout",
  "nice",
  "watch",
  "ssh",
  "osascript",
  "open",
  "source",
  ".",
]);
/** Interpreters: a prefix of the bare name would run any script or code. */
const INTERPRETERS =
  /^(python[0-9.]*|node|deno|bun|perl|ruby|php|pwsh|powershell|lua|Rscript)$/;

function prefixAllowed(prefix: string): boolean {
  const words = prefix.split(" ");
  const first = words[0] ?? "";
  if (RUNS_ANYTHING.has(first)) return false;
  // `python3 -m pytest *` names a module; `python3 *` or `node *` does not.
  if (INTERPRETERS.test(first)) {
    return words.length >= 3 && words[1] === "-m";
  }
  return true;
}

export type CommandRule =
  { kind: "prefix"; prefix: string } | { kind: "exact"; command: string };

/** True when the command chains, pipes, substitutes or redirects. */
export function isCompoundCommand(command: string): boolean {
  return COMPOUND.test(command);
}

function squash(text: string): string {
  return text.trim().replace(/[ \t]+/g, " ");
}

/**
 * A rule in Claude Code's syntax, read conservatively. Null for one MonoCode
 * will not keep: empty, too long, control characters, a wildcard anywhere
 * but the end, or a prefix that itself chains commands.
 */
export function parseCommandRule(raw: unknown): CommandRule | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_RULE_LENGTH) return null;
  if (CONTROL.test(raw)) return null;
  const text = squash(raw);
  if (!text) return null;
  const prefixed = /^(.*?)(?: \*|:\*)$/.exec(text);
  if (prefixed) {
    const prefix = prefixed[1].trim();
    if (
      !prefix ||
      prefix.includes("*") ||
      isCompoundCommand(prefix) ||
      !prefixAllowed(prefix)
    )
      return null;
    return { kind: "prefix", prefix };
  }
  if (text === "*") return null;
  // An exact rule keeps the text as given: inside quotes, spacing matters.
  return { kind: "exact", command: raw.trim() };
}

/** The rule in Claude Code's syntax, as stored. */
export function formatCommandRule(rule: CommandRule): string {
  return rule.kind === "prefix" ? `${rule.prefix} *` : rule.command;
}

/** The tool access key a rule is kept under. */
export function commandRuleKey(rule: CommandRule): string {
  return `${COMMAND_RULE_TOOL}(${formatCommandRule(rule)})`;
}

/** The rule a tool access key holds, or null when it holds none. */
export function commandRuleFromKey(key: unknown): CommandRule | null {
  if (typeof key !== "string") return null;
  const match = /^Bash\((.+)\)$/s.exec(key);
  if (!match) return null;
  const rule = parseCommandRule(match[1]);
  // Only the form MonoCode writes, so one rule has one key.
  return rule && commandRuleKey(rule) === key ? rule : null;
}

/** True when the key is a command rule MonoCode keeps. */
export function isCommandRuleKey(key: unknown): key is string {
  return commandRuleFromKey(key) !== null;
}

/** Whether a command is covered by a rule. */
export function commandMatchesRule(
  command: unknown,
  rule: CommandRule,
): boolean {
  if (typeof command !== "string" || CONTROL.test(command)) return false;
  if (rule.kind === "exact") return command.trim() === rule.command;
  const text = squash(command);
  if (!text || isCompoundCommand(command)) return false;
  return text === rule.prefix || text.startsWith(`${rule.prefix} `);
}

/** Tools whose first word alone says too little: their subcommand counts. */
const MULTI_WORD = new Set(["npm", "pnpm", "yarn", "git", "cargo", "npx"]);
/** A script runner whose next word is the script: `npm run build`. */
const RUNS_SCRIPT = new Set(["run", "run-script", "exec"]);

/**
 * A rule for a command when Claude Code suggested none. Conservative: a
 * prefix only for a known multi-word tool with a plain subcommand
 * (`npm test`, `git status`, `cargo build`, `npm run build`,
 * `python -m pytest`). Anything else, and any command that chains, gets an
 * exact rule for that command only.
 */
export function deriveCommandRule(command: unknown): CommandRule | null {
  if (typeof command !== "string") return null;
  const exact = parseCommandRule(
    command.length <= MAX_RULE_LENGTH ? command : "",
  );
  if (!exact || exact.kind !== "exact") return null;
  if (isCompoundCommand(command)) return exact;
  const words = squash(exact.command).split(" ");
  const word = (i: number) => words[i] ?? "";
  const plain = (w: string) => /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(w);
  const tool = word(0);
  let prefix: string[] | null = null;
  if (MULTI_WORD.has(tool) && plain(word(1))) {
    prefix =
      RUNS_SCRIPT.has(word(1)) && tool !== "git"
        ? plain(word(2))
          ? words.slice(0, 3)
          : null
        : words.slice(0, 2);
  } else if (
    /^python(3(\.\d+)?)?$/.test(tool) &&
    word(1) === "-m" &&
    plain(word(2))
  ) {
    prefix = words.slice(0, 3);
  }
  if (!prefix) return exact;
  return parseCommandRule(`${prefix.join(" ")} *`) ?? exact;
}

/**
 * The Bash rule Claude Code suggested on a `can_use_tool` request, from its
 * `permission_suggestions` (an `addRules` update with an allow rule for Bash).
 * Its `destination` is ignored: MonoCode keeps the rule on the chat.
 */
export function suggestedCommandRule(suggestions: unknown): CommandRule | null {
  // A suggested prefix MonoCode refuses (`bash *`) is skipped, so the rule
  // falls back to one derived from the command.
  if (!Array.isArray(suggestions)) return null;
  for (const update of suggestions.slice(0, 16)) {
    if (!update || typeof update !== "object") continue;
    const rec = update as Record<string, unknown>;
    if (rec.type !== "addRules" || rec.behavior !== "allow") continue;
    if (!Array.isArray(rec.rules)) continue;
    for (const entry of rec.rules.slice(0, 16)) {
      if (!entry || typeof entry !== "object") continue;
      const rule = entry as Record<string, unknown>;
      if (rule.toolName !== COMMAND_RULE_TOOL) continue;
      const parsed = parseCommandRule(rule.ruleContent);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * The rule "Allow for this chat" keeps for a command card: Claude Code's own
 * suggestion when it made one, else one derived from the command.
 */
export function commandRuleForRequest(
  command: unknown,
  suggestions: unknown,
): CommandRule | null {
  return suggestedCommandRule(suggestions) ?? deriveCommandRule(command);
}

/** The words a card or a row uses for a rule. */
export function commandRuleLabel(rule: CommandRule): string {
  return rule.kind === "prefix"
    ? `${rule.prefix} commands`
    : `the command ${rule.command}`;
}

/** The first rule key among `keys` that covers the command, if any. */
export function matchingCommandRule(
  keys: Iterable<string>,
  command: unknown,
): string | null {
  for (const key of keys) {
    const rule = commandRuleFromKey(key);
    if (rule && commandMatchesRule(command, rule)) return key;
  }
  return null;
}
