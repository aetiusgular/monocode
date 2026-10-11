import { useSyncExternalStore } from "react";
import { runDockerMcp } from "../../../platform/tauri/dockerMcp";
import {
  CATALOG_TIMEOUT_MS,
  EXTRA_CATALOG,
  catalogPullArgs,
  catalogShowArgs,
  isConfigKey,
  isServerName,
} from "./dockerArgs";

export type ConnectorAuth = "oauth" | "secrets" | "none";

/**
 * One config value a server reads, from the catalog's `config` schema. Set
 * with `docker mcp profile config <profile> --set <key>=<value>`. Not a
 * secret: secrets are separate and go to Docker's secret store.
 */
export type ConnectorSetting = {
  /** `<config block>.<property>`, e.g. `gmail-mcp.email_address`. */
  key: string;
  name: string;
  type: string;
  description: string;
  required: boolean;
};

/** One server from Docker's MCP catalog, trimmed to what the UI shows. */
export type CatalogConnector = {
  name: string;
  title: string;
  description: string;
  icon?: string;
  /** Hosted by the service, or a container Docker runs on this machine. */
  kind: "remote" | "container";
  auth: ConnectorAuth;
  /** Secret names the server reads, e.g. `github.personal_access_token`. */
  secrets: string[];
  /**
   * OAuth provider names, e.g. `notion-remote`. Non-empty only when the
   * catalog says the server needs a sign-in.
   */
  oauthProviders: string[];
  /** Config values, required ones first. */
  settings: ConnectorSetting[];
  remoteUrl?: string;
  image?: string;
  category?: string;
  tags: string[];
  tools: string[];
  /**
   * Set when the entry comes from the user's own catalog (`monocode/extra`)
   * instead of Docker's.
   */
  catalog?: typeof EXTRA_CATALOG;
  /**
   * Tagged `community`: Docker's gateway signs in itself with a callback on
   * 127.0.0.1 instead of through Docker Desktop's mcp.docker.com callback,
   * which services such as Vercel refuse.
   */
  community?: boolean;
};

const MAX_ENTRIES = 1000;
const MAX_TOOLS = 100;
const MAX_TAGS = 12;
const MAX_TEXT = 400;
const STORAGE_KEY = "monocode.gatewayCatalog.v2";
const MAX_SETTINGS = 32;
/** The trimmed catalog is about 200 KB; refuse to keep anything far larger. */
const MAX_STORED_CHARS = 2_000_000;
const DAY_MS = 24 * 60 * 60_000;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown, max = MAX_TEXT): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const httpsUrl = (value: unknown): string | undefined => {
  const url = text(value, 2000);
  return /^https:\/\/[^\s]+$/i.test(url) ? url : undefined;
};

function names(value: unknown, key: string, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= max) break;
    const name =
      typeof entry === "string"
        ? entry.trim()
        : text(record(entry)?.[key], 200);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The server object of one catalog entry, in either shape Docker prints. */
function serverOf(entry: unknown): Record<string, unknown> | undefined {
  const item = record(entry);
  const snapshot = record(record(item?.snapshot)?.server);
  return snapshot ?? item;
}

/**
 * The catalog's `config` schema as a flat list: `[{name, properties,
 * required}]` per block. A key the app would refuse (a property named like a
 * credential) is left out.
 */
export function trimSettings(
  value: unknown,
  server: string,
): ConnectorSetting[] {
  if (!Array.isArray(value)) return [];
  const out: ConnectorSetting[] = [];
  for (const block of value) {
    const item = record(block);
    const blockName = text(item?.name, 100) || server;
    const properties = record(item?.properties) ?? {};
    const required = new Set(
      Array.isArray(item?.required)
        ? item.required.filter(
            (name): name is string => typeof name === "string",
          )
        : [],
    );
    for (const [name, schema] of Object.entries(properties)) {
      if (out.length >= MAX_SETTINGS) break;
      const key = `${blockName}.${name}`;
      if (!isConfigKey(key) || out.some((entry) => entry.key === key)) continue;
      const property = record(schema);
      out.push({
        key,
        name,
        type: text(property?.type, 20) || "string",
        description: text(property?.description, 300),
        required: required.has(name),
      });
    }
  }
  return out.sort((a, b) => Number(b.required) - Number(a.required));
}

function readSavedSettings(value: unknown): ConnectorSetting[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SETTINGS).flatMap((entry) => {
    const item = record(entry);
    const key = text(item?.key, 200);
    const name = text(item?.name, 64);
    if (!isConfigKey(key) || !key.endsWith(`.${name}`)) return [];
    return [
      {
        key,
        name,
        type: text(item?.type, 20) || "string",
        description: text(item?.description, 300),
        required: item?.required === true,
      },
    ];
  });
}

/** One catalog entry trimmed, or null when it has no usable name. */
export function trimCatalogEntry(entry: unknown): CatalogConnector | null {
  const item = record(entry);
  const server = serverOf(entry);
  if (!server) return null;
  const name = text(server.name, 100);
  if (!isServerName(name)) return null;
  const type = text(server.type ?? item?.type, 40);
  const remote = record(server.remote);
  const remoteUrl = httpsUrl(remote?.url);
  const kind: CatalogConnector["kind"] =
    type === "remote" || (type !== "server" && remoteUrl)
      ? "remote"
      : "container";
  const oauthProviders = names(record(server.oauth)?.providers, "provider", 8);
  const secrets = names(server.secrets, "name", 16);
  const metadata = record(server.metadata);
  const image = text(server.image ?? item?.image, 300) || undefined;
  const category = text(metadata?.category, 60) || undefined;
  return {
    name,
    title: text(server.title, 120) || name,
    description: text(server.description),
    ...(httpsUrl(server.icon) ? { icon: httpsUrl(server.icon) } : {}),
    kind,
    auth:
      oauthProviders.length > 0
        ? "oauth"
        : secrets.length > 0
          ? "secrets"
          : "none",
    secrets,
    oauthProviders,
    settings: trimSettings(server.config, name),
    ...(kind === "remote" && remoteUrl ? { remoteUrl } : {}),
    ...(kind === "container" && image ? { image } : {}),
    ...(category ? { category } : {}),
    tags: names(metadata?.tags, "name", MAX_TAGS),
    tools: names(server.tools, "name", MAX_TOOLS),
    ...(names(metadata?.tags, "name", MAX_TAGS).includes("community")
      ? { community: true }
      : {}),
  };
}

/**
 * The catalog as `docker mcp catalog show --format json` prints it, trimmed
 * and sorted by title. Takes `{servers: [...]}`, `{servers: {name: ...}}` or
 * a bare list, and skips entries it cannot read.
 */
export function trimCatalog(value: unknown): CatalogConnector[] {
  const root = record(value);
  const servers = Array.isArray(value)
    ? value
    : Array.isArray(root?.servers)
      ? root.servers
      : record(root?.servers)
        ? Object.entries(record(root?.servers) ?? {}).map(([name, entry]) => ({
            name,
            ...record(entry),
          }))
        : [];
  const byName = new Map<string, CatalogConnector>();
  for (const entry of servers) {
    if (byName.size >= MAX_ENTRIES) break;
    const trimmed = trimCatalogEntry(entry);
    if (trimmed && !byName.has(trimmed.name)) byName.set(trimmed.name, trimmed);
  }
  return [...byName.values()].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
}

/** Which readable words a connector needs before it works. */
/**
 * Catalog servers left out of Discover because their sign-in cannot work
 * through Docker (checked 2026-10-10): grafbase and waystation fail Docker's
 * OAuth discovery (404 and 402), and morningstar-mcp-server sends the sign-in
 * to claude.ai. One already added still shows under Yours.
 */
export const HIDDEN_FROM_DISCOVER: ReadonlySet<string> = new Set([
  "grafbase",
  "waystation",
  "morningstar-mcp-server",
]);

export function connectorNeeds(
  entry: Pick<CatalogConnector, "auth" | "kind"> & {
    settings?: readonly ConnectorSetting[];
  },
): string {
  if (entry.auth === "oauth") return "Sign in";
  if (entry.auth === "secrets") return "API key";
  if (entry.settings?.some((setting) => setting.required)) return "Settings";
  return entry.kind === "container" ? "Runs in Docker" : "No setup";
}

/** True when adding the connector should open its setup form. */
export function needsSetupForm(
  entry: Pick<CatalogConnector, "secrets" | "settings">,
): boolean {
  return (
    entry.secrets.length > 0 ||
    entry.settings.some((setting) => setting.required)
  );
}

export type CatalogState = {
  connectors: CatalogConnector[] | null;
  /** When the catalog was last read from Docker, or 0. */
  at: number;
  loading: boolean;
  error?: string;
};

let state: CatalogState = loadSaved();
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** One entry as `save` wrote it, checked again: storage can be edited. */
function readSavedEntry(value: unknown): CatalogConnector | null {
  const entry = record(value);
  const name = text(entry?.name, 100);
  if (!entry || !isServerName(name)) return null;
  const kind = entry.kind === "remote" ? "remote" : "container";
  const auth: ConnectorAuth =
    entry.auth === "oauth" || entry.auth === "secrets" ? entry.auth : "none";
  const icon = httpsUrl(entry.icon);
  const remoteUrl = httpsUrl(entry.remoteUrl);
  const image = text(entry.image, 300);
  const category = text(entry.category, 60);
  return {
    name,
    title: text(entry.title, 120) || name,
    description: text(entry.description),
    ...(icon ? { icon } : {}),
    kind,
    auth,
    secrets: names(entry.secrets, "name", 16),
    oauthProviders: names(entry.oauthProviders, "provider", 8),
    settings: readSavedSettings(entry.settings),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(image ? { image } : {}),
    ...(category ? { category } : {}),
    tags: names(entry.tags, "name", MAX_TAGS),
    tools: names(entry.tools, "name", MAX_TOOLS),
    ...(entry.catalog === EXTRA_CATALOG ? { catalog: EXTRA_CATALOG } : {}),
    ...(entry.community === true ? { community: true } : {}),
  };
}

function loadSaved(): CatalogState {
  try {
    const raw =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(STORAGE_KEY);
    const parsed = record(raw ? JSON.parse(raw) : null);
    if (!parsed || !Array.isArray(parsed.connectors)) {
      return { connectors: null, at: 0, loading: false };
    }
    const connectors = parsed.connectors
      .map(readSavedEntry)
      .filter((entry): entry is CatalogConnector => entry !== null)
      .slice(0, MAX_ENTRIES);
    const at = typeof parsed.at === "number" ? parsed.at : 0;
    return { connectors, at, loading: false };
  } catch {
    return { connectors: null, at: 0, loading: false };
  }
}

function save(connectors: CatalogConnector[], at: number): void {
  try {
    const raw = JSON.stringify({ at, connectors });
    if (raw.length > MAX_STORED_CHARS) return;
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // private mode or full storage: the catalog is read again next time
  }
}

function set(next: Partial<CatalogState>): void {
  state = { ...state, ...next };
  for (const notify of listeners) notify();
}

export function catalogState(): CatalogState {
  return state;
}

/**
 * The user's own catalog, or nothing when it does not exist or cannot be
 * read: it is optional and must not break Docker's.
 */
async function readExtraCatalog(): Promise<CatalogConnector[]> {
  try {
    const { stdout } = await runDockerMcp(catalogShowArgs(EXTRA_CATALOG), {
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    return trimCatalog(JSON.parse(stdout)).map((entry) => ({
      ...entry,
      catalog: EXTRA_CATALOG,
    }));
  } catch {
    return [];
  }
}

/** Docker's catalog with the user's own on top; a same-name entry is theirs. */
export function mergeCatalogs(
  docker: readonly CatalogConnector[],
  extra: readonly CatalogConnector[],
): CatalogConnector[] {
  const own = new Set(extra.map((entry) => entry.name));
  return [...docker.filter((entry) => !own.has(entry.name)), ...extra].sort(
    (a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
}

async function readCatalog(): Promise<CatalogConnector[]> {
  const { stdout } = await runDockerMcp(catalogShowArgs(), {
    timeoutMs: CATALOG_TIMEOUT_MS,
  });
  return mergeCatalogs(
    trimCatalog(JSON.parse(stdout)),
    await readExtraCatalog(),
  );
}

/**
 * Reads the catalog from Docker unless it was read in the last day. `force`
 * pulls the latest catalog first. A first read that fails pulls once and
 * tries again, for a machine that never pulled it.
 */
export function loadCatalog(options: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  if (!options.force && state.connectors && Date.now() - state.at < DAY_MS) {
    return Promise.resolve();
  }
  set({ loading: true, error: undefined });
  const run = (async () => {
    try {
      let connectors: CatalogConnector[];
      if (options.force) {
        await runDockerMcp(catalogPullArgs(), {
          timeoutMs: CATALOG_TIMEOUT_MS,
        });
        connectors = await readCatalog();
      } else {
        try {
          connectors = await readCatalog();
        } catch (error) {
          if (state.connectors) throw error;
          await runDockerMcp(catalogPullArgs(), {
            timeoutMs: CATALOG_TIMEOUT_MS,
          });
          connectors = await readCatalog();
        }
      }
      const at = Date.now();
      save(connectors, at);
      set({ connectors, at, loading: false, error: undefined });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/** The catalog entry for a server name, when the catalog is loaded. */
export function catalogEntry(name: string): CatalogConnector | undefined {
  return state.connectors?.find((entry) => entry.name === name);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCatalog(): CatalogState {
  return useSyncExternalStore(subscribe, catalogState, catalogState);
}

/** Exported for tests. */
export function __resetCatalog(options: { reload?: boolean } = {}): void {
  inFlight = null;
  if (!options.reload) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  state = loadSaved();
  for (const notify of listeners) notify();
}
