import { invoke } from "@tauri-apps/api/core";
import { parseClaudeMcpList, type McpConnection } from "./mcp";
import { selectedProviderAccountId } from "../../providers/model/providerAccounts";
import { runtimeProviderBinaryPath } from "../../providers/model/providerBinaryPaths";

/**
 * #7: the Codex home a session in this project runs on, so Settings → MCP
 * lists that home's servers: the project's Codex account, and the configured
 * Codex binary, which may be a wrapper script that sets `CODEX_HOME`.
 */
export function discoverArgs(cwd: string): {
  cwd: string;
  codexAccountId?: string;
  codexBinary?: string;
} {
  let codexAccountId: string | undefined;
  let codexBinary: string | undefined;
  try {
    const selected = selectedProviderAccountId("codex", cwd);
    // The default account runs on the default home: nothing to send.
    codexAccountId = selected && selected !== "default" ? selected : undefined;
  } catch {
    codexAccountId = undefined;
  }
  try {
    codexBinary = runtimeProviderBinaryPath("codex") ?? undefined;
  } catch {
    codexBinary = undefined;
  }
  return {
    cwd,
    ...(codexAccountId ? { codexAccountId } : {}),
    ...(codexBinary ? { codexBinary } : {}),
  };
}

export type McpServerRow = McpConnection & { status: string };

export type McpSettingsSnapshot = {
  servers: McpServerRow[];
  error: string;
  claudeError: string;
};

const snapshots = new Map<string, McpSettingsSnapshot>();
const requests = new Map<string, Promise<McpSettingsSnapshot>>();
const healthRequests = new Map<string, Promise<void>>();
const listeners = new Map<
  string,
  Set<(snapshot: McpSettingsSnapshot) => void>
>();

export function getCachedMcpSettings(cwd: string) {
  return snapshots.get(cwd);
}

export function subscribeMcpSettings(
  cwd: string,
  listener: (snapshot: McpSettingsSnapshot) => void,
) {
  const subscribers = listeners.get(cwd) ?? new Set();
  subscribers.add(listener);
  listeners.set(cwd, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(cwd);
  };
}

function publish(cwd: string, snapshot: McpSettingsSnapshot) {
  snapshots.set(cwd, snapshot);
  listeners.get(cwd)?.forEach((listener) => listener(snapshot));
}

/** Discovery is shared across settings and pickers; health never delays the list. */
export function loadMcpSettings(
  cwd: string,
  force = false,
  options: { claudeHealth?: boolean } = {},
) {
  let request = requests.get(cwd);
  if (!request || force) {
    const discovery = fetchMcpSettings(cwd).then((snapshot) => {
      if (requests.get(cwd) === discovery) {
        healthRequests.delete(cwd);
        publish(cwd, snapshot);
      }
      return snapshot;
    });
    requests.set(cwd, discovery);
    request = discovery;
  }
  const discovery = request;
  return discovery.then((snapshot) => {
    if (
      options.claudeHealth !== false &&
      !snapshot.error &&
      requests.get(cwd) === discovery
    ) {
      loadClaudeHealth(cwd, discovery);
    }
    return snapshots.get(cwd) ?? snapshot;
  });
}

async function fetchMcpSettings(cwd: string): Promise<McpSettingsSnapshot> {
  try {
    const configured = await invoke<McpConnection[]>(
      "mcp_discover",
      discoverArgs(cwd),
    );
    const servers = configured.map((server) => ({
      ...server,
      status: server.enabled === false ? "Disabled" : "Configured",
    }));
    return { servers, error: "", claudeError: "" };
  } catch (cause) {
    return { servers: [], error: String(cause), claudeError: "" };
  }
}

function loadClaudeHealth(
  cwd: string,
  discovery: Promise<McpSettingsSnapshot>,
) {
  if (healthRequests.has(cwd)) return;
  const request = invoke<string>("claude_mcp_list", { cwd })
    .then((output) => {
      if (requests.get(cwd) !== discovery) return;
      const snapshot = snapshots.get(cwd)!;
      const health = new Map(
        parseClaudeMcpList(output).map((server) => [
          server.name,
          server.status,
        ]),
      );
      const servers: McpServerRow[] = snapshot.servers.map((server) => ({
        ...server,
        status:
          server.enabled === false
            ? "Disabled"
            : server.provider === "claude"
              ? (health.get(server.name) ?? "Configured")
              : server.status,
      }));
      // Claude can supply connections that are not stored in a local config file.
      for (const [name, status] of health) {
        if (
          servers.some(
            (server) => server.provider === "claude" && server.name === name,
          )
        )
          continue;
        servers.push({
          provider: "claude",
          name,
          scope: "local",
          configPath: "",
          transport: "",
          status,
        });
      }
      publish(cwd, { ...snapshot, servers, claudeError: "" });
    })
    .catch((cause) => {
      if (requests.get(cwd) !== discovery) return;
      publish(cwd, { ...snapshots.get(cwd)!, claudeError: String(cause) });
    });
  healthRequests.set(cwd, request);
}

export function clearMcpSettingsCache() {
  snapshots.clear();
  requests.clear();
  healthRequests.clear();
}
