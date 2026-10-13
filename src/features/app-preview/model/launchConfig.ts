import { normalizePreviewUrl } from "./previewUrl";
import { sha256Hex } from "./sha256";

/**
 * #37: what a preview can start from. Two sources, both files in the project
 * that an agent or a stranger can write (rules, section 5, item 4):
 *
 * - `.claude/launch.json`, in the shape Claude Desktop reads: a list of
 *   configurations with `runtimeExecutable`, `runtimeArgs`, `port`, `cwd`,
 *   `env`, `program`, `args`, `url`, `autoPort` and `autoVerify`.
 * - The dev scripts in `package.json`, run through the project's package
 *   manager.
 *
 * Nothing here starts anything. A candidate is shown to the user as the exact
 * command, and runs only after they confirm it; its fingerprint changes when
 * any part of it does, so a changed command asks again.
 */

export type PreviewSource = "launch.json" | "package.json";

export type PreviewCandidate = {
  /** Stable within one project: `launch:<name>` or `script:<name>`. */
  key: string;
  label: string;
  source: PreviewSource;
  /** Run as given, with no shell. */
  program: string;
  args: string[];
  /** Relative to the project root; "" is the root. */
  cwd: string;
  env: Record<string, string>;
  port?: number;
  /** A loopback URL to open, from launch.json. */
  url?: string;
  /** MonoCode picks a free port and passes it as PORT. */
  autoPort: boolean;
  /** launch.json asks for verify after edits. */
  autoVerify?: boolean;
  /** The script a package manager runs, shown beside the command. */
  scriptBody?: string;
  /** The `pre<name>` and `post<name>` scripts npm runs around it. */
  preScript?: string;
  postScript?: string;
  /**
   * SHA-256 of the project's `.npmrc`, when it has one. npm reads it when it
   * runs a script (`script-shell`, `node-options`), so a change asks again.
   * The content is never shown: it can hold a registry token.
   */
  npmrcHash?: string;
};

export type PreviewConfigFiles = {
  launchJson?: string | null;
  packageJson?: string | null;
  /** SHA-256 of the project's `.npmrc`, from Rust. Its text never comes here. */
  npmrcSha256?: string | null;
  lockfiles?: string[];
  skipped?: string[];
};

export type PreviewCandidates = {
  candidates: PreviewCandidate[];
  /** Entries left out, and why, in words a person can read. */
  problems: string[];
};

/** Names the PTY sets itself, or that load code into every process. */
const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "PWD",
  "TERM",
  "TERM_PROGRAM",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Names that make a runtime or shell load code before the command runs.
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "ZDOTDIR",
  "IFS",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "DOTNET_STARTUP_HOOKS",
  "GCONV_PATH",
]);

/** Prefixes refused for the same reason: every DYLD_ and LD_ name, npm's own
 * settings (`npm_config_script_shell`, `npm_config_node_options`), Yarn's and
 * pnpm's, and git's per-call config. */
const RESERVED_ENV_PREFIXES = [
  "DYLD_",
  "LD_",
  "NPM_CONFIG_",
  "YARN_",
  "PNPM_",
  "BUN_",
  "GIT_CONFIG_",
];

export function reservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    RESERVED_ENV.has(upper) || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

const MAX_CONFIGURATIONS = 20;
const MAX_ARGS = 64;
const MAX_FIELD = 4_096;
const MAX_ENV = 64;
/** package.json scripts that start a dev server, in the order offered. */
export const DEV_SCRIPTS = ["dev", "start", "serve", "preview"] as const;

function text(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.includes("\0") || value.length > max) return undefined;
  return value;
}

function validEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name);
}

/** `${workspaceFolder}` is the project root, as in VS Code's launch files. */
function workspaceRelative(value: string): string {
  return value.replace(/^\$\{workspaceFolder\}\/?/, "");
}

/**
 * A relative folder with no `..`, root or drive. Names are kept literally;
 * Rust resolves links and refuses one that leads out.
 */
export function relativeFolder(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return "";
  const value = text(raw, 1_024);
  if (value === undefined) return undefined;
  const path = workspaceRelative(value.trim());
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path))
    return undefined;
  if (path.includes("\\")) return undefined;
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return undefined;
  return parts.join("/");
}

function port(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 65_535 ? value : null;
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const entry = text(item);
    if (entry === undefined) return undefined;
    out.push(entry);
  }
  return out;
}

function envMap(value: unknown): Record<string, string> | string {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    return "env is not a list of names and values";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENV) return "env has too many entries";
  const out: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!validEnvName(name)) return `env name ${JSON.stringify(name)} is not valid`;
    if (reservedEnvName(name))
      return `env may not set ${name}`;
    const entry = typeof raw === "number" || typeof raw === "boolean" ? String(raw) : text(raw);
    if (entry === undefined) return `env value for ${name} is not text`;
    out[name] = entry;
  }
  return out;
}

/** One launch.json configuration as a candidate, or the reason it is not. */
function launchCandidate(
  raw: unknown,
  index: number,
): PreviewCandidate | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return `Configuration ${index + 1} is not an object`;
  const value = raw as Record<string, unknown>;
  const name = text(value.name, 120)?.trim() || `Configuration ${index + 1}`;
  const runtime = text(value.runtimeExecutable, 512)?.trim();
  const program = text(value.program, 1_024)?.trim();
  const runtimeArgs = stringList(value.runtimeArgs);
  const args = stringList(value.args);
  if (!runtimeArgs || !args) return `${name}: arguments must be a list of text`;
  let executable: string;
  let argv: string[];
  if (runtime) {
    executable = runtime;
    argv = [...runtimeArgs, ...(program ? [workspaceRelative(program)] : []), ...args];
  } else if (program) {
    // A program with no runtime is a Node script, as in Claude Desktop.
    executable = "node";
    argv = [...runtimeArgs, workspaceRelative(program), ...args];
  } else {
    return `${name}: no runtimeExecutable or program`;
  }
  if (!executable || executable.startsWith("-"))
    return `${name}: the command is not valid`;
  if (argv.length > MAX_ARGS) return `${name}: too many arguments`;
  const cwd = relativeFolder(value.cwd);
  if (cwd === undefined) return `${name}: cwd must be a folder inside the project`;
  const env = envMap(value.env);
  if (typeof env === "string") return `${name}: ${env}`;
  const fixedPort = port(value.port);
  if (fixedPort === null) return `${name}: port must be a whole number from 1 to 65535`;
  let url: string | undefined;
  if (value.url !== undefined && value.url !== null) {
    const rawUrl = text(value.url, 2_048);
    url = rawUrl ? normalizePreviewUrl(rawUrl) : undefined;
    if (!url) return `${name}: url must be on localhost`;
  }
  const autoPort = value.autoPort === true;
  return {
    key: `launch:${name}`,
    label: name,
    source: "launch.json",
    program: executable,
    args: argv,
    cwd,
    env,
    ...(fixedPort !== undefined ? { port: fixedPort } : {}),
    ...(url ? { url } : {}),
    autoPort,
    ...(typeof value.autoVerify === "boolean"
      ? { autoVerify: value.autoVerify }
      : {}),
  };
}

export function parseLaunchJson(textValue: string): PreviewCandidates {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    return { candidates: [], problems: [".claude/launch.json is not valid JSON"] };
  }
  const list =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { configurations?: unknown }).configurations
      : undefined;
  if (!Array.isArray(list))
    return {
      candidates: [],
      problems: [".claude/launch.json has no configurations list"],
    };
  const candidates: PreviewCandidate[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  list.slice(0, MAX_CONFIGURATIONS).forEach((entry, index) => {
    const result = launchCandidate(entry, index);
    if (typeof result === "string") problems.push(result);
    else if (seen.has(result.key)) problems.push(`${result.label}: the name is used twice`);
    else {
      seen.add(result.key);
      candidates.push(result);
    }
  });
  if (list.length > MAX_CONFIGURATIONS)
    problems.push(`Only the first ${MAX_CONFIGURATIONS} configurations are read`);
  return { candidates, problems };
}

/** The package manager the project uses, from its lockfile. */
export function packageManager(lockfiles: readonly string[] = []): string {
  if (lockfiles.includes("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.includes("yarn.lock")) return "yarn";
  if (lockfiles.includes("bun.lockb") || lockfiles.includes("bun.lock"))
    return "bun";
  return "npm";
}

/** A port a script names with `--port N`, `--port=N` or `-p N`. */
export function scriptPort(body: string): number | undefined {
  const match = /(?:--port[= ]|(?:^|\s)-p\s+)(\d{2,5})\b/.exec(body);
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : undefined;
}

/**
 * Mac test 6.18: ports a command names, for a server that prints no address.
 * Only `--port N`, `--port=N`, `-p N` and `PORT=N`, in the script a package
 * manager runs and in the arguments. Patterns such as `listen(N)` are not
 * read: they are too easy to misread.
 */
export function namedPorts(candidate: PreviewCandidate): number[] {
  const text = [candidate.scriptBody ?? "", ...candidate.args].join(" ");
  const found: number[] = [];
  const pattern =
    /(?:--port[= ]|(?:^|\s)-p\s+|(?:^|[\s;&|(])PORT=)['"]?(\d{2,5})\b/g;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 65_535 &&
      !found.includes(value)
    )
      found.push(value);
  }
  return found.slice(0, 4);
}

export function packageScriptCandidates(
  textValue: string,
  lockfiles: readonly string[] = [],
): PreviewCandidates {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    return { candidates: [], problems: ["package.json is not valid JSON"] };
  }
  const scripts =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
    return { candidates: [], problems: [] };
  const manager = packageManager(lockfiles);
  const candidates: PreviewCandidate[] = [];
  for (const name of DEV_SCRIPTS) {
    const body = text((scripts as Record<string, unknown>)[name]);
    if (!body || !body.trim()) continue;
    const fixedPort = scriptPort(body);
    const pre = text((scripts as Record<string, unknown>)[`pre${name}`]);
    const post = text((scripts as Record<string, unknown>)[`post${name}`]);
    candidates.push({
      key: `script:${name}`,
      label: `${manager} run ${name}`,
      source: "package.json",
      program: manager,
      args: ["run", name],
      cwd: "",
      env: {},
      ...(fixedPort ? { port: fixedPort } : {}),
      autoPort: false,
      scriptBody: body,
      ...(pre !== undefined ? { preScript: pre } : {}),
      ...(post !== undefined ? { postScript: post } : {}),
    });
  }
  return { candidates, problems: [] };
}

/** launch.json first, as Claude Desktop does, then the package scripts. */
export function previewCandidates(files: PreviewConfigFiles): PreviewCandidates {
  const launch = files.launchJson
    ? parseLaunchJson(files.launchJson)
    : { candidates: [], problems: [] };
  const scripts = files.packageJson
    ? packageScriptCandidates(files.packageJson, files.lockfiles)
    : { candidates: [], problems: [] };
  // An .npmrc that is there but could not be read (a link out of the project,
  // too large, not text) cannot be fingerprinted, and npm would still read
  // it. Nothing is offered until it is fixed.
  const npmrcSkipped =
    (files.skipped ?? []).some((reason) => reason.startsWith(".npmrc")) ||
    (typeof files.npmrcSha256 === "string" && !/^[0-9a-f]{64}$/.test(files.npmrcSha256));
  if (npmrcSkipped)
    return {
      candidates: [],
      problems: [
        ...(files.skipped ?? []),
        "Every command: this project's .npmrc could not be read, so a change to it could not be noticed",
        ...launch.problems,
        ...scripts.problems,
      ],
    };
  const npmrcHash = typeof files.npmrcSha256 === "string" ? files.npmrcSha256 : undefined;
  const all = [...launch.candidates, ...scripts.candidates].map((candidate) =>
    npmrcHash ? { ...candidate, npmrcHash } : candidate,
  );
  return {
    candidates: all,
    problems: [...(files.skipped ?? []), ...launch.problems, ...scripts.problems],
  };
}

/**
 * Everything that decides what runs. A change to any of it, the script a
 * package manager runs included, with its pre and post scripts and the
 * project's `.npmrc`, means the user confirms again. SHA-256, so a file
 * written to collide with a confirmed command cannot pass for it.
 */
export function previewFingerprint(candidate: PreviewCandidate): string {
  const env = Object.keys(candidate.env)
    .sort()
    .map((name) => [name, candidate.env[name]]);
  return sha256Hex(
    JSON.stringify([
      candidate.program,
      candidate.args,
      candidate.cwd,
      env,
      candidate.scriptBody ?? null,
      candidate.port ?? null,
      candidate.url ?? null,
      candidate.autoPort,
      candidate.preScript ?? null,
      candidate.postScript ?? null,
      candidate.npmrcHash ?? null,
    ]),
  );
}
