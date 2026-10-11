import type { ConnectorRow } from "../../session-tools/model/connectors";
import type { HarnessId } from "../../sessions/model/session";
import type { InstalledConnector, InstalledState } from "./installed";
import {
  claudeAiDuplicates,
  harnessTakesGatewayConnectors,
  launchableConnectors,
} from "./sessionGateway";

/** Why a connector is not started, in the switch row's detail line. */
export function gatewayStatusDetail(connector: InstalledConnector): string {
  switch (connector.status) {
    case "ready":
      return "";
    case "needs-sign-in":
      return "needs sign-in in Connectors";
    case "needs-setup":
      return "needs setup in Connectors";
    case "untested":
      return "not tested yet";
    case "failed":
      return `failed: ${connector.test?.reason ?? "test failed"}`;
  }
}

export const GATEWAY_GROUP_TITLE = "Docker gateway";
export const GATEWAY_DUPLICATE_DETAIL = "Off: using the Docker gateway copy";

/**
 * The connector switches with the Docker gateway's connectors in them. Rows
 * the harness reported under a gateway connector's name are replaced by one
 * gateway row each. A connector that is not ready, or any while Docker is
 * stopped, gets a row with its switch disabled: it is not started.
 *
 * For Claude Code, a claude.ai copy of a gateway connector that is off by
 * default for this chat (`defaultOff`) shows as off with why.
 */
export function withGatewayRows(
  rows: readonly ConnectorRow[],
  input: {
    harness: HarnessId;
    installed: InstalledState;
    disabled: readonly string[];
    defaultOff: readonly string[];
  },
): { rows: ConnectorRow[]; gatewayNames: Set<string> } {
  if (!harnessTakesGatewayConnectors(input.harness)) {
    return { rows: [...rows], gatewayNames: new Set() };
  }
  const connectors = input.installed.connectors;
  const gatewayNames = new Set(connectors.map((c) => c.sessionName));
  const launchable = new Set(
    launchableConnectors(input.installed).map((c) => c.sessionName),
  );
  const off = new Set(input.disabled);
  const dockerDown =
    input.installed.dockerState === "not-running"
      ? "Docker Desktop is not running"
      : input.installed.dockerState === "missing"
        ? "Docker is not installed"
        : "";
  const gatewayRows: ConnectorRow[] = [...connectors]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((connector) => {
      const startable = launchable.has(connector.sessionName);
      const state = dockerDown || gatewayStatusDetail(connector);
      return {
        name: connector.sessionName,
        detail: [
          connector.kind === "remote" ? "Hosted" : "Runs in Docker",
          state,
        ]
          .filter(Boolean)
          .join(" · "),
        enabled: startable && !off.has(connector.sessionName),
        ...(startable ? {} : { configDisabled: true }),
      };
    });
  const defaultOff = new Set(input.defaultOff);
  const rest = rows
    .filter((row) => !gatewayNames.has(row.name))
    .map((row) =>
      defaultOff.has(row.name)
        ? { ...row, enabled: false, detail: GATEWAY_DUPLICATE_DETAIL }
        : row,
    );
  return { rows: [...rest, ...gatewayRows], gatewayNames };
}

/**
 * What switching a row does when it is a claude.ai copy of a gateway
 * connector. Switching it on records that this chat wants it back; switching
 * it off clears that, and also lists it as off when the default no longer
 * applies (the gateway copy is switched off). Null for any other row.
 */
export function claudeAiDuplicateToggle(input: {
  name: string;
  on: boolean;
  harness: HarnessId;
  installed: InstalledState;
  reportedNames: readonly string[];
  disabled: readonly string[];
}): { explicitlyOn: boolean; listOff: boolean } | null {
  if (input.harness !== "claude") return null;
  const duplicates = claudeAiDuplicates(
    launchableConnectors(input.installed),
    input.reportedNames,
  );
  const gateway = duplicates.get(input.name);
  if (!gateway) return null;
  if (input.on) return { explicitlyOn: true, listOff: false };
  // Off by default only while the gateway copy is started for this chat.
  return {
    explicitlyOn: false,
    listOff: input.disabled.includes(gateway),
  };
}
