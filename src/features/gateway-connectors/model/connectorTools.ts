/**
 * Which tools of a gateway connector are on, read from and written to the
 * connector's own Docker profile. "Never" for a tool takes it out of the
 * profile's allowlist, so it leaves the tool list of every harness that gets
 * the gateway, and its definition stops costing context.
 *
 * Read in the Docker MCP gateway source (github.com/docker/mcp-gateway at
 * a34df45, `pkg/workingset/tools.go` and `workingset.go`), not run:
 * - `profile show --format json` lists `servers`, each with `tools` (null when
 *   every tool is on, else the allowlist) and `snapshot.server.tools`, the
 *   server's own tool list from the catalog;
 * - `profile tools <id> --disable <server>.<tool>` expands a null allowlist
 *   from the snapshot first. With no snapshot it changes nothing and still
 *   exits 0, so every change here is read back and checked;
 * - the server is found by its snapshot name, split from the tool at the
 *   first dot.
 */

import { runDockerMcp } from "../../../platform/tauri/dockerMcp";
import { loadTraitOverrides } from "../../model-traits/model/modelTraits";
import {
  canSwitchTools,
  isToolName,
  profileShowArgs,
  profileToolArgs,
  profileToolsResetArgs,
} from "./dockerArgs";

export type ConnectorTool = {
  name: string;
  description: string;
  on: boolean;
  /** False when MonoCode cannot pass this name to Docker. */
  switchable: boolean;
};

export type ConnectorTools = {
  server: string;
  tools: ConnectorTool[];
  /** True when the profile has no allowlist: every tool is on. */
  allOn: boolean;
  /** Tools on, counted from the allowlist when there is one. */
  onCount: number;
};

/** Why tools cannot be switched one by one for this connector. */
export type ToolsUnavailable = { reason: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The tools of one server in `profile show --format json` output. */
export function parseProfileTools(
  show: unknown,
  server: string,
): ConnectorTools | ToolsUnavailable {
  const servers = recordOf(show)?.servers;
  if (!Array.isArray(servers)) {
    return { reason: "Docker did not report this connector's profile." };
  }
  const entry = servers
    .map(recordOf)
    .find((rec) => recordOf(recordOf(rec?.snapshot)?.server)?.name === server);
  if (!entry) {
    return {
      reason:
        "This connector's profile has no tool list from the catalog, so Docker cannot switch its tools one by one.",
    };
  }
  const listed = recordOf(recordOf(entry.snapshot)?.server)?.tools;
  const known = (Array.isArray(listed) ? listed : []).flatMap((value) => {
    const rec = recordOf(value);
    const name = typeof rec?.name === "string" ? rec.name : "";
    if (!name) return [];
    const description =
      typeof rec?.description === "string" ? rec.description : "";
    return [{ name, description }];
  });
  if (known.length === 0) {
    return { reason: "The catalog lists no tools for this connector." };
  }
  const allow = entry.tools;
  const allOn = allow === null || allow === undefined;
  const allowed = new Set(
    Array.isArray(allow)
      ? allow.filter((name): name is string => typeof name === "string")
      : [],
  );
  const serverOk = canSwitchTools(server);
  const tools = known.map(({ name, description }) => ({
    name,
    description,
    on: allOn || allowed.has(name),
    switchable: serverOk && isToolName(name),
  }));
  return {
    server,
    tools,
    allOn,
    onCount: tools.filter((tool) => tool.on).length,
  };
}

export function toolsAvailable(
  value: ConnectorTools | ToolsUnavailable,
): value is ConnectorTools {
  return "tools" in value;
}

async function readShow(profileId: string): Promise<unknown> {
  const { stdout } = await runDockerMcp(profileShowArgs(profileId));
  return JSON.parse(stdout);
}

export async function readConnectorTools(
  profileId: string,
  server: string,
): Promise<ConnectorTools | ToolsUnavailable> {
  try {
    return parseProfileTools(await readShow(profileId), server);
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

export type ToolChange =
  | { ok: true; tools: ConnectorTools }
  | { ok: false; reason: string; tools?: ConnectorTools };

/**
 * Turn one tool on or off, then read the profile again and check it took.
 * Docker reports success even when it changed nothing.
 */
export async function setConnectorTool(
  profileId: string,
  server: string,
  tool: string,
  on: boolean,
): Promise<ToolChange> {
  let args: string[];
  try {
    args = profileToolArgs(profileId, server, tool, on);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return change(profileId, server, args, (tools) =>
    tools.tools.some((entry) => entry.name === tool && entry.on === on),
  );
}

/** Every tool of the connector back on. */
export async function enableAllConnectorTools(
  profileId: string,
  server: string,
): Promise<ToolChange> {
  let args: string[];
  try {
    args = profileToolsResetArgs(profileId, server);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return change(profileId, server, args, (tools) => tools.allOn);
}

async function change(
  profileId: string,
  server: string,
  args: string[],
  took: (tools: ConnectorTools) => boolean,
): Promise<ToolChange> {
  try {
    await runDockerMcp(args);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const after = await readConnectorTools(profileId, server);
  if (!toolsAvailable(after)) return { ok: false, reason: after.reason };
  if (!took(after)) {
    return {
      ok: false,
      reason: "Docker reported no change. The connector's tools are as shown.",
      tools: after,
    };
  }
  return { ok: true, tools: after };
}

/**
 * A rough cost per tool definition, for the warning only. Definitions with
 * their JSON schemas commonly run a few hundred tokens each; this is an
 * estimate, not a measurement.
 */
export const TOKENS_PER_TOOL_ESTIMATE = 250;

/** The smallest context window you set for any model, and that model. */
export function smallestContextWindow(): {
  model: string;
  window: number;
} | null {
  let best: { model: string; window: number } | null = null;
  for (const [model, traits] of Object.entries(loadTraitOverrides())) {
    const window = traits.contextWindow;
    if (typeof window !== "number") continue;
    if (!best || window < best.window) best = { model, window };
  }
  return best;
}

/**
 * A warning when this many tools would take more than a tenth of a small
 * model's window. Null when no window is known or the tools fit.
 */
export function toolContextWarning(
  onCount: number,
  smallest: { model: string; window: number } | null,
): string | null {
  if (!smallest || onCount <= 0) return null;
  const tokens = onCount * TOKENS_PER_TOOL_ESTIMATE;
  if (tokens * 10 <= smallest.window) return null;
  const share = Math.round((tokens / smallest.window) * 100);
  return `${onCount} tools on: about ${tokens.toLocaleString("en-US")} tokens of definitions (an estimate), ${share}% of ${smallest.model}'s ${smallest.window.toLocaleString("en-US")}-token window, in every request where the harness sends them all. Turn off tools you do not use.`;
}
