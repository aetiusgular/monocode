import { normalizePreviewUrl } from "./previewUrl";

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
};

export type PreviewConfigFiles = {
  launchJson?: string | null;
  packageJson?: string | null;
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
]);

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
    if (RESERVED_ENV.has(name.toUpperCase()))
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
  return {
    candidates: [...launch.candidates, ...scripts.candidates],
    problems: [...(files.skipped ?? []), ...launch.problems, ...scripts.problems],
  };
}

/** 53-bit string hash (cyrb53). Not a secret, only a change detector. */
function hash53(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/**
 * Everything that decides what runs. A change to any of it, the script a
 * package manager runs included, means the user confirms again.
 */
export function previewFingerprint(candidate: PreviewCandidate): string {
  const env = Object.keys(candidate.env)
    .sort()
    .map((name) => [name, candidate.env[name]]);
  return hash53(
    JSON.stringify([
      candidate.program,
      candidate.args,
      candidate.cwd,
      env,
      candidate.scriptBody ?? null,
      candidate.port ?? null,
      candidate.url ?? null,
      candidate.autoPort,
    ]),
  );
}
