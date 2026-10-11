import { useEffect, useMemo, useState } from "react";
import {
  gatewaySessionInput,
  harnessTakesGatewayConnectors,
} from "../../gateway-connectors/model/sessionGateway";
import { useInstalledConnectors } from "../../gateway-connectors/model/installed";
import { useReportedMcpServers } from "../../session-tools/model/reportedMcpServers";
import type { HarnessId, ToolAccess } from "../../sessions/model/session";
import {
  getCachedMcpSettings,
  loadMcpSettings,
  subscribeMcpSettings,
  type McpServerRow,
} from "../../settings/model/mcpSettingsCache";
import { researchTools, type ResearchTool } from "../model/searchTools";
import { harnessSupportsResearch } from "../model/visibility";

const NO_SERVERS: McpServerRow[] = [];

/**
 * The search tools a chat's next turn has, from what MonoCode already knows:
 * the Docker gateway connectors it starts the turn with, Claude Code's report
 * of its claude.ai connectors and plugins, and the MCP servers configured on
 * this computer. `load` reads the configured servers when they are not
 * cached yet, for Claude Code only; it runs MCP discovery, so it is set only
 * while the plus menu or research mode is open.
 */
export function useResearchTools(input: {
  harness: HarnessId;
  cwd: string;
  sessionId?: string;
  providerAccountId?: string;
  disabledMcpServers?: readonly string[];
  toolAccess?: ToolAccess;
  remote: boolean;
  load: boolean;
}): ResearchTool[] {
  const {
    harness,
    cwd,
    sessionId,
    providerAccountId,
    disabledMcpServers,
    toolAccess,
    remote,
    load,
  } = input;
  const on = !remote && harnessSupportsResearch(harness);
  const installed = useInstalledConnectors();
  const reported = useReportedMcpServers(
    sessionId,
    providerAccountId,
    on && harness === "claude",
  );
  const [configured, setConfigured] = useState<McpServerRow[]>(
    () => (on && getCachedMcpSettings(cwd)?.servers) || NO_SERVERS,
  );
  useEffect(() => {
    if (!on || !cwd) {
      setConfigured(NO_SERVERS);
      return;
    }
    setConfigured(getCachedMcpSettings(cwd)?.servers ?? NO_SERVERS);
    return subscribeMcpSettings(cwd, (snapshot) =>
      setConfigured(snapshot.servers),
    );
  }, [cwd, on]);
  // Codex chats are not sent to discovery: it reads the app's own Codex home,
  // which a wrapper binary or provider account may not use. A cached list,
  // from Settings or the /mcp picker, still counts.
  useEffect(() => {
    if (!on || !load || harness !== "claude") return;
    if (!cwd || getCachedMcpSettings(cwd)) return;
    void loadMcpSettings(cwd, false, { claudeHealth: false });
  }, [cwd, harness, load, on]);

  return useMemo(() => {
    if (!on) return [];
    const gatewayNames = harnessTakesGatewayConnectors(harness)
      ? new Set(
          gatewaySessionInput(
            { id: sessionId, harness, disabledMcpServers },
            cwd,
            installed,
            [],
          ).servers.map((server) => server.name),
        )
      : new Set<string>();
    return researchTools({
      harness,
      toolAccess,
      disabledMcpServers,
      gateway: installed.connectors.filter((connector) =>
        gatewayNames.has(connector.sessionName),
      ),
      reported,
      configured,
    });
  }, [
    configured,
    cwd,
    disabledMcpServers,
    harness,
    installed,
    on,
    reported,
    sessionId,
    toolAccess,
  ]);
}
