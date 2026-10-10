import type { HarnessMcpServer } from "../../../integrations/harness/core/types";
import type { McpConnection } from "../../settings/model/mcp";
import {
  HARNESS_TITLE,
  harnessSupportsConnectorSwitches,
  type HarnessId,
} from "../../sessions/model/session";

/** Bounds what a saved session can put on a harness command line. */
export const MAX_DISABLED_MCP_SERVERS = 64;
const MAX_SERVER_NAME_LENGTH = 200;

/** A stored list read back from disk: non-empty, unique, bounded names. */
export function sanitizeDisabledMcpServers(
  value: unknown,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const entry of value) {
    if (names.length >= MAX_DISABLED_MCP_SERVERS) break;
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name || name.length > MAX_SERVER_NAME_LENGTH) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

/**
 * Switch one server on or off for a chat. The list holds the servers that are
 * off; everything else stays on. Returns `disabled` itself when nothing
 * changes.
 */
export function setMcpServerEnabled(
  disabled: readonly string[],
  name: string,
  enabled: boolean,
): string[] {
  const listed = disabled.includes(name);
  if (enabled) {
    return listed
      ? disabled.filter((entry) => entry !== name)
      : (disabled as string[]);
  }
  if (listed || !name.trim() || disabled.length >= MAX_DISABLED_MCP_SERVERS) {
    return disabled as string[];
  }
  return [...disabled, name];
}

export type ConnectorRow = {
  name: string;
  /** Scope and transport, as the `/mcp` picker words them. */
  detail: string;
  /** On for this chat. */
  enabled: boolean;
  /** Off in the harness's own configuration; a chat cannot turn it on. */
  configDisabled?: boolean;
  /**
   * Switched off for this chat but not among the harness's configured
   * servers: it was removed, or was switched off under another provider.
   */
  missing?: boolean;
};

/**
 * One row per server configured for the session's harness. A name defined in
 * several scopes is one server to the harness, so it gets one row and one
 * switch. Names that are switched off but no longer configured follow, so they
 * can still be switched back on.
 */
export function connectorRows(
  connections: readonly McpConnection[],
  harness: HarnessId,
  disabled: readonly string[],
): ConnectorRow[] {
  const off = new Set(disabled);
  const byName = new Map<string, McpConnection[]>();
  for (const server of connections) {
    if (server.provider !== harness) continue;
    const entries = byName.get(server.name) ?? [];
    entries.push(server);
    byName.set(server.name, entries);
  }
  const rows: ConnectorRow[] = [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entries]) => {
      const scopes = [...new Set(entries.map((entry) => entry.scope))];
      const transport =
        entries.find((entry) => entry.transport)?.transport || "MCP";
      const configDisabled = entries.every((entry) => entry.enabled === false);
      return {
        name,
        detail: configDisabled
          ? "Disabled in provider configuration"
          : `${scopes.join(", ")} · ${transport}`,
        enabled: !configDisabled && !off.has(name),
        ...(configDisabled ? { configDisabled: true } : {}),
      };
    });
  return [...rows, ...missingRows(byName, harness, disabled)];
}

/** Rows for names that are switched off but not among the harness's servers. */
function missingRows(
  configured: { has(name: string): boolean },
  harness: HarnessId,
  disabled: readonly string[],
): ConnectorRow[] {
  return disabled
    .filter((name) => !configured.has(name))
    .map((name) => ({
      name,
      detail: `Not configured for ${HARNESS_TITLE[harness]}`,
      enabled: false,
      missing: true,
    }));
}

/** Host of a server address. The rest of a URL can carry a credential. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * The same rows, built from what the session's own harness reports instead of
 * from the configuration files the app can read. They differ when the session
 * runs a wrapper binary or a provider account with its own configuration.
 */
export function reportedConnectorRows(
  servers: readonly HarnessMcpServer[],
  harness: HarnessId,
  disabled: readonly string[],
): ConnectorRow[] {
  const off = new Set(disabled);
  const byName = new Map(servers.map((server) => [server.name, server]));
  const rows: ConnectorRow[] = [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((server) => {
      const configDisabled = !server.enabled;
      return {
        name: server.name,
        detail: configDisabled
          ? "Disabled in provider configuration"
          : server.command
            ? `stdio · ${server.command}`
            : server.url
              ? ["http", urlHost(server.url)].filter(Boolean).join(" · ")
              : "MCP",
        enabled: !configDisabled && !off.has(server.name),
        ...(configDisabled ? { configDisabled: true } : {}),
      };
    });
  return [...rows, ...missingRows(byName, harness, disabled)];
}

/**
 * What switching a server off does not do, where that differs from what the
 * word suggests. Claude Code is told to deny the server's tools; it still
 * starts the server and connects to it. Codex skips the server entirely.
 */
export function connectorSwitchCaveat(harness: HarnessId): string | undefined {
  return harness === "claude"
    ? "Claude Code still connects to a switched-off server, but cannot use its tools."
    : undefined;
}

/** The names to hand a harness, or nothing where it cannot act on them. */
export function harnessDisabledMcpServers(
  harness: HarnessId,
  disabled: readonly string[] | undefined,
): string[] | undefined {
  if (!disabled?.length || !harnessSupportsConnectorSwitches(harness)) {
    return undefined;
  }
  return sanitizeDisabledMcpServers(disabled);
}

/**
 * True when the switches differ from how they stood as the running turn
 * started. `atTurnStart` is null while no turn is running. Both harnesses
 * apply the switches when a turn starts, never in the middle of one.
 */
export function connectorChangePending(
  disabled: readonly string[],
  atTurnStart: readonly string[] | null,
): boolean {
  if (!atTurnStart) return false;
  if (disabled.length !== atTurnStart.length) return true;
  const before = new Set(atTurnStart);
  return disabled.some((name) => !before.has(name));
}
