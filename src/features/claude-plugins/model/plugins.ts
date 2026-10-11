import { useEffect, useSyncExternalStore } from "react";
import { listDir } from "../../../platform/tauri/fs";
import {
  parsePluginList,
  parseToggleResult,
  pluginListArgs,
  pluginRowKey,
  pluginToggleCall,
  type ClaudePlugin,
} from "./pluginCli";
import { runClaudePlugin } from "./runClaudePlugin";

/** Projects asked again for their own plugins' state, at most. */
const MAX_PROJECT_LISTS = 8;

/** The Plugins page's view of one Claude Code account. */
export type PluginsState = {
  loading: boolean;
  plugins: ClaudePlugin[] | null;
  /** Why the list could not be read. */
  error: string | null;
  /** Rows with an enable or disable running, by `pluginRowKey`. */
  pending: string[];
  /** The CLI's answer for a row whose last change failed. */
  rowErrors: Record<string, string>;
};

const EMPTY: PluginsState = {
  loading: false,
  plugins: null,
  error: null,
  pending: [],
  rowErrors: {},
};

const states = new Map<string, PluginsState>();
const listeners = new Set<() => void>();

function accountKey(accountId: string | undefined): string {
  return accountId ?? "default";
}

/** The Plugins page's state for an account, as it is now. */
export function readPluginsState(accountId: string | undefined): PluginsState {
  return states.get(accountKey(accountId)) ?? EMPTY;
}

const read = readPluginsState;

function write(
  accountId: string | undefined,
  patch: (state: PluginsState) => PluginsState,
): void {
  states.set(accountKey(accountId), patch(read(accountId)));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every installed plugin for one account, each with its state where it
 * applies. The list runs in the home folder, so user and synced rows show the
 * user settings. A `project` or `local` installation is on or off per
 * project, so each project is asked again from its own folder.
 */
export async function listInstalledPlugins(
  accountId: string | undefined,
): Promise<ClaudePlugin[]> {
  const main = parsePluginList(
    (await runClaudePlugin(pluginListArgs(), { accountId })).stdout,
  );
  const projects = [
    ...new Set(
      main.flatMap((plugin) =>
        (plugin.scope === "project" || plugin.scope === "local") &&
        plugin.projectPath
          ? [plugin.projectPath]
          : [],
      ),
    ),
  ].slice(0, MAX_PROJECT_LISTS);
  const inProject = new Map<string, boolean>();
  await Promise.all(
    projects.map(async (cwd) => {
      try {
        const listed = parsePluginList(
          (await runClaudePlugin(pluginListArgs(), { cwd, accountId })).stdout,
        );
        for (const plugin of listed) {
          if (plugin.projectPath === cwd) {
            inProject.set(pluginRowKey(plugin), plugin.enabled);
          }
        }
      } catch {
        // A project folder that is gone keeps the state the first list gave.
      }
    }),
  );
  return main.map((plugin) => {
    const enabled = inProject.get(pluginRowKey(plugin));
    return enabled === undefined ? plugin : { ...plugin, enabled };
  });
}

/** Ask Claude Code for the account's plugins again. */
export async function refreshPlugins(accountId?: string): Promise<void> {
  write(accountId, (state) => ({ ...state, loading: true, error: null }));
  try {
    const plugins = await listInstalledPlugins(accountId);
    write(accountId, (state) => ({
      ...state,
      loading: false,
      plugins,
      error: null,
    }));
  } catch (err) {
    write(accountId, (state) => ({
      ...state,
      loading: false,
      error: message(err),
    }));
  }
}

/**
 * Turn one installation on or off at its own scope, then read the list again.
 * A refusal from the CLI stays on the row.
 */
export async function setPluginEnabled(
  plugin: ClaudePlugin,
  on: boolean,
  accountId?: string,
): Promise<void> {
  const call = pluginToggleCall(plugin, on);
  if (!call) return;
  const key = pluginRowKey(plugin);
  write(accountId, (state) => {
    const rowErrors = { ...state.rowErrors };
    delete rowErrors[key];
    return {
      ...state,
      pending: [...state.pending.filter((entry) => entry !== key), key],
      rowErrors,
      // Shown in its new place while the CLI runs.
      plugins:
        state.plugins?.map((entry) =>
          pluginRowKey(entry) === key ? { ...entry, enabled: on } : entry,
        ) ?? null,
    };
  });
  let failure: string | null = null;
  try {
    const result = parseToggleResult(
      await runClaudePlugin(call.args, { cwd: call.cwd, accountId }),
    );
    if (!result.ok) failure = result.message;
  } catch (err) {
    failure = message(err);
  }
  write(accountId, (state) => ({
    ...state,
    pending: state.pending.filter((entry) => entry !== key),
    rowErrors: failure
      ? { ...state.rowErrors, [key]: failure }
      : state.rowErrors,
    plugins:
      failure && state.plugins
        ? state.plugins.map((entry) =>
            pluginRowKey(entry) === key ? { ...entry, enabled: !on } : entry,
          )
        : state.plugins,
  }));
  await refreshPlugins(accountId);
}

/** The account's plugins, read the first time a page shows them. */
export function useClaudePlugins(accountId?: string): PluginsState {
  const state = useSyncExternalStore(
    subscribe,
    () => read(accountId),
    () => read(accountId),
  );
  useEffect(() => {
    const current = read(accountId);
    if (!current.plugins && !current.loading && !current.error) {
      void refreshPlugins(accountId);
    }
  }, [accountId]);
  return state;
}

/**
 * What a plugin brings beyond its MCP servers, from the default folders in
 * its install path: `skills/` (one folder each), `commands/` and `agents/`
 * (one Markdown file each) and `hooks/`. A plugin whose manifest points its
 * components elsewhere is not counted, so this is a hint, not an inventory.
 */
export type PluginContents = {
  skills: number;
  commands: number;
  agents: number;
  hooks: boolean;
};

const contents = new Map<string, Promise<PluginContents | null>>();

async function countIn(
  path: string,
  match: (entry: { name: string; isDir: boolean }) => boolean,
): Promise<number> {
  try {
    return (await listDir(path)).filter(match).length;
  } catch {
    return 0;
  }
}

export function readPluginContents(
  installPath: string,
): Promise<PluginContents | null> {
  const cached = contents.get(installPath);
  if (cached) return cached;
  const load = (async () => {
    if (!installPath) return null;
    let top: { name: string; isDir: boolean }[];
    try {
      top = await listDir(installPath);
    } catch {
      return null;
    }
    const has = (name: string) =>
      top.some((entry) => entry.isDir && entry.name === name);
    const markdown = (entry: { name: string; isDir: boolean }) =>
      !entry.isDir && entry.name.toLowerCase().endsWith(".md");
    const sep = installPath.includes("\\") ? "\\" : "/";
    const join = (name: string) => `${installPath}${sep}${name}`;
    const [skills, commands, agents] = await Promise.all([
      has("skills") ? countIn(join("skills"), (entry) => entry.isDir) : 0,
      has("commands") ? countIn(join("commands"), markdown) : 0,
      has("agents") ? countIn(join("agents"), markdown) : 0,
    ]);
    return { skills, commands, agents, hooks: has("hooks") };
  })();
  contents.set(installPath, load);
  return load;
}

/** "2 skills · 1 command · hooks", or empty when nothing was found. */
export function contentsSummary(
  plugin: ClaudePlugin,
  found: PluginContents | null,
): string {
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (plugin.mcpServers.length > 0) {
    parts.push(`MCP: ${plugin.mcpServers.join(", ")}`);
  }
  if (found?.skills) parts.push(plural(found.skills, "skill"));
  if (found?.commands) parts.push(plural(found.commands, "command"));
  if (found?.agents) parts.push(plural(found.agents, "agent"));
  if (found?.hooks) parts.push("hooks");
  return parts.join(" · ");
}

/** For tests. */
export function __resetPlugins(): void {
  states.clear();
  contents.clear();
  for (const listener of listeners) listener();
}
