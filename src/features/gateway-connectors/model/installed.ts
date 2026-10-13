import { useSyncExternalStore } from "react";
import { runDockerMcp } from "../../../platform/tauri/dockerMcp";
import {
  catalogServerRef,
  connectorProfileId,
  connectorProfileName,
  DEFAULT_TIMEOUT_MS,
  DRY_RUN_TIMEOUT_MS,
  gatewayDryRunArgs,
  isServerName,
  oauthAuthorizeArgs,
  oauthListArgs,
  oauthRevokeArgs,
  OAUTH_TIMEOUT_MS,
  OWN_PROFILE_PREFIX,
  profileConfigGetArgs,
  profileConfigSetArgs,
  profileCreateArgs,
  profileListArgs,
  profileRemoveArgs,
  secretListArgs,
  secretSetArgs,
} from "./dockerArgs";
import {
  trimCatalogEntry,
  type CatalogConnector,
  type ConnectorAuth,
  type ConnectorSetting,
} from "./catalog";
import { parseDryRun, type TestCause } from "./dryRun";
import { bringAppToFront } from "../../../platform/tauri/appWindow";

/** What adding a connector still needs before it can be tested. */
export type SetupState = "complete" | "needs-sign-in" | "needs-setup";

/**
 * Whether a connector can be used now. Only `ready` connectors start in
 * sessions: setup complete and the last test passed.
 */
export type ConnectorStatus =
  "ready" | "needs-sign-in" | "needs-setup" | "untested" | "failed";

/** The last `gateway run --dry-run` for one connector. */
export type TestResult = {
  at: number;
  ok: boolean;
  tools: number;
  reason?: string;
  cause?: TestCause;
  /** The run's output, the last 4 KB of it. */
  output: string;
};

/** One connector MonoCode added: a `monocode_` profile with one server. */
export type InstalledConnector = {
  profileId: string;
  server: string;
  title: string;
  description: string;
  icon?: string;
  kind: CatalogConnector["kind"];
  /** Container image, for a container connector. */
  image?: string;
  /** The catalog runs the container with no network. */
  noNetwork?: true;
  auth: ConnectorAuth;
  /** The MCP server name sessions see for this connector. */
  sessionName: string;
  secrets: string[];
  missingSecrets: string[];
  settings: ConnectorSetting[];
  /** Required config keys with no value, e.g. `gmail-mcp.email_address`. */
  missingSettings: string[];
  /** The name `docker mcp oauth authorize` takes, for OAuth connectors. */
  oauthApp?: string;
  setup: SetupState;
  test?: TestResult;
  status: ConnectorStatus;
};

/** What the last call to Docker said about Docker itself. */
export type DockerState =
  "unknown" | "ready" | "not-running" | "missing" | "error";

export type InstalledState = {
  connectors: InstalledConnector[];
  /** The docker binary the app ran, for starting the gateway in sessions. */
  docker?: string;
  dockerState: DockerState;
  error?: string;
  loading: boolean;
  /** When Docker last answered in this app run, or 0. */
  at: number;
  /** Profiles being tested now. */
  testing: string[];
  /** Profiles waiting for a sign-in in the browser. */
  signingIn: string[];
  /** Config values per profile, as Docker last reported them. Not saved. */
  config: Record<string, Record<string, string>>;
};

type OAuthEntry = { app: string; provider: string; authorized: boolean };

const STORAGE_KEY = "monocode.gatewayConnectors.v2";
const NAMES_KEY = "monocode.gatewayConnectorNames.v1";
const TESTS_KEY = "monocode.gatewayConnectorTests.v1";
const MAX_CONNECTORS = 64;
const MAX_OUTPUT = 4096;
const SESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;
export const TEST_FRESH_MS = 24 * 60 * 60_000;
let signInPollMs = 2_000;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const strings = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === "string")
    : [];

/** What a Docker failure means for the user, in a few words. */
export function classifyDockerError(message: string): DockerState {
  const text = message.toLowerCase();
  if (text.includes("docker cli not found")) return "missing";
  if (
    text.includes("docker desktop is not running") ||
    text.includes("cannot connect to the docker daemon") ||
    text.includes("is the docker daemon running") ||
    text.includes("docker daemon is not running") ||
    text.includes("docker desktop is starting")
  ) {
    return "not-running";
  }
  return "error";
}

export function dockerStateMessage(
  state: DockerState,
  error?: string,
): string | null {
  if (state === "missing")
    return "Docker is not installed. Install Docker Desktop to add connectors.";
  if (state === "not-running")
    return "Docker Desktop is not running. Open it to use connectors.";
  if (state === "error")
    return error
      ? `Docker could not answer: ${error}`
      : "Docker could not answer.";
  return null;
}

/** The MCP server name a session sees by default: the catalog name. */
export function defaultSessionName(server: string): string {
  return server.replace(/[^a-z0-9_-]/g, "-").slice(0, 100);
}

/**
 * The session name for a new connector: the catalog name, or that name with
 * `-gateway` when a server the harnesses already have uses it.
 */
export function pickSessionName(
  server: string,
  taken: ReadonlySet<string>,
): string {
  const name = defaultSessionName(server);
  return taken.has(name) ? `${name.slice(0, 92)}-gateway` : name;
}

/** `profile list --format json`, MonoCode's profiles only, one server each. */
export function parseOwnProfiles(
  value: unknown,
): { profileId: string; server: CatalogConnector }[] {
  if (!Array.isArray(value)) return [];
  const out: { profileId: string; server: CatalogConnector }[] = [];
  for (const entry of value) {
    if (out.length >= MAX_CONNECTORS) break;
    const profile = record(entry);
    const id = typeof profile?.id === "string" ? profile.id : "";
    if (!id.startsWith(OWN_PROFILE_PREFIX)) continue;
    const servers = Array.isArray(profile?.servers) ? profile.servers : [];
    const server = servers.map(trimCatalogEntry).find(Boolean);
    if (server) out.push({ profileId: id, server });
  }
  return out;
}

/** `secret ls --json`: the names of secrets that are set. */
export function parseSecretNames(value: unknown): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(value)) return set;
  for (const entry of value) {
    const name = typeof entry === "string" ? entry : record(entry)?.name;
    if (typeof name === "string" && name) set.add(name);
  }
  return set;
}

/** `oauth ls --json`. */
export function parseOAuthEntries(value: unknown): OAuthEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    const app = typeof item?.app === "string" ? item.app : "";
    if (!app) return [];
    return [
      {
        app,
        provider: typeof item?.provider === "string" ? item.provider : "",
        authorized: item?.authorized === true,
      },
    ];
  });
}

/** `profile config <id> --get-all --format json`: `{key: value}`. */
export function parseConfigValues(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value) ?? {})) {
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") {
      out[key] = String(entry);
    }
  }
  return out;
}

/** The status a connector shows: what setup needs, then the last test. */
export function connectorStatus(
  setup: SetupState,
  test: TestResult | undefined,
): ConnectorStatus {
  if (setup !== "complete") return setup;
  if (!test) return "untested";
  return test.ok ? "ready" : "failed";
}

/**
 * MonoCode's profiles joined with which secrets are set, which config
 * values are set, which OAuth apps are authorized and the last tests. A
 * sign-in is required only when the catalog lists OAuth for the server:
 * `oauth ls` also lists servers that work without one.
 */
export function joinConnectorStatus(input: {
  profiles: { profileId: string; server: CatalogConnector }[];
  secrets: ReadonlySet<string>;
  oauth: readonly OAuthEntry[];
  sessionNames: Readonly<Record<string, string>>;
  /** Config per profile; missing when it could not be read. */
  config?: Readonly<Record<string, Record<string, string> | undefined>>;
  tests?: Readonly<Record<string, TestResult>>;
}): InstalledConnector[] {
  return input.profiles.map(({ profileId, server }) => {
    const matches = input.oauth.filter(
      (entry) =>
        entry.app === server.name ||
        entry.provider === server.name ||
        server.oauthProviders.includes(entry.app) ||
        server.oauthProviders.includes(entry.provider),
    );
    const missingSecrets = server.secrets.filter(
      (name) => !input.secrets.has(name),
    );
    const config = input.config?.[profileId];
    const missingSettings = config
      ? server.settings
          .filter((setting) => setting.required && !config[setting.key])
          .map((setting) => setting.key)
      : [];
    const setup: SetupState =
      server.auth === "oauth" && !matches.some((entry) => entry.authorized)
        ? "needs-sign-in"
        : missingSecrets.length > 0 || missingSettings.length > 0
          ? "needs-setup"
          : "complete";
    const oauthApp = [
      matches[0]?.app,
      server.oauthProviders[0],
      server.name,
    ].find((name): name is string => !!name && isServerName(name));
    const saved = input.sessionNames[profileId];
    const test = input.tests?.[profileId];
    return {
      profileId,
      server: server.name,
      title: server.title,
      description: server.description,
      ...(server.icon ? { icon: server.icon } : {}),
      kind: server.kind,
      ...(server.kind === "container" && server.image
        ? { image: server.image }
        : {}),
      ...(server.kind === "container" && server.noNetwork
        ? { noNetwork: true as const }
        : {}),
      auth: server.auth,
      sessionName:
        saved && SESSION_NAME.test(saved)
          ? saved
          : defaultSessionName(server.name),
      secrets: server.secrets,
      missingSecrets,
      settings: server.settings,
      missingSettings,
      ...(server.auth === "oauth" && oauthApp ? { oauthApp } : {}),
      setup,
      ...(test ? { test } : {}),
      status: connectorStatus(setup, test),
    };
  });
}

function readJson(key: string): unknown {
  try {
    const raw =
      typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best effort
  }
}

function loadSessionNames(): Record<string, string> {
  const saved = record(readJson(NAMES_KEY)) ?? {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(saved)) {
    if (
      id.startsWith(OWN_PROFILE_PREFIX) &&
      typeof name === "string" &&
      SESSION_NAME.test(name)
    ) {
      out[id] = name;
    }
  }
  return out;
}

const CAUSES = new Set<TestCause>([
  "sign-in",
  "setup",
  "platform",
  "docker",
  "network",
  "other",
]);

function loadTests(): Record<string, TestResult> {
  const out: Record<string, TestResult> = {};
  for (const [id, value] of Object.entries(record(readJson(TESTS_KEY)) ?? {})) {
    const item = record(value);
    if (!id.startsWith(OWN_PROFILE_PREFIX) || !item) continue;
    if (typeof item.at !== "number" || typeof item.ok !== "boolean") continue;
    out[id] = {
      at: item.at,
      ok: item.ok,
      tools: typeof item.tools === "number" ? item.tools : 0,
      ...(typeof item.reason === "string"
        ? { reason: item.reason.slice(0, 200) }
        : {}),
      ...(CAUSES.has(item.cause as TestCause)
        ? { cause: item.cause as TestCause }
        : {}),
      output:
        typeof item.output === "string" ? item.output.slice(-MAX_OUTPUT) : "",
    };
  }
  return out;
}

let tests: Record<string, TestResult> = loadTests();

const SETUPS = new Set<SetupState>([
  "complete",
  "needs-sign-in",
  "needs-setup",
]);

function readSavedSettings(value: unknown): ConnectorSetting[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const item = record(entry);
    if (typeof item?.key !== "string" || typeof item.name !== "string") {
      return [];
    }
    return [
      {
        key: item.key,
        name: item.name,
        type: typeof item.type === "string" ? item.type : "string",
        description:
          typeof item.description === "string" ? item.description : "",
        required: item.required === true,
      },
    ];
  });
}

/** The last known list, read back at app start before Docker answers. */
function loadSaved(): InstalledState {
  const saved = record(readJson(STORAGE_KEY));
  const docker =
    typeof saved?.docker === "string" &&
    (saved.docker.startsWith("/") || /^[A-Za-z]:\\/.test(saved.docker))
      ? saved.docker
      : undefined;
  const connectors: InstalledConnector[] = [];
  for (const value of Array.isArray(saved?.connectors)
    ? saved.connectors
    : []) {
    if (connectors.length >= MAX_CONNECTORS) break;
    const item = record(value);
    const server = typeof item?.server === "string" ? item.server : "";
    const profileId = typeof item?.profileId === "string" ? item.profileId : "";
    const sessionName =
      typeof item?.sessionName === "string" ? item.sessionName : "";
    const setup = item?.setup as SetupState;
    if (
      !isServerName(server) ||
      profileId !== connectorProfileId(server) ||
      !SESSION_NAME.test(sessionName) ||
      !SETUPS.has(setup)
    ) {
      continue;
    }
    const auth = item?.auth;
    const oauthApp = typeof item?.oauthApp === "string" ? item.oauthApp : "";
    const test = tests[profileId];
    connectors.push({
      profileId,
      server,
      title:
        typeof item?.title === "string" ? item.title.slice(0, 120) : server,
      description:
        typeof item?.description === "string"
          ? item.description.slice(0, 400)
          : "",
      ...(typeof item?.icon === "string" && item.icon.startsWith("https://")
        ? { icon: item.icon }
        : {}),
      kind: item?.kind === "remote" ? "remote" : "container",
      ...(item?.kind !== "remote" &&
      typeof item?.image === "string" &&
      item.image.length <= 300
        ? { image: item.image }
        : {}),
      ...(item?.kind !== "remote" && item?.noNetwork === true
        ? { noNetwork: true as const }
        : {}),
      auth: auth === "oauth" || auth === "secrets" ? auth : "none",
      sessionName,
      secrets: strings(item?.secrets),
      missingSecrets: strings(item?.missingSecrets),
      settings: readSavedSettings(item?.settings),
      missingSettings: strings(item?.missingSettings),
      ...(isServerName(oauthApp) ? { oauthApp } : {}),
      setup,
      ...(test ? { test } : {}),
      status: connectorStatus(setup, test),
    });
  }
  return {
    connectors,
    ...(docker ? { docker } : {}),
    dockerState: "unknown",
    loading: false,
    at: 0,
    testing: [],
    signingIn: [],
    config: {},
  };
}

let state: InstalledState = loadSaved();
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function set(next: Partial<InstalledState>): void {
  state = { ...state, ...next };
  if (next.connectors || next.docker) {
    writeJson(STORAGE_KEY, {
      // Tests are kept on their own; the list carries no config values.
      connectors: state.connectors.map(
        ({ test: _test, status: _status, ...rest }) => rest,
      ),
      docker: state.docker,
    });
  }
  for (const notify of listeners) notify();
}

export function installedState(): InstalledState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe outside React; returns the unsubscribe. */
export const subscribeInstalled = subscribe;

export function useInstalledConnectors(): InstalledState {
  return useSyncExternalStore(subscribe, installedState, installedState);
}

/** The connector for a catalog server, when it is added. */
export function installedConnector(
  server: string,
): InstalledConnector | undefined {
  return state.connectors.find((connector) => connector.server === server);
}

const parse = (stdout: string): unknown => {
  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
};

/**
 * Asks Docker for MonoCode's profiles, their config values, the secrets
 * that are set and the OAuth apps that are authorized. A failure keeps the
 * last list, and marks Docker as not running or missing when that is the
 * cause.
 */
export function refreshInstalled(): Promise<void> {
  if (inFlight) return inFlight;
  set({ loading: true });
  const run = (async () => {
    try {
      const profiles = await runDockerMcp(profileListArgs());
      const own = parseOwnProfiles(parse(profiles.stdout));
      // Secrets, OAuth and config add detail; a failure there leaves a
      // status less precise rather than hiding the connectors.
      const [secrets, oauth, ...configs] = await Promise.allSettled([
        runDockerMcp(secretListArgs()),
        runDockerMcp(oauthListArgs()),
        ...own.map(({ profileId, server }) =>
          server.settings.length > 0
            ? runDockerMcp(profileConfigGetArgs(profileId))
            : Promise.resolve(null),
        ),
      ]);
      const config: Record<string, Record<string, string>> = {};
      own.forEach(({ profileId }, index) => {
        const result = configs[index];
        if (result?.status === "fulfilled") {
          config[profileId] = result.value
            ? parseConfigValues(parse(result.value.stdout))
            : {};
        }
      });
      const connectors = joinConnectorStatus({
        profiles: own,
        secrets:
          secrets.status === "fulfilled"
            ? parseSecretNames(parse(secrets.value.stdout))
            : new Set(),
        oauth:
          oauth.status === "fulfilled"
            ? parseOAuthEntries(parse(oauth.value.stdout))
            : [],
        sessionNames: loadSessionNames(),
        config,
        tests,
      });
      set({
        connectors,
        config,
        docker: profiles.docker || state.docker,
        dockerState: "ready",
        error: undefined,
        loading: false,
        at: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({
        dockerState: classifyDockerError(message),
        error: message,
        loading: false,
      });
    } finally {
      inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

function saveTest(profileId: string, result: TestResult | undefined): void {
  if (result) tests = { ...tests, [profileId]: result };
  else {
    tests = { ...tests };
    delete tests[profileId];
  }
  writeJson(TESTS_KEY, tests);
  set({
    connectors: state.connectors.map((connector) =>
      connector.profileId === profileId
        ? {
            ...connector,
            ...(result ? { test: result } : { test: undefined }),
            status: connectorStatus(connector.setup, result),
          }
        : connector,
    ),
  });
}

const without = (list: readonly string[], id: string) =>
  list.filter((entry) => entry !== id);

/**
 * Tests one connector with a gateway dry run and keeps the result. Docker
 * not running is reported as Docker's state, not as the connector's.
 */
export async function testConnector(
  connector: Pick<InstalledConnector, "profileId" | "server">,
): Promise<void> {
  const id = connector.profileId;
  if (state.testing.includes(id)) return;
  set({ testing: [...state.testing, id] });
  try {
    let output = "";
    let outcome: ReturnType<typeof parseDryRun> | null = null;
    // A network failure while Docker checks the image is retried once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { stdout, stderr, success } = await runDockerMcp(
        gatewayDryRunArgs(id),
        { timeoutMs: DRY_RUN_TIMEOUT_MS },
      );
      output = [stderr, stdout].filter((part) => part.trim()).join("\n");
      outcome = parseDryRun(output, connector.server, success);
      if (outcome.ok || outcome.cause !== "network") break;
    }
    if (!outcome) return;
    if (!outcome.ok && outcome.cause === "docker") {
      set({ dockerState: "not-running", error: outcome.reason });
      return;
    }
    saveTest(id, {
      at: Date.now(),
      ok: outcome.ok,
      tools: outcome.tools,
      ...(outcome.ok ? {} : { reason: outcome.reason, cause: outcome.cause }),
      output: output.slice(-MAX_OUTPUT),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const docker = classifyDockerError(message);
    if (docker !== "error") {
      set({ dockerState: docker, error: message });
      return;
    }
    saveTest(id, {
      at: Date.now(),
      ok: false,
      tools: 0,
      reason: message.split("\n")[0].slice(0, 160),
      cause: "other",
      output: message.slice(-MAX_OUTPUT),
    });
  } finally {
    set({ testing: without(state.testing, id) });
  }
}

/**
 * Tests every connector whose setup is complete and that has no result, or
 * one older than `maxAgeMs` when given.
 */
export async function testStale(options: { maxAgeMs?: number } = {}) {
  const now = Date.now();
  const due = state.connectors.filter(
    (connector) =>
      connector.setup === "complete" &&
      !state.testing.includes(connector.profileId) &&
      (!connector.test ||
        (options.maxAgeMs !== undefined &&
          now - connector.test.at > options.maxAgeMs)),
  );
  for (const connector of due) await testConnector(connector);
}

/** Adds a catalog server as its own connector profile. */
export async function addConnector(
  entry: Pick<CatalogConnector, "name" | "catalog">,
  taken: ReadonlySet<string> = new Set(),
): Promise<void> {
  const profileId = connectorProfileId(entry.name);
  const used = new Set(taken);
  for (const connector of state.connectors) used.add(connector.sessionName);
  await runDockerMcp(
    profileCreateArgs({
      name: connectorProfileName(entry.name),
      id: profileId,
      servers: [catalogServerRef(entry.name, entry.catalog)],
    }),
  );
  writeJson(NAMES_KEY, {
    ...loadSessionNames(),
    [profileId]: pickSessionName(entry.name, used),
  });
  saveTest(profileId, undefined);
  await refreshInstalled();
}

/**
 * Adds a connector and starts what it needs, as the Claude app does: a
 * sign-in starts in the browser, keys and settings open the setup form
 * (returned as "setup"), and one with nothing to set up is tested.
 */
export async function addAndStart(
  entry: Pick<CatalogConnector, "name" | "catalog">,
  taken: ReadonlySet<string> = new Set(),
  onSignInError: (error: unknown) => void = () => undefined,
): Promise<"signing-in" | "setup" | "tested"> {
  await addConnector(entry, taken);
  const connector = installedConnector(entry.name);
  if (!connector) throw new Error("Docker did not list the new connector");
  if (connector.setup === "needs-sign-in") {
    void signInAndTest(connector).catch(onSignInError);
    return "signing-in";
  }
  if (connector.setup === "needs-setup") return "setup";
  await testConnector(connector);
  return "tested";
}

const signInCancelled = new Set<string>();

/** Stops waiting for a sign-in. The browser tab is the user's to close. */
export function cancelSignIn(profileId: string): void {
  signInCancelled.add(profileId);
  set({ signingIn: without(state.signingIn, profileId) });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function authorized(app: string): Promise<boolean> {
  try {
    const { stdout } = await runDockerMcp(oauthListArgs());
    return parseOAuthEntries(parse(stdout)).some(
      (entry) =>
        (entry.app === app || entry.provider === app) && entry.authorized,
    );
  } catch {
    return false;
  }
}

/**
 * Opens the browser to sign in, then waits: for the authorize call to
 * return, or for `oauth ls` to say the app is authorized, checked every two
 * seconds for up to five minutes. Then tests the connector. Cancel stops the
 * wait; the authorize call itself ends with its own five-minute limit.
 */
export async function signInAndTest(
  connector: Pick<InstalledConnector, "profileId" | "server" | "oauthApp">,
): Promise<"signed-in" | "cancelled"> {
  const app = connector.oauthApp;
  if (!app) throw new Error("This connector has no sign-in");
  const id = connector.profileId;
  signInCancelled.delete(id);
  if (!state.signingIn.includes(id)) {
    set({ signingIn: [...state.signingIn, id] });
  }
  let settled: { error?: unknown } | null = null;
  void runDockerMcp(oauthAuthorizeArgs(app), {
    timeoutMs: OAUTH_TIMEOUT_MS,
  }).then(
    () => (settled = {}),
    (error: unknown) => (settled = { error }),
  );
  const deadline = Date.now() + OAUTH_TIMEOUT_MS;
  try {
    // `oauth authorize` opens the browser and exits at once; Docker Desktop
    // finishes the sign-in when the user approves. Only `oauth ls` says
    // when that happened, so its exit is not the end of the sign-in.
    for (;;) {
      if (signInCancelled.has(id)) return "cancelled";
      if (await authorized(app)) break;
      const done = settled as { error?: unknown } | null;
      if (done?.error) throw done.error;
      if (Date.now() > deadline) throw new Error("Sign-in timed out");
      await sleep(signInPollMs);
    }
  } finally {
    set({ signingIn: without(state.signingIn, id) });
  }
  if (signInCancelled.has(id)) return "cancelled";
  // The approve page leaves the user in the browser; come back to the app.
  await bringAppToFront().catch(() => undefined);
  await refreshInstalled();
  await testConnector(installedConnector(connector.server) ?? connector);
  return "signed-in";
}

/**
 * Saves the setup form: config values with `profile config --set`, each
 * secret on stdin, then tests. Empty fields are left as they are.
 */
export async function saveSetupAndTest(
  connector: Pick<InstalledConnector, "profileId" | "server" | "secrets">,
  values: {
    config: Readonly<Record<string, string>>;
    secrets: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const config = Object.fromEntries(
    Object.entries(values.config).filter(([, value]) => value.trim()),
  );
  if (Object.keys(config).length > 0) {
    await runDockerMcp(
      profileConfigSetArgs(connector.profileId, config, connector.secrets),
    );
  }
  for (const [name, value] of Object.entries(values.secrets)) {
    if (!value) continue;
    if (!connector.secrets.includes(name)) {
      throw new Error(`${name} is not one of this connector's secrets`);
    }
    await runDockerMcp(secretSetArgs(name), {
      stdin: value,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }
  await refreshInstalled();
  const current = installedConnector(connector.server);
  if (current?.setup === "complete") await testConnector(current);
}

/** Removes a connector's profile, and signs it out first when asked. */
export async function removeConnector(
  connector: Pick<InstalledConnector, "profileId" | "oauthApp">,
  options: { signOut?: boolean } = {},
): Promise<void> {
  if (options.signOut && connector.oauthApp) {
    await runDockerMcp(oauthRevokeArgs(connector.oauthApp)).catch(
      () => undefined,
    );
  }
  await runDockerMcp(profileRemoveArgs(connector.profileId));
  const names = loadSessionNames();
  delete names[connector.profileId];
  writeJson(NAMES_KEY, names);
  saveTest(connector.profileId, undefined);
  await refreshInstalled();
}

/**
 * Stores one secret in Docker. The value goes to Docker on stdin and is not
 * kept anywhere in MonoCode.
 */
export async function setConnectorSecret(
  name: string,
  value: string,
): Promise<void> {
  if (!value) throw new Error("Enter a value");
  await runDockerMcp(secretSetArgs(name), {
    stdin: value,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  await refreshInstalled();
}

export async function signOutConnector(
  connector: Pick<InstalledConnector, "profileId" | "oauthApp">,
): Promise<void> {
  if (!connector.oauthApp) return;
  await runDockerMcp(oauthRevokeArgs(connector.oauthApp));
  saveTest(connector.profileId, undefined);
  await refreshInstalled();
}

/** Exported for tests. */
export function __resetInstalled(options: { reload?: boolean } = {}): void {
  inFlight = null;
  signInCancelled.clear();
  if (!options.reload) {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(NAMES_KEY);
      localStorage.removeItem(TESTS_KEY);
    } catch {
      // ignore
    }
  }
  tests = loadTests();
  state = loadSaved();
  for (const notify of listeners) notify();
}

/** Exported for tests: put a list in the store as Docker would. */
export function __setInstalled(next: Partial<InstalledState>): void {
  set(next);
}

/** Exported for tests: how often a sign-in is checked. */
export function __setSignInPollMs(ms: number): void {
  signInPollMs = ms;
}
