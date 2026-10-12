/**
 * Installing, updating and removing Claude Code plugins, and managing the
 * marketplaces they come from. Each call here has a matching shape in the
 * app's Rust allowlist (`src-tauri/src/claude_plugin.rs`); anything else is
 * refused there.
 *
 * Shapes were read from `claude plugin <verb> --help` and run against a local
 * test marketplace with Claude Code 2.1.292 on 12 Oct 2026:
 * - every change prints one JSON result as the last line of stdout, with
 *   `outcome` ("ok" or "failed"), `message` and, on failure, `failureCode`;
 * - a plugin installed by running a command the marketplace declares is
 *   refused with `failureCode: "command_source_refused"` and a `shownCommand`
 *   that carries the command and its `sha256`. Passing that hash back with
 *   `--accept-command` runs exactly that command and nothing else;
 * - removing a marketplace also uninstalls every plugin installed from it and
 *   deletes their saved options and data.
 *
 * MonoCode never passes `-y`/`--yes`.
 */

import { isPluginId, pluginControl, type ClaudePlugin } from "./pluginCli";

/** Scopes an install, update or uninstall can name. */
export type InstallScope = "user" | "project" | "local";

export const INSTALL_SCOPES: readonly InstallScope[] = [
  "user",
  "project",
  "local",
];

const HASH = /^[0-9a-f]{64}$/;
const MARKETPLACE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const MAX_MARKETPLACE_CHARS = 100;
const MAX_SOURCE_CHARS = 2048;
const REPO_PART = /^[A-Za-z0-9._-]+$/;

/** One call for `runClaudePlugin`, with the folder it must run in. */
export type PluginCall = { args: string[]; cwd?: string };

export function isMarketplaceName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_MARKETPLACE_CHARS &&
    MARKETPLACE_NAME.test(value)
  );
}

function isAcceptHash(value: string): boolean {
  return HASH.test(value);
}

/** What kind of place a marketplace source names, or why it is refused. */
export type SourceCheck =
  { ok: true; kind: "github" | "url" | "path" } | { ok: false; reason: string };

/**
 * The same three forms the Rust command accepts: a GitHub `owner/repo`, an
 * `https://` URL with a host and no user part, or an absolute path. Git over
 * ssh, `http://`, relative paths and anything starting with a dash are
 * refused. A path must also exist, which only the app can check.
 */
export function checkMarketplaceSource(input: string): SourceCheck {
  const value = input.trim();
  if (!value) return { ok: false, reason: "Enter a source." };
  if (value.length > MAX_SOURCE_CHARS) {
    return { ok: false, reason: "That source is too long." };
  }
  if (value.startsWith("-")) {
    return { ok: false, reason: "A source cannot start with a dash." };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return {
      ok: false,
      reason: "A source cannot contain spaces or control characters.",
    };
  }
  if (value.startsWith("/")) {
    return value.split("/").includes("..")
      ? { ok: false, reason: "A path cannot contain `..`." }
      : { ok: true, kind: "path" };
  }
  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, reason: "That URL cannot be read." };
    }
    if (url.protocol !== "https:") {
      return { ok: false, reason: "Only https:// URLs are accepted." };
    }
    if (!url.hostname) return { ok: false, reason: "The URL has no host." };
    if (url.username || url.password) {
      return {
        ok: false,
        reason: "A URL with a user name or password is refused.",
      };
    }
    return { ok: true, kind: "url" };
  }
  const parts = value.split("/");
  if (
    parts.length === 2 &&
    parts.every((part) => REPO_PART.test(part) && part !== "." && part !== "..")
  ) {
    return { ok: true, kind: "github" };
  }
  return {
    ok: false,
    reason:
      "Use a GitHub owner/repo, an https:// URL, or an absolute path to a folder.",
  };
}

/** `claude plugin install` at a scope. A project scope runs in `cwd`. */
export function pluginInstallCall(
  id: string,
  scope: InstallScope,
  cwd: string | undefined,
  acceptHash?: string,
): PluginCall | null {
  return changeCall("install", id, scope, cwd, acceptHash);
}

/** `claude plugin update` for an installation, at its own scope. */
export function pluginUpdateCall(
  plugin: ClaudePlugin,
  acceptHash?: string,
): PluginCall | null {
  if (!canManage(plugin)) return null;
  return changeCall(
    "update",
    plugin.id,
    plugin.scope as InstallScope,
    plugin.projectPath,
    acceptHash,
  );
}

/**
 * `claude plugin uninstall` for an installation, at its own scope. Its data
 * folder is kept unless `deleteData` is set.
 */
export function pluginUninstallCall(
  plugin: ClaudePlugin,
  deleteData: boolean,
): PluginCall | null {
  if (!canManage(plugin)) return null;
  const scope = plugin.scope as InstallScope;
  const args = [
    "plugin",
    "uninstall",
    "--scope",
    scope,
    "--json",
    ...(deleteData ? [] : ["--keep-data"]),
    plugin.id,
  ];
  return scope === "user" ? { args } : { args, cwd: plugin.projectPath };
}

function changeCall(
  verb: "install" | "update",
  id: string,
  scope: InstallScope,
  cwd: string | undefined,
  acceptHash: string | undefined,
): PluginCall | null {
  if (!isPluginId(id) || id.endsWith("@synced")) return null;
  if (!INSTALL_SCOPES.includes(scope)) return null;
  if (acceptHash !== undefined && !isAcceptHash(acceptHash)) return null;
  if (scope !== "user" && !cwd) return null;
  const args = [
    "plugin",
    verb,
    "--scope",
    scope,
    "--json",
    ...(acceptHash ? ["--accept-command", acceptHash] : []),
    id,
  ];
  return scope === "user" ? { args } : { args, cwd };
}

/**
 * Whether an installation can be updated or uninstalled from here: a user,
 * project or local installation MonoCode can switch. Synced, organization
 * and session plugins cannot.
 */
export function canManage(plugin: ClaudePlugin): boolean {
  return (
    pluginControl(plugin).kind === "switch" &&
    (plugin.scope === "user" ||
      plugin.scope === "project" ||
      plugin.scope === "local")
  );
}

export function marketplaceListArgs(): string[] {
  return ["plugin", "marketplace", "list", "--json"];
}

/** Marketplaces are added to the user settings only. */
export function marketplaceAddArgs(source: string): string[] | null {
  const value = source.trim();
  return checkMarketplaceSource(value).ok
    ? ["plugin", "marketplace", "add", "--scope", "user", "--json", value]
    : null;
}

export function marketplaceUpdateArgs(name: string): string[] | null {
  return isMarketplaceName(name)
    ? ["plugin", "marketplace", "update", "--json", name]
    : null;
}

/** Removes the marketplace from every scope, and the plugins from it. */
export function marketplaceRemoveArgs(name: string): string[] | null {
  return isMarketplaceName(name)
    ? ["plugin", "marketplace", "remove", "--json", name]
    : null;
}

/** A command Claude Code showed and will run only once it is accepted. */
export type ShownCommand = {
  kind: string;
  pluginId: string;
  command: string;
  mode?: string;
  archiveUrl?: string;
  sha256: string;
};

/** What a change came back with. */
export type ManageResult =
  | { ok: true; message: string }
  | {
      ok: false;
      message: string;
      failureCode?: string;
      /** Set when the change waits for a command to be accepted. */
      shownCommand?: ShownCommand;
    };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseShownCommand(value: unknown): ShownCommand | undefined {
  const rec = recordOf(value);
  const command = stringOf(rec?.command);
  const sha256 = stringOf(rec?.sha256);
  const pluginId = stringOf(rec?.pluginId);
  if (!rec || !command || !sha256 || !isAcceptHash(sha256) || !pluginId) {
    return undefined;
  }
  const mode = stringOf(rec.mode);
  const archiveUrl = stringOf(rec.archiveUrl);
  return {
    kind: stringOf(rec.kind) ?? "command",
    pluginId,
    command,
    sha256,
    ...(mode ? { mode } : {}),
    ...(archiveUrl ? { archiveUrl } : {}),
  };
}

/**
 * Reads the last JSON line of a change's stdout. Human text Claude Code
 * prints ahead of it (the command it shows, for one) is skipped.
 */
export function parseManageResult(output: {
  stdout: string;
  stderr: string;
  success: boolean;
}): ManageResult {
  const lines = output.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let result: Record<string, unknown> | null = null;
  for (let i = lines.length - 1; i >= 0 && !result; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    try {
      result = recordOf(JSON.parse(line));
    } catch {
      result = null;
    }
  }
  if (result) {
    const message = stringOf(result.message) ?? "";
    if (result.outcome === "ok") return { ok: true, message };
    const shownCommand = parseShownCommand(result.shownCommand);
    const failureCode = stringOf(result.failureCode);
    return {
      ok: false,
      message: message || "Claude Code refused the change.",
      ...(failureCode ? { failureCode } : {}),
      ...(shownCommand ? { shownCommand } : {}),
    };
  }
  if (output.success) return { ok: true, message: "" };
  return {
    ok: false,
    message:
      output.stderr.trim() ||
      output.stdout.trim() ||
      "Claude Code could not make the change.",
  };
}

/** One configured marketplace. */
export type Marketplace = {
  name: string;
  /** `github`, `git`, `url`, `directory`, `file` and so on. */
  source: string;
  /** Where it comes from, for display: repo, URL or path. */
  origin: string;
};

/** `claude plugin marketplace list --json`: an array of objects. */
export function parseMarketplaceList(stdout: string): Marketplace[] {
  const text = stdout.trim();
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.search(/^\[/m);
    if (start < 0) {
      throw new Error("Claude Code printed a list MonoCode cannot read");
    }
    value = JSON.parse(text.slice(start));
  }
  if (!Array.isArray(value)) {
    throw new Error("Claude Code printed a list MonoCode cannot read");
  }
  return value.flatMap((entry) => {
    const rec = recordOf(entry);
    const name = stringOf(rec?.name);
    if (!rec || !name) return [];
    const origin =
      stringOf(rec.repo) ??
      stringOf(rec.url) ??
      stringOf(rec.path) ??
      stringOf(rec.installLocation) ??
      "";
    return [{ name, source: stringOf(rec.source) ?? "unknown", origin }];
  });
}

/** A plugin a configured marketplace offers. */
export type AvailablePlugin = {
  id: string;
  name: string;
  marketplace: string;
  description: string;
};

/** The `available` half of `claude plugin list --json --available`. */
export function parseAvailablePlugins(stdout: string): AvailablePlugin[] {
  const text = stdout.trim();
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.search(/^\{/m);
    if (start < 0) return [];
    try {
      value = JSON.parse(text.slice(start));
    } catch {
      return [];
    }
  }
  const list = recordOf(value)?.available;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.flatMap((entry) => {
    const rec = recordOf(entry);
    const id = stringOf(rec?.pluginId);
    if (!rec || !id || !isPluginId(id) || seen.has(id)) return [];
    seen.add(id);
    const at = id.lastIndexOf("@");
    return [
      {
        id,
        name: stringOf(rec.name) ?? id.slice(0, at),
        marketplace: stringOf(rec.marketplaceName) ?? id.slice(at + 1),
        description: stringOf(rec.description) ?? "",
      },
    ];
  });
}
