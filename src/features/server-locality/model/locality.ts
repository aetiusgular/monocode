import type { HarnessId, Session } from "../../sessions/model/session";
import { providerLocality } from "../../model-setup/model/providerLocality";
import { providerForAccount } from "../../model-setup/model/modelProviders";
import { gatewaySessionInput } from "../../gateway-connectors/model/sessionGateway";
import { serverLocality, type LocalityServer } from "./serverLocality";
import {
  isRelayedCloudModel,
  localityAccount,
  reportedRouteLocality,
} from "./reportedRoute";
import {
  canProbeHarness,
  harnessReportFresh,
  knownHarnessModelRoute,
  knownHarnessServers,
  requestHarnessReport,
} from "./sessionServers";

export { isRelayedCloudModel, localityAccount, reportedRouteLocality };

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
 * The model route of a session that can pick a provider: the provider picked
 * for the chat, else the one the Models page wrote for its account, else what
 * the session's own harness reported from its configuration. A chat's pick
 * is passed to the harness, so it wins over the configuration.
 */
export function modelRoutePart(session: LocalitySession): LocalityPart {
  const account = localityAccount(session);
  const picked = session.modelProvider || providerForAccount(account)?.id;
  if (picked) {
    return {
      label: picked,
      kind: "model",
      locality: isRelayedCloudModel(session.model)
        ? "hosted"
        : providerLocality(picked),
    };
  }
  const cwd = session.worktreeCwd || session.cwd || "";
  const route = knownHarnessModelRoute(session.harness, account, cwd);
  if (route) {
    return {
      label: route.provider,
      kind: "model",
      locality: isRelayedCloudModel(session.model)
        ? "hosted"
        : reportedRouteLocality(route),
    };
  }
  return { label: "model", kind: "model", locality: "unknown" };
}

/**
 * Each part that decides a session's locality, for the destinations line:
 * the model route, then every MCP server the session starts.
 *
 * `servers` is the session's own enabled servers when the caller knows them.
 * Without it, the last list the harness reported for this account and folder
 * is used. With neither, the harness's own servers are unknown.
 *
 * MonoCode's own outbound calls (link previews, usage figures, the version
 * check, the star check, GitHub lookups) are not parts: they do not carry a
 * chat's transcript to a model, so they never decide a session's locality.
 */
export function sessionLocalityParts(
  session: LocalitySession,
  servers?: readonly LocalityServer[],
): LocalityPart[] {
  if (harnessIsHosted(session.harness)) {
    return [{ label: session.harness, kind: "harness", locality: "hosted" }];
  }
  const parts: LocalityPart[] = [modelRoutePart(session)];
  const cwd = session.worktreeCwd || session.cwd || "";
  const off = new Set(session.disabledMcpServers ?? []);
  const own =
    servers ??
    knownHarnessServers(session.harness, localityAccount(session), cwd);
  if (!own) {
    parts.push({
      label: "this harness's servers",
      kind: "server",
      locality: "unknown",
    });
  } else {
    for (const server of own) {
      if (off.has(server.name)) continue;
      parts.push({
        label: server.name,
        kind: "server",
        locality: serverLocality(server),
      });
    }
  }
  let gateway: LocalityServer[] = [];
  try {
    gateway = gatewaySessionInput(
      {
        ...(session.id ? { id: session.id } : {}),
        harness: session.harness,
        // The folder, so the gateway's local default reads the route the
        // harness reported for it, as the composer and the panel do (2.23).
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.worktreeCwd ? { worktreeCwd: session.worktreeCwd } : {}),
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
    parts.push({
      label: "gateway connectors",
      kind: "server",
      locality: "unknown",
    });
  }
  const listed = new Set(parts.map((part) => part.label));
  for (const server of gateway) {
    if (listed.has(server.name)) continue;
    parts.push({
      label: server.name,
      kind: "server",
      locality: serverLocality(server),
    });
  }
  return parts;
}

/**
 * Filled by lane 4 (#9). A session is local only when its model route, its
 * harness home and every enabled tool are local:
 *
 * - Claude Code, Cursor, Grok Build, Antigravity and Devin are hosted.
 * - The model route is the chat's provider, else its account's provider,
 *   else the route the harness reported from its own configuration
 *   (`modelRoutePart`). With none of these it is unknown. The harness home
 *   is judged by the same route: a home is local when its provider is.
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

/**
 * `sessionIsLocal` after asking the session's own harness, once per account
 * and folder, for its servers and model route when they are not known yet.
 * Used where a decision gates content (local-only memory), so a Codex on a
 * wrapper home is read before it is judged. A report older than a minute is
 * read again, and a failed or slow probe leaves the parts unknown, which
 * counts as hosted: a home edited to a hosted provider since the last read
 * never passes as local.
 */
export async function sessionLocalityNow(
  session: LocalitySession,
  servers?: readonly LocalityServer[],
): Promise<Locality> {
  if (harnessIsHosted(session.harness)) return sessionIsLocal(session, servers);
  const account = localityAccount(session);
  const cwd = session.worktreeCwd || session.cwd || "";
  await requestHarnessReport(session.harness, account, cwd);
  const locality = sessionIsLocal(session, servers);
  if (locality === "local" && localityReportStale(session)) return "unknown";
  return locality;
}

/**
 * The model route's locality alone, judged as the privacy panel's model row
 * judges it (`modelRoutePart`), after asking the session's own harness when
 * the route is not known. A local verdict that rests on a reported route
 * older than a minute counts as unknown, and so does a probe that fails or
 * times out. Used where file text may go to the model (3.13): only a local
 * route gets it. Connectors do not decide this one; the panel's Private does.
 */
export async function modelRouteLocalityNow(
  session: LocalitySession,
): Promise<Locality> {
  if (harnessIsHosted(session.harness)) return "hosted";
  const account = localityAccount(session);
  const cwd = session.worktreeCwd || session.cwd || "";
  const picked = session.modelProvider || providerForAccount(account)?.id;
  if (!picked) await requestHarnessReport(session.harness, account, cwd);
  const locality = modelRoutePart(session).locality;
  if (
    locality === "local" &&
    !picked &&
    !harnessReportFresh(session.harness, account, cwd)
  )
    return "unknown";
  return locality;
}

/**
 * True when a local verdict for this session would rest on what its harness
 * reported more than a minute ago, or never: a home edited to a hosted
 * provider since then would still read as local. The sync views use it to
 * show such a session as not known to be local until the next report
 * (security fix R8).
 */
export function localityReportStale(session: LocalitySession): boolean {
  if (harnessIsHosted(session.harness) || !canProbeHarness(session.harness))
    return false;
  const account = localityAccount(session);
  const cwd = session.worktreeCwd || session.cwd || "";
  // The configured route counts only when the chat or its account picked
  // no provider (`modelRoutePart`).
  const route = !(session.modelProvider || providerForAccount(account)?.id);
  return !harnessReportFresh(session.harness, account, cwd, { route });
}

/** Whether a locality counts as local. "unknown" never does. */
export function isLocal(locality: Locality): boolean {
  return locality === "local";
}
