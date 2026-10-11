import { useSyncExternalStore } from "react";
import type { HarnessLaunchMcpServer } from "../../../integrations/harness/core/types";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import type { HarnessId } from "../../sessions/model/session";
import { knownReportedMcpServerNames } from "../../session-tools/model/reportedMcpServers";
import { gatewayRunArgs } from "./dockerArgs";
import {
  installedState,
  type InstalledConnector,
  type InstalledState,
} from "./installed";

const CLAUDE_AI_PREFIX = "claude.ai ";

/** Harnesses whose sessions get gateway connectors at launch. */
export function harnessTakesGatewayConnectors(harness: HarnessId): boolean {
  return harness === "claude" || harness === "codex";
}

/**
 * The connectors a session starts with. Only ready ones: a connector that
 * still needs a sign-in or a key would start a gateway whose tools fail, and
 * leaving it out means signing in changes the set, so the next turn restarts
 * the harness with it. None while Docker is known to be missing or stopped.
 */
export function launchableConnectors(
  installed: InstalledState,
): InstalledConnector[] {
  if (!installed.docker) return [];
  if (
    installed.dockerState === "missing" ||
    installed.dockerState === "not-running"
  ) {
    return [];
  }
  return installed.connectors.filter(
    (connector) => connector.status === "ready",
  );
}

/** Lowercase letters and digits of a service name, without filler words. */
export function serviceKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[-_ ](remote|mcp|server|official)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * claude.ai connectors that duplicate a gateway connector, mapped to the
 * gateway connector's session name. A claude.ai name matches on its title,
 * e.g. "claude.ai Notion" and gateway `notion-remote` titled "Notion".
 */
export function claudeAiDuplicates(
  connectors: readonly Pick<
    InstalledConnector,
    "server" | "title" | "sessionName"
  >[],
  reportedNames: readonly string[],
): Map<string, string> {
  const byService = new Map<string, string>();
  for (const connector of connectors) {
    for (const key of [
      serviceKey(connector.title),
      serviceKey(connector.server),
    ]) {
      if (key && !byService.has(key)) byService.set(key, connector.sessionName);
    }
  }
  const out = new Map<string, string>();
  for (const name of reportedNames) {
    if (!name.startsWith(CLAUDE_AI_PREFIX)) continue;
    const match = byService.get(
      serviceKey(name.slice(CLAUDE_AI_PREFIX.length)),
    );
    if (match) out.set(name, match);
  }
  return out;
}

// claude.ai copies a chat switched back on, by session id. A default, not a
// stored per-chat "off": the copy is off only while the gateway has it.
const ON_KEY = "monocode.gatewayClaudeAiOn.v1";
const MAX_SESSIONS = 300;
const MAX_NAMES = 32;
const onListeners = new Set<() => void>();
let onBySession = loadExplicitlyOn();
const NONE: readonly string[] = [];

function loadExplicitlyOn(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  try {
    const raw =
      typeof localStorage === "undefined" ? null : localStorage.getItem(ON_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return map;
    }
    for (const [id, names] of Object.entries(parsed)) {
      if (map.size >= MAX_SESSIONS) break;
      if (!Array.isArray(names)) continue;
      const list = names
        .filter(
          (name): name is string =>
            typeof name === "string" && name.startsWith(CLAUDE_AI_PREFIX),
        )
        .slice(0, MAX_NAMES);
      if (list.length > 0) map.set(id, list);
    }
  } catch {
    // start empty
  }
  return map;
}

function saveExplicitlyOn(): void {
  try {
    localStorage.setItem(
      ON_KEY,
      JSON.stringify(Object.fromEntries(onBySession)),
    );
  } catch {
    // best effort
  }
}

/** claude.ai copies this chat switched back on. */
export function explicitlyOnClaudeAi(sessionId?: string): readonly string[] {
  return (sessionId && onBySession.get(sessionId)) || NONE;
}

export function setClaudeAiExplicitlyOn(
  sessionId: string,
  name: string,
  on: boolean,
): void {
  const current = onBySession.get(sessionId) ?? [];
  const next = on
    ? current.includes(name)
      ? current
      : [...current, name].slice(-MAX_NAMES)
    : current.filter((entry) => entry !== name);
  if (next === current) return;
  onBySession = new Map(onBySession);
  onBySession.delete(sessionId);
  if (next.length > 0) onBySession.set(sessionId, next);
  // Oldest sessions go first; a Map keeps insertion order.
  while (onBySession.size > MAX_SESSIONS) {
    const oldest = onBySession.keys().next().value;
    if (oldest === undefined) break;
    onBySession.delete(oldest);
  }
  saveExplicitlyOn();
  for (const notify of onListeners) notify();
}

export function useExplicitlyOnClaudeAi(sessionId?: string): readonly string[] {
  return useSyncExternalStore(
    (listener) => {
      onListeners.add(listener);
      return () => {
        onListeners.delete(listener);
      };
    },
    () => explicitlyOnClaudeAi(sessionId),
    () => NONE,
  );
}

/**
 * What a session's launch takes from the gateway: the servers to add, every
 * gateway session name (switched-off ones are left out of `servers` rather
 * than passed as switches), and, for Claude Code, the claude.ai copies that
 * are off by default for this chat.
 */
export function gatewaySessionInput(
  session: {
    id?: string;
    harness: HarnessId;
    disabledMcpServers?: readonly string[];
  },
  workCwd: string,
  installed: InstalledState = installedState(),
  reportedNames: readonly string[] = knownReportedMcpServerNames(),
): {
  servers: HarnessLaunchMcpServer[];
  names: ReadonlySet<string>;
  defaultOff: string[];
} {
  const names = new Set(installed.connectors.map((c) => c.sessionName));
  if (
    !harnessTakesGatewayConnectors(session.harness) ||
    workCwd.startsWith(REMOTE_PATH_PREFIX)
  ) {
    return { servers: [], names, defaultOff: [] };
  }
  const off = new Set(session.disabledMcpServers ?? []);
  const ready = launchableConnectors(installed);
  const docker = installed.docker ?? "";
  const servers = ready
    .filter((connector) => !off.has(connector.sessionName))
    .map((connector) => ({
      name: connector.sessionName,
      command: docker,
      args: gatewayRunArgs(connector.profileId),
    }));
  const defaultOff: string[] = [];
  if (session.harness === "claude" && servers.length > 0) {
    const started = new Set(servers.map((server) => server.name));
    const on = new Set(explicitlyOnClaudeAi(session.id));
    for (const [name, gateway] of claudeAiDuplicates(ready, reportedNames)) {
      if (started.has(gateway) && !on.has(name) && !off.has(name)) {
        defaultOff.push(name);
      }
    }
  }
  return { servers, names, defaultOff: defaultOff.sort() };
}

/** Gateway connectors a chat switched off, where the harness takes them. */
export function gatewaySwitchedOff(
  harness: HarnessId,
  disabled: readonly string[] | undefined,
  installed: InstalledState = installedState(),
): string[] {
  if (!disabled?.length || !harnessTakesGatewayConnectors(harness)) return [];
  const names = new Set(installed.connectors.map((c) => c.sessionName));
  return disabled.filter((name) => names.has(name));
}
