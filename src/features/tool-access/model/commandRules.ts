/**
 * Per-chat rules for one Claude Code command, as Claude Code's own prompt
 * offers them: "Yes, and don't ask again for: npm test *".
 *
 * A rule is kept in the chat's tool access under the key `Bash(<rule>)`, in
 * Claude Code's rule syntax:
 * - `npm test *` (or the older `npm test:*`): the command is `npm test` or
 *   starts with `npm test ` followed by more words. Each flag among those
 *   words must be on a short list of safe flags for that prefix, and words
 *   after `--` may not be flags (see `prefixPolicy`).
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
 * Whether MonoCode keeps a prefix rule for these words. An allowlist, the
 * same for Claude Code's suggestions and for rules MonoCode derives: a
 * suggestion is steered by the model, so `npx *`, `git *` or `make *` is
 * never kept (see `prefixPolicy`).
 */
function prefixAllowed(prefix: string): boolean {
  return prefixPolicy(prefix.split(" ")) !== null;
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

/** Characters a word may hold outside quotes: none of them means anything to bash or zsh. */
const PLAIN = /^[A-Za-z0-9_./:%@,+=-]$/;
/** What a backslash may make literal outside quotes: printable ASCII. */
const ESCAPABLE = /^[\x20-\x7e]$/;

/**
 * The words of a command as the shell would pass them, quotes removed. Null
 * when the shell could change the words before the program sees them. Claude
 * Code runs a command in the user's `$SHELL`, which is zsh on a stock Mac,
 * so the reading holds for bash and zsh both. It is an allowlist:
 * - outside quotes, only letters, digits and `_./:%@,+=-`, plus a backslash
 *   before a printable character; a word may not start with `=` (zsh runs
 *   `=cmd` as a path lookup). `(`, `)`, `^`, `~`, `#`, `!`, `$`, globs and
 *   braces all refuse, since zsh glob qualifiers like `*(e:cmd:)` run code;
 * - inside single quotes, anything but a control character, and no `''`
 *   straight after a closing quote (zsh's RC_QUOTES reads that as a quote);
 * - inside double quotes, anything but `$`, a backtick, `\` or `!`.
 * Such a command never matches a prefix rule.
 */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const text = command.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text.replace(/[ \t]/g, ""))) return null;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      i++;
      continue;
    }
    if (c === "'") {
      if (i > 0 && text[i - 1] === "'") return null;
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      const quoted = text.slice(i + 1, end);
      if (quoted.includes("\t")) return null;
      word += quoted;
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        const d = text[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "$" || d === "`" || d === "\\" || d === "!" || d === "\t")
          return null;
        word += d;
        i++;
      }
      if (!closed) return null;
      inWord = true;
      continue;
    }
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined || !ESCAPABLE.test(next)) return null;
      word += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (!PLAIN.test(c)) return null;
    // `=cmd` is a command path lookup in zsh, also after empty quotes.
    if (c === "=" && word === "") return null;
    word += c;
    inWord = true;
    i++;
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * Flags that run a program, write a file, load config or change where a
 * tool looks for code. They never pass a prefix rule, wherever they appear.
 */
const REFUSED_FLAGS = new Set([
  // git
  "--config-env",
  "--open-files-in-pager",
  "--output",
  "--ext-diff",
  "--textconv",
  "--exec",
  "--upload-pack",
  "--exec-path",
  // cargo
  "--config",
  // npm, pnpm, yarn
  "--script-shell",
  "--prefix",
  "--userconfig",
  "--globalconfig",
  "--node-options",
  // npx
  "--package",
  "--call",
]);
/**
 * Short flags refused alone or with a value glued on (`-O'sh -c id'`), by
 * tool. Git's own `-c` goes before the subcommand, so it never follows a
 * git prefix; `git grep -c` is the count flag.
 */
const REFUSED_SHORT: Record<string, RegExp> = {
  git: /^-O/,
  cargo: /^-Z/,
  npx: /^-[pc]/,
};

/** What may follow a prefix MonoCode keeps a rule for. */
type PrefixPolicy = {
  /** Flags allowed after the prefix, by name (the part before `=`). */
  flags: ReadonlySet<string>;
  /** Short flags that may carry a value glued on, by their two letters. */
  shortWithValue?: ReadonlySet<string>;
  /** `git log -5`. */
  countFlag?: boolean;
  /**
   * Words that are not flags: allowed anywhere, never, or only once one of
   * the listed flags came first (`git branch --list x`).
   */
  positional: "any" | "none" | { after: ReadonlySet<string> };
  /**
   * Words that are not flags must name something inside the project: no
   * absolute path, no `..` step, no `@file` argument list (pytest).
   */
  insideProject?: boolean;
};

const set = (...items: string[]) => new Set(items);

/** Git subcommands that read the repository and run no hook or alias. */
const GIT: Record<string, PrefixPolicy> = {
  status: {
    flags: set(
      "-s",
      "--short",
      "-b",
      "--branch",
      "--porcelain",
      "--long",
      "-v",
      "--ignored",
    ),
    positional: "any",
  },
  diff: {
    flags: set(
      "--stat",
      "--name-only",
      "--name-status",
      "--cached",
      "--staged",
      "--shortstat",
      "--numstat",
      "-w",
      "--ignore-all-space",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-p",
      "--patch",
      "--minimal",
      "--word-diff",
      "--unified",
    ),
    positional: "any",
  },
  log: {
    flags: set(
      "--oneline",
      "-n",
      "--max-count",
      "--stat",
      "--graph",
      "--decorate",
      "--all",
      "-p",
      "--patch",
      "--name-only",
      "--name-status",
      "--format",
      "--pretty",
      "--abbrev-commit",
      "--no-merges",
      "--reverse",
      "--since",
      "--until",
      "--author",
      "--follow",
      "--no-color",
      "--no-ext-diff",
    ),
    countFlag: true,
    positional: "any",
  },
  show: {
    flags: set(
      "--stat",
      "--name-only",
      "--name-status",
      "--oneline",
      "-p",
      "--patch",
      "--format",
      "--pretty",
      "--no-patch",
      "-s",
      "--no-color",
      "--abbrev-commit",
      "--no-ext-diff",
    ),
    positional: "any",
  },
  grep: {
    flags: set(
      "-n",
      "-i",
      "-l",
      "-w",
      "-e",
      "-E",
      "-F",
      "-c",
      "--count",
      "--name-only",
      "-h",
      "-H",
      "--line-number",
      "--ignore-case",
    ),
    positional: "any",
  },
  branch: {
    flags: set(
      "-a",
      "--all",
      "-r",
      "--remotes",
      "-v",
      "-vv",
      "--list",
      "-l",
      "--show-current",
      "--merged",
      "--no-merged",
      "--contains",
      "--no-color",
    ),
    // `git branch x` makes a branch; `git branch --list x` only lists.
    positional: { after: set("--list", "-l") },
  },
  blame: {
    flags: set(
      "-L",
      "-w",
      "-M",
      "-C",
      "-e",
      "-s",
      "--porcelain",
      "--line-porcelain",
      "-l",
      "--show-email",
    ),
    positional: "any",
  },
  "ls-files": {
    flags: set(
      "-m",
      "-o",
      "-d",
      "--cached",
      "--modified",
      "--others",
      "--deleted",
      "--exclude-standard",
      "-s",
      "--stage",
      "-z",
      "--full-name",
    ),
    positional: "any",
  },
  "rev-parse": {
    flags: set(
      "--show-toplevel",
      "--abbrev-ref",
      "--short",
      "--verify",
      "--git-dir",
      "--is-inside-work-tree",
      "--show-prefix",
      "--symbolic-full-name",
      "-q",
      "--quiet",
    ),
    positional: "any",
  },
};

/** `npm test`, `pnpm lint`, `yarn run build x`: the script's own words follow. */
const PACKAGE_SCRIPT: PrefixPolicy = {
  flags: set("--silent", "-s", "--if-present"),
  positional: "any",
};
const PACKAGE_MANAGERS = set("npm", "pnpm", "yarn");
const PACKAGE_SUBCOMMANDS = set("test", "lint", "build");

const CARGO_BUILD: PrefixPolicy = {
  flags: set(
    "--release",
    "-q",
    "--quiet",
    "--workspace",
    "--lib",
    "--bins",
    "--tests",
    "--all-targets",
    "--no-fail-fast",
    "--offline",
    "--locked",
    "-v",
  ),
  positional: "any",
};
const CARGO: Record<string, PrefixPolicy> = {
  test: CARGO_BUILD,
  build: CARGO_BUILD,
  check: CARGO_BUILD,
  clippy: CARGO_BUILD,
  fmt: { flags: set("--check", "--all", "-q", "--quiet"), positional: "none" },
};

const PYTEST: PrefixPolicy = {
  flags: set(
    "-q",
    "--quiet",
    "-v",
    "-vv",
    "--verbose",
    "-x",
    "--exitfirst",
    "-s",
    "-k",
    "-m",
    "--lf",
    "--ff",
    "--tb",
    "--maxfail",
    "-l",
    "--no-header",
  ),
  positional: "any",
  insideProject: true,
};

/** A script name: no flag, no path, nothing the shell would read. */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * What may follow a prefix, or null when MonoCode keeps no prefix rule for
 * it. An allowlist: a git subcommand that reads the repository, a package
 * manager's test, lint, build or one named script, a cargo build step, or
 * pytest.
 */
function prefixPolicy(words: readonly string[]): PrefixPolicy | null {
  const [tool, sub, third] = words;
  if (words.length === 2 && tool === "git") {
    return Object.prototype.hasOwnProperty.call(GIT, sub) ? GIT[sub] : null;
  }
  if (PACKAGE_MANAGERS.has(tool)) {
    if (words.length === 2 && PACKAGE_SUBCOMMANDS.has(sub))
      return PACKAGE_SCRIPT;
    if (words.length === 3 && sub === "run" && SCRIPT_NAME.test(third)) {
      return PACKAGE_SCRIPT;
    }
    return null;
  }
  if (words.length === 2 && tool === "cargo") {
    return Object.prototype.hasOwnProperty.call(CARGO, sub) ? CARGO[sub] : null;
  }
  if (words.length === 1 && tool === "pytest") return PYTEST;
  if (
    words.length === 3 &&
    /^python(3(\.\d+)?)?$/.test(tool) &&
    sub === "-m" &&
    third === "pytest"
  ) {
    return PYTEST;
  }
  return null;
}

/**
 * Whether a word names something inside the project: pytest reads `@file`
 * as a list of more arguments, and an absolute or `..` path can load a test
 * file, and its `conftest.py`, from anywhere.
 */
function insideProject(word: string): boolean {
  if (word.startsWith("@") || word.startsWith("/") || word.startsWith("\\"))
    return false;
  return !word.split(/[/\\]/).some((part) => part === "..");
}

/** Whether the words after a prefix stay inside what its policy allows. */
function restAllowed(
  tool: string,
  policy: PrefixPolicy,
  rest: readonly string[],
): boolean {
  const refusedShort = Object.prototype.hasOwnProperty.call(REFUSED_SHORT, tool)
    ? REFUSED_SHORT[tool]
    : null;
  let afterSeparator = false;
  const seen = new Set<string>();
  for (const word of rest) {
    if (policy.insideProject && !word.startsWith("-") && !insideProject(word))
      return false;
    if (afterSeparator) {
      // Words after `--` go to the program the tool runs: no flags there.
      if (word.startsWith("-")) return false;
      continue;
    }
    if (word === "--") {
      afterSeparator = true;
      continue;
    }
    if (word.startsWith("-")) {
      const name = word.startsWith("--") ? word.split("=")[0] : word;
      if (REFUSED_FLAGS.has(name) || refusedShort?.test(word)) return false;
      if (policy.countFlag && /^-\d+$/.test(word)) continue;
      if (!policy.flags.has(name)) return false;
      seen.add(name);
      continue;
    }
    if (policy.positional === "none") return false;
    if (
      policy.positional !== "any" &&
      ![...policy.positional.after].some((flag) => seen.has(flag))
    ) {
      return false;
    }
  }
  return true;
}

/** Whether a command is covered by a rule. */
export function commandMatchesRule(
  command: unknown,
  rule: CommandRule,
): boolean {
  if (typeof command !== "string" || CONTROL.test(command)) return false;
  if (rule.kind === "exact") return command.trim() === rule.command;
  if (isCompoundCommand(command)) return false;
  const prefix = rule.prefix.split(" ");
  const policy = prefixPolicy(prefix);
  if (!policy) return false;
  const words = shellWords(command);
  if (!words || words.length < prefix.length) return false;
  if (prefix.some((word, i) => words[i] !== word)) return false;
  return restAllowed(prefix[0], policy, words.slice(prefix.length));
}

/**
 * A rule for a command when Claude Code suggested none. A prefix only where
 * MonoCode keeps one (see `prefixPolicy`) and only when that prefix covers
 * this very command; anything else, and any command that chains, gets an
 * exact rule for that command only.
 */
export function deriveCommandRule(command: unknown): CommandRule | null {
  if (typeof command !== "string") return null;
  const exact = parseCommandRule(
    command.length <= MAX_RULE_LENGTH ? command : "",
  );
  if (!exact || exact.kind !== "exact") return null;
  if (isCompoundCommand(command)) return exact;
  const words = shellWords(command);
  if (!words) return exact;
  for (const length of [3, 2, 1]) {
    if (words.length < length) continue;
    const head = words.slice(0, length);
    if (!prefixPolicy(head)) continue;
    const rule = parseCommandRule(`${head.join(" ")} *`);
    return rule && commandMatchesRule(command, rule) ? rule : exact;
  }
  return exact;
}

/**
 * The Bash rule Claude Code suggested on a `can_use_tool` request, from its
 * `permission_suggestions` (an `addRules` update with an allow rule for Bash).
 * Its `destination` is ignored: MonoCode keeps the rule on the chat.
 */
export function suggestedCommandRule(suggestions: unknown): CommandRule | null {
  // A suggested prefix outside MonoCode's allowlist (`bash *`, `npx *`) is
  // skipped, so the rule falls back to one derived from the command, which
  // is an exact rule unless the command fits the allowlist.
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
  // A suggestion is kept only when it covers this very command: a rule for
  // some other command would allow what the user never saw.
  const suggested = suggestedCommandRule(suggestions);
  if (suggested && commandMatchesRule(command, suggested)) return suggested;
  return deriveCommandRule(command);
}

/** The words a rule covers, read as the shell would. Null when it cannot be read. */
function ruleHead(rule: CommandRule): string[] | null {
  return rule.kind === "prefix"
    ? rule.prefix.split(" ")
    : shellWords(rule.command);
}

/**
 * Whether the commands a rule covers run code from the project, which the
 * agent can change: a package script, a cargo build (`build.rs`, tests,
 * `.cargo/config.toml`) or pytest (tests, `conftest.py`).
 */
export function commandRuleRunsProjectCode(rule: CommandRule): boolean {
  const words = ruleHead(rule);
  if (!words) return false;
  for (const length of [3, 2, 1]) {
    if (words.length < length) continue;
    const head = words.slice(0, length);
    if (!prefixPolicy(head)) continue;
    return head[0] !== "git" && !(head[0] === "cargo" && head[1] === "fmt");
  }
  return false;
}

/** What a tooltip and the Tool access row say about such a rule. */
export const PROJECT_CODE_NOTE =
  "Runs this project's code. Changes the agent makes to it run without asking.";

/**
 * The package script a rule's commands run, as `npm`, `pnpm` or `yarn`
 * would look it up in `package.json`: `npm test` runs `test`, `yarn run
 * build` runs `build`. Null for any other rule.
 */
export function packageScriptOf(rule: CommandRule): string | null {
  const words = ruleHead(rule);
  if (!words || !PACKAGE_MANAGERS.has(words[0])) return null;
  if (words[1] === "run")
    return words[2] && SCRIPT_NAME.test(words[2]) ? words[2] : null;
  return PACKAGE_SUBCOMMANDS.has(words[1]) ? words[1] : null;
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
