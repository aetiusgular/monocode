import type { HarnessId } from "../../sessions/model/session";
import type { LocalityServer } from "./serverLocality";

/**
 * What a harness itself reported for one account and folder: its MCP servers,
 * and the model route its configuration names. A session's own servers and
 * route are known only once the harness has been asked; until then they are
 * unknown and the session cannot count as local. Kept for this app run only.
 *
 * The Connectors list asks for the servers. A harness that can read its own
 * configuration registers a probe (`registerHarnessConfigProbe`), which
 * `requestHarnessReport` runs per account and folder when a locality
 * decision needs it and the last answer is older than a minute.
 */
const reported = new Map<string, LocalityServer[]>();
const routes = new Map<string, ReportedModelRoute>();
/** When each answer came in, so a decision can ask again once it is old. */
const reportedAt = new Map<string, number>();
const routesAt = new Map<string, number>();
/**
 * How long a report stands for the harness's configuration: the same minute
 * the Codex server list is cached for. A home edited after that is read
 * again before local-only content is shared.
 */
export const HARNESS_REPORT_TTL_MS = 60_000;
const MAX_SERVERS = 200;
const MAX_KEYS = 200;

/** The model route a harness's own configuration names (Mac finding 5.6). */
export type ReportedModelRoute = {
  /** The effective provider id. */
  provider: string;
  /** Base URL of each provider the configuration defines, by id. */
  baseUrls: Readonly<Record<string, string>>;
  /** The model the configuration names, when it names one. */
  model?: string;
};

export type HarnessReport = {
  servers?: readonly ReportedServer[];
  route?: ReportedModelRoute;
};

type ReportedServer = {
  name: string;
  enabled?: boolean;
  command?: string;
  args?: readonly string[];
  url?: string;
};

type Probe = (input: {
  cwd: string;
  providerAccountId: string;
}) => Promise<HarnessReport | null>;

const probes = new Map<HarnessId, Probe>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

/** The account part of a key: a missing account is the default one. */
function accountKey(providerAccountId: string | undefined): string {
  return providerAccountId || "default";
}

function key(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
): string {
  return `${harness}\n${accountKey(providerAccountId)}\n${cwd}`;
}

function bump(): void {
  version += 1;
  for (const notify of listeners) notify();
}

function capped<V>(map: Map<string, V>, id: string, value: V): void {
  map.delete(id);
  map.set(id, value);
  while (map.size > MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function noteHarnessServers(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
  servers: readonly ReportedServer[] | undefined,
): void {
  const id = key(harness, providerAccountId, cwd);
  if (!servers) {
    reportedAt.delete(id);
    if (reported.delete(id)) bump();
    return;
  }
  capped(reportedAt, id, Date.now());
  capped(
    reported,
    id,
    servers
      .filter((server) => server.enabled !== false)
      .slice(0, MAX_SERVERS)
      .map((server) => ({
        name: server.name,
        ...(server.command ? { command: server.command } : {}),
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.url ? { url: server.url } : {}),
      })),
  );
  bump();
}

/** The servers last reported, or undefined when the harness was never asked. */
export function knownHarnessServers(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
): readonly LocalityServer[] | undefined {
  return reported.get(key(harness, providerAccountId, cwd));
}

export function noteHarnessModelRoute(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
  route: ReportedModelRoute | undefined,
): void {
  const id = key(harness, providerAccountId, cwd);
  if (!route) {
    routesAt.delete(id);
    if (routes.delete(id)) bump();
    return;
  }
  capped(routesAt, id, Date.now());
  capped(routes, id, {
    provider: route.provider,
    baseUrls: { ...route.baseUrls },
    ...(route.model ? { model: route.model } : {}),
  });
  bump();
}

/** The model route last reported, or undefined when it was never read. */
export function knownHarnessModelRoute(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
): ReportedModelRoute | undefined {
  return routes.get(key(harness, providerAccountId, cwd));
}

function fresh(at: Map<string, number>, id: string): boolean {
  const when = at.get(id);
  if (when === undefined) return false;
  const age = Date.now() - when;
  return age >= 0 && age < HARNESS_REPORT_TTL_MS;
}

/**
 * True when the servers, and the model route unless `route` is false, were
 * reported within the last minute. A decision that gates content needs a
 * fresh report.
 */
export function harnessReportFresh(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
  { route = true }: { route?: boolean } = {},
): boolean {
  const id = key(harness, providerAccountId, cwd);
  return fresh(reportedAt, id) && (!route || fresh(routesAt, id));
}

/** A harness adapter registers how its own configuration is read. */
export function registerHarnessConfigProbe(
  harness: HarnessId,
  probe: Probe | null,
): void {
  if (probe) probes.set(harness, probe);
  else probes.delete(harness);
}

export function canProbeHarness(harness: HarnessId): boolean {
  return probes.has(harness);
}

/**
 * Ask the harness for its servers and model route for this account and
 * folder, unless both were reported within the last minute. Resolves when the answer is in, or when the
 * probe failed (everything stays unknown). Never rejects.
 */
export function requestHarnessReport(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
): Promise<void> {
  const probe = probes.get(harness);
  if (!probe || !cwd || cwd === "~") return Promise.resolve();
  const id = key(harness, providerAccountId, cwd);
  if (harnessReportFresh(harness, providerAccountId, cwd))
    return Promise.resolve();
  const pending = inFlight.get(id);
  if (pending) return pending;
  const run = probe({ cwd, providerAccountId: accountKey(providerAccountId) })
    .then(
      (report) => {
        if (!report) return;
        if (report.servers)
          noteHarnessServers(harness, providerAccountId, cwd, report.servers);
        if (report.route)
          noteHarnessModelRoute(harness, providerAccountId, cwd, report.route);
      },
      () => undefined,
    )
    .finally(() => {
      inFlight.delete(id);
    });
  inFlight.set(id, run);
  return run;
}

export function subscribeHarnessReports(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function harnessReportsVersion(): number {
  return version;
}

/** Test seam. */
export function __resetHarnessServers(): void {
  reported.clear();
  routes.clear();
  reportedAt.clear();
  routesAt.clear();
  inFlight.clear();
  probes.clear();
  bump();
}
