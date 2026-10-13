import type { HarnessId, Session } from "../../sessions/model/session";
import { providerLocality } from "../../model-setup/model/providerLocality";
import { gatewaySessionInput } from "../../gateway-connectors/model/sessionGateway";
import { serverLocality, type LocalityServer } from "./serverLocality";
import { knownHarnessServers } from "./sessionServers";

/**
 * Where a session's content goes: only to this Mac, to a hosted service, or
 * not known. Callers treat "unknown" as hosted, everywhere.
 */
export type Locality = "local" | "hosted" | "unknown";

/** The session fields a locality decision may read. */
export type LocalitySession = Pick<Session, "harness"> &
  Partial<
    Pick<
      Session,
      | "id"
      | "cwd"
      | "worktreeCwd"
      | "model"
      | "modelProvider"
      | "providerAccountId"
      | "disabledMcpServers"
      | "disabledSkills"
      | "gatewayOn"
      | "blocks"
    >
  >;

/**
 * Harnesses whose model always runs on the vendor's service. Their session
 * is hosted whatever else is true.
 */
const HOSTED_HARNESSES: ReadonlySet<HarnessId> = new Set<HarnessId>([
  "claude",
  "cursor",
  "grok",
  "antigravity",
  "devin",
]);

export function harnessIsHosted(harness: HarnessId): boolean {
  return HOSTED_HARNESSES.has(harness);
}

/** The worst of several localities: hosted beats unknown beats local. */
export function combineLocality(parts: readonly Locality[]): Locality {
  if (parts.includes("hosted")) return "hosted";
  if (parts.includes("unknown")) return "unknown";
  return "local";
}

export type LocalityPart = {
  /** What the part is: the model route, or an MCP server by name. */
  label: string;
  kind: "model" | "server" | "harness";
  locality: Locality;
};

/**
 * Each part that decides a session's locality, for the destinations line:
 * the model route, then every MCP server the session starts.
 *
 * `servers` is the session's own enabled servers when the caller knows them.
 * Without it, the last list the harness reported for this account and folder
 * is used. With neither, the harness's own servers are unknown.
 */
export function sessionLocalityParts(
  session: LocalitySession,
  servers?: readonly LocalityServer[],
): LocalityPart[] {
  if (harnessIsHosted(session.harness)) {
    return [{ label: session.harness, kind: "harness", locality: "hosted" }];
  }
  const parts: LocalityPart[] = [
    {
      label: session.modelProvider || "model",
      kind: "model",
      locality: providerLocality(session.modelProvider),
    },
  ];
  const cwd = session.worktreeCwd || session.cwd || "";
  const off = new Set(session.disabledMcpServers ?? []);
  const own =
    servers ?? knownHarnessServers(session.harness, session.providerAccountId, cwd);
  if (!own) {
    parts.push({ label: "this harness's servers", kind: "server", locality: "unknown" });
  } else {
    for (const server of own) {
      if (off.has(server.name)) continue;
      parts.push({ label: server.name, kind: "server", locality: serverLocality(server) });
    }
  }
  let gateway: { name: string; command: string; args: string[] }[] = [];
  try {
    gateway = gatewaySessionInput(
      {
        ...(session.id ? { id: session.id } : {}),
        harness: session.harness,
        disabledMcpServers: session.disabledMcpServers ?? [],
        ...(session.model ? { model: session.model } : {}),
        ...(session.modelProvider
          ? { modelProvider: session.modelProvider }
          : {}),
        ...(session.providerAccountId
          ? { providerAccountId: session.providerAccountId }
          : {}),
        ...(session.gatewayOn ? { gatewayOn: session.gatewayOn } : {}),
        ...(session.blocks ? { blocks: session.blocks } : {}),
      },
      cwd,
    ).servers.map((server) => ({
      name: server.name,
      command: server.command,
      args: [...(server.args ?? [])],
    }));
  } catch {
    parts.push({ label: "gateway connectors", kind: "server", locality: "unknown" });
  }
  const listed = new Set(parts.map((part) => part.label));
  for (const server of gateway) {
    if (listed.has(server.name)) continue;
    parts.push({ label: server.name, kind: "server", locality: serverLocality(server) });
  }
  return parts;
}

/**
 * Filled by lane 4 (#9). A session is local only when its model route, its
 * harness home and every enabled tool are local:
 *
 * - Claude Code, Cursor, Grok Build, Antigravity and Devin are hosted.
 * - The model route is `providerLocality(session.modelProvider)` (lane 5).
 *   A session with no provider recorded is unknown. The harness home is
 *   judged by the same route: a home is local when its provider is.
 * - Every MCP server the session starts must be local: its own servers (see
 *   `sessionLocalityParts`) and every gateway connector not switched off.
 */
export function sessionIsLocal(
  session: LocalitySession,
  servers?: readonly LocalityServer[],
): Locality {
  return combineLocality(
    sessionLocalityParts(session, servers).map((part) => part.locality),
  );
}

/** Whether a locality counts as local. "unknown" never does. */
export function isLocal(locality: Locality): boolean {
  return locality === "local";
}
