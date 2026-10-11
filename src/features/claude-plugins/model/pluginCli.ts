/**
 * The `claude plugin` calls MonoCode makes, and what it reads from them.
 *
 * Shapes follow Claude Code's plugin commands reference
 * (https://code.claude.com/docs/en/plugins/cli-reference): `list --json`
 * prints an array with one object per installation, and `enable` and
 * `disable` with `--json` print one result object on the last line of stdout.
 */

/** `name@marketplace`. The same rule the app's Rust command applies. */
const PLUGIN_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9._-]+$/;
const MAX_ID_CHARS = 200;

export function isPluginId(value: string): boolean {
  return value.length <= MAX_ID_CHARS && PLUGIN_ID.test(value);
}

/** Where an installation is declared, as `claude plugin list` names it. */
export type PluginScope =
  "user" | "project" | "local" | "managed" | "synced" | "session";

const SCOPES: readonly PluginScope[] = [
  "user",
  "project",
  "local",
  "managed",
  "synced",
  "session",
];

/** One installation from `claude plugin list --json`. */
export type ClaudePlugin = {
  id: string;
  /** The part of the id before `@`. */
  name: string;
  /** The part after `@`: a marketplace, or `synced`, `inline`, `skills-dir`. */
  marketplace: string;
  version: string;
  scope: PluginScope;
  /** On in the merged settings of the folder the list ran in. */
  enabled: boolean;
  installPath: string;
  /** The project a `project` or `local` installation belongs to. */
  projectPath?: string;
  /** Names of the MCP servers the plugin declares, when the CLI reports them. */
  mcpServers: string[];
  /** Load errors the CLI reported. */
  errors: string[];
};

const LIST_ARGS = ["plugin", "list", "--json"] as const;

export function pluginListArgs(): string[] {
  return [...LIST_ARGS];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEntry(value: unknown): ClaudePlugin | null {
  const rec = recordOf(value);
  const id = stringOf(rec?.id);
  if (!rec || !id) return null;
  const at = id.lastIndexOf("@");
  const scope = SCOPES.find((entry) => entry === rec.scope);
  if (!scope) return null;
  const errors = Array.isArray(rec.errors)
    ? rec.errors.filter((entry): entry is string => typeof entry === "string")
    : [];
  const projectPath = stringOf(rec.projectPath);
  return {
    id,
    name: at > 0 ? id.slice(0, at) : id,
    marketplace: at > 0 ? id.slice(at + 1) : "",
    version: stringOf(rec.version) ?? "unknown",
    scope,
    enabled: rec.enabled === true,
    installPath: stringOf(rec.installPath) ?? "",
    ...(projectPath ? { projectPath } : {}),
    mcpServers: Object.keys(recordOf(rec.mcpServers) ?? {}).sort(),
    errors,
  };
}

/**
 * The installations in `claude plugin list --json` output. Also takes the
 * `--available` form, whose `installed` field holds the same array. Entries
 * without an id or with a scope MonoCode does not know are left out.
 */
export function parsePluginList(stdout: string): ClaudePlugin[] {
  const text = stdout.trim();
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Anything printed ahead of the JSON (an update notice, say).
    const start = text.search(/^[[{]/m);
    if (start <= 0)
      throw new Error("Claude Code printed a list MonoCode cannot read");
    value = JSON.parse(text.slice(start));
  }
  const list = Array.isArray(value) ? value : recordOf(value)?.installed;
  if (!Array.isArray(list)) {
    throw new Error("Claude Code printed a list MonoCode cannot read");
  }
  return list.flatMap((entry) => {
    const plugin = parseEntry(entry);
    return plugin ? [plugin] : [];
  });
}

/** Whether MonoCode can switch an installation, and if not, why. */
export type PluginControl =
  { kind: "switch" } | { kind: "read-only"; reason: string };

export function pluginControl(plugin: ClaudePlugin): PluginControl {
  if (!isPluginId(plugin.id)) {
    return {
      kind: "read-only",
      reason: "This plugin id cannot be passed to Claude Code from here.",
    };
  }
  switch (plugin.scope) {
    case "user":
    case "synced":
      return { kind: "switch" };
    case "project":
    case "local":
      return plugin.projectPath
        ? { kind: "switch" }
        : {
            kind: "read-only",
            reason: "Claude Code did not say which project this belongs to.",
          };
    case "managed":
      return {
        kind: "read-only",
        reason: "Set by your organization's managed settings.",
      };
    case "session":
      return { kind: "read-only", reason: "Loaded for one session only." };
  }
}

/**
 * The call that turns an installation on or off, at its own scope, and the
 * folder it runs in. A synced plugin has no install scope: Claude Code's docs
 * give `claude plugin disable <name>@synced` without `--scope`, which saves
 * the choice in the user settings. Null when MonoCode cannot switch it.
 */
export function pluginToggleCall(
  plugin: ClaudePlugin,
  on: boolean,
): { args: string[]; cwd?: string } | null {
  if (pluginControl(plugin).kind !== "switch") return null;
  const verb = on ? "enable" : "disable";
  if (plugin.scope === "synced") {
    return { args: ["plugin", verb, "--json", plugin.id] };
  }
  const args = ["plugin", verb, "--scope", plugin.scope, "--json", plugin.id];
  return plugin.scope === "user" ? { args } : { args, cwd: plugin.projectPath };
}

/** What an enable or disable came back with. */
export type ToggleResult = { ok: true } | { ok: false; message: string };

/**
 * Reads the `--json` result line. A plugin that is already in the state asked
 * for counts as done, as the docs suggest for scripts.
 */
export function parseToggleResult(output: {
  stdout: string;
  stderr: string;
  success: boolean;
}): ToggleResult {
  const line = output.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .pop();
  let result: Record<string, unknown> | null = null;
  try {
    result = line ? recordOf(JSON.parse(line)) : null;
  } catch {
    result = null;
  }
  if (result) {
    if (
      result.outcome === "ok" ||
      result.alreadyInGoalState === true ||
      result.failureCode === "already_in_goal_state"
    ) {
      return { ok: true };
    }
    const message = stringOf(result.message);
    if (message) return { ok: false, message };
  }
  if (output.success) return { ok: true };
  // A usage error prints no result line, only the reason on stderr.
  return {
    ok: false,
    message:
      output.stderr.trim() ||
      output.stdout.trim() ||
      "Claude Code could not change this plugin.",
  };
}

/** A stable key for one installation. */
export function pluginRowKey(plugin: ClaudePlugin): string {
  return `${plugin.id}|${plugin.scope}|${plugin.projectPath ?? ""}`;
}

/** Short label for an installation's scope. */
export function scopeLabel(scope: PluginScope): string {
  switch (scope) {
    case "user":
      return "User";
    case "project":
      return "Project";
    case "local":
      return "Local";
    case "managed":
      return "Organization";
    case "synced":
      return "claude.ai";
    case "session":
      return "Session";
  }
}

/** The last part of a path, for a project's name. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
