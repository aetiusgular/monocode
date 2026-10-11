import type { HarnessId } from "../../sessions/model/session";
import { isPluginId, type ClaudePlugin } from "./pluginCli";

/** Bounds what a saved session can put in a launch setting. */
export const MAX_DISABLED_PLUGINS = 64;

/** Fired on `window` to open Settings on the Plugins page. */
export const OPEN_PLUGINS_SETTINGS_EVENT = "monocode:open-plugins-settings";

/**
 * Per-chat plugin switches work on Claude Code only. Claude Code takes an
 * `enabledPlugins` key in the `--settings` JSON a session starts with, and
 * documents that key at the `flag` level: above user, project and local
 * settings, for that session only, merged one plugin id at a time
 * (https://code.claude.com/docs/en/plugins/loading#find-where-a-plugin-is-enabled).
 */
export function harnessSupportsPluginSwitches(harness: HarnessId): boolean {
  return harness === "claude";
}

/** A stored list read back from disk: valid, unique, bounded plugin ids. */
export function sanitizeDisabledPlugins(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const entry of value) {
    if (ids.length >= MAX_DISABLED_PLUGINS) break;
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (isPluginId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}

/**
 * Switch one plugin on or off for a chat. The list holds the plugins that are
 * off. Returns `disabled` itself when nothing changes.
 */
export function setPluginOnForChat(
  disabled: readonly string[],
  id: string,
  on: boolean,
): string[] {
  const listed = disabled.includes(id);
  if (on) {
    return listed
      ? disabled.filter((entry) => entry !== id)
      : (disabled as string[]);
  }
  if (listed || !isPluginId(id) || disabled.length >= MAX_DISABLED_PLUGINS) {
    return disabled as string[];
  }
  return [...disabled, id];
}

/** The plugins switched off for a chat on this harness, or none. */
export function chatDisabledPlugins(
  harness: HarnessId,
  disabled: readonly string[] | undefined,
): string[] {
  if (!disabled?.length || !harnessSupportsPluginSwitches(harness)) return [];
  return sanitizeDisabledPlugins(disabled) ?? [];
}

/** The ids to hand the harness, sorted, or undefined when there are none. */
export function harnessDisabledPlugins(
  harness: HarnessId,
  disabled: readonly string[] | undefined,
): string[] | undefined {
  const ids = chatDisabledPlugins(harness, disabled);
  return ids.length > 0 ? [...ids].sort() : undefined;
}

/**
 * The `enabledPlugins` value for Claude Code's `--settings`: each plugin
 * switched off for the chat set to `false`. A managed `true` still wins over
 * it, as Claude Code's docs say no other source overrides managed settings.
 */
export function claudePluginOverrides(
  disabled: readonly string[] | undefined,
): Record<string, false> | undefined {
  const ids = sanitizeDisabledPlugins(disabled ? [...disabled] : undefined);
  if (!ids) return undefined;
  return Object.fromEntries([...ids].sort().map((id) => [id, false]));
}

export type ChatPluginRow = {
  id: string;
  name: string;
  marketplace: string;
  /** Scope and MCP servers, in a few words. */
  detail: string;
  /** On for this chat. */
  on: boolean;
  /** Switched off for this chat but not loading here any more. */
  missing?: boolean;
  /**
   * Installed by the organization's managed settings, which Claude Code says
   * no other source overrides, so a chat cannot turn it off.
   */
  locked?: boolean;
};

/**
 * One row per plugin that loads for the chat's folder: the entries of a list
 * run in that folder that are enabled there. A plugin installed at more than
 * one scope gets one row. Ids switched off for the chat that no longer load
 * follow, so they can be switched back on.
 */
export function chatPluginRows(
  plugins: readonly ClaudePlugin[],
  disabled: readonly string[],
): ChatPluginRow[] {
  const off = new Set(disabled);
  const managed = new Set(
    plugins
      .filter((plugin) => plugin.scope === "managed")
      .map((plugin) => plugin.id),
  );
  const rows = new Map<string, ChatPluginRow>();
  for (const plugin of plugins) {
    if (!plugin.enabled || rows.has(plugin.id)) continue;
    if (managed.has(plugin.id)) {
      rows.set(plugin.id, {
        id: plugin.id,
        name: plugin.name,
        marketplace: plugin.marketplace,
        detail: "Set by your organization",
        on: true,
        locked: true,
      });
      continue;
    }
    const scope =
      plugin.scope === "synced"
        ? "claude.ai"
        : plugin.scope === "managed"
          ? "Organization"
          : plugin.marketplace;
    rows.set(plugin.id, {
      id: plugin.id,
      name: plugin.name,
      marketplace: plugin.marketplace,
      detail: [
        scope,
        ...(plugin.mcpServers.length
          ? [`MCP: ${plugin.mcpServers.join(", ")}`]
          : []),
      ].join(" · "),
      on: !off.has(plugin.id),
    });
  }
  const sorted = [...rows.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const missing = disabled
    .filter((id) => !rows.has(id))
    .map((id) => {
      const at = id.lastIndexOf("@");
      return {
        id,
        name: at > 0 ? id.slice(0, at) : id,
        marketplace: at > 0 ? id.slice(at + 1) : "",
        detail: "Not loading here any more",
        on: false,
        missing: true,
      };
    });
  return [...sorted, ...missing];
}
