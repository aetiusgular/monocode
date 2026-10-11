/**
 * Argument lists for `docker mcp`, in exactly the shapes the app's
 * `docker_mcp` command allows (`src-tauri/src/docker_mcp.rs`). Every builder
 * checks its values with the same patterns and throws on anything else, so a
 * bad value fails here with a clear message instead of in the app.
 */

export const DOCKER_CATALOG = "mcp/docker-mcp-catalog";
/**
 * The user's own catalog for servers Docker's catalog lacks, built from
 * files under `~/.docker/mcp/catalogs/` with `docker mcp catalog create
 * monocode/extra:latest --server file://...`. Optional: it may not exist.
 */
export const EXTRA_CATALOG = "monocode/extra";
export type CatalogName = typeof DOCKER_CATALOG | typeof EXTRA_CATALOG;
const CATALOGS: readonly string[] = [DOCKER_CATALOG, EXTRA_CATALOG];
const CATALOG_REF_PREFIX = `catalog://${DOCKER_CATALOG}/`;
const EXTRA_REF_PREFIX = `catalog://${EXTRA_CATALOG}/`;
/** Profiles MonoCode made. Only these can be created, changed or removed. */
export const OWN_PROFILE_PREFIX = "monocode_";
const MAX_PROFILE_SERVERS = 32;
export const MAX_SECRET_BYTES = 16 * 1024;

const PROFILE_ID = /^[a-z0-9_]{1,64}$/;
const SERVER_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SECRET_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export const isProfileId = (value: string): boolean => PROFILE_ID.test(value);
export const isOwnProfileId = (value: string): boolean =>
  isProfileId(value) &&
  value.startsWith(OWN_PROFILE_PREFIX) &&
  value.length > OWN_PROFILE_PREFIX.length;
export const isServerName = (value: string): boolean => SERVER_NAME.test(value);
export const isSecretName = (value: string): boolean => SECRET_NAME.test(value);

const CONFIG_KEY = /^[a-z0-9][a-z0-9._-]{0,99}\.[A-Za-z0-9_]{1,64}$/;
/** Property names the app refuses as config: credentials go to secrets. */
const SECRET_LIKE = /token|secret|password|passwd|apikey|api_key|private_key/i;
const MAX_CONFIG_SETS = 64;
export const MAX_CONFIG_VALUE_CHARS = 1000;

/** `<server>.<property>`, where the property is not named like a credential. */
export function isConfigKey(value: string): boolean {
  if (!CONFIG_KEY.test(value)) return false;
  const property = value.slice(value.lastIndexOf(".") + 1);
  return !SECRET_LIKE.test(property);
}

export function isConfigValue(value: string): boolean {
  return [...value].length <= MAX_CONFIG_VALUE_CHARS && !/[\n\r\0]/.test(value);
}

/** Only catalog refs are built here; the app also takes server files. */
export const isCatalogServerRef = (value: string): boolean =>
  [CATALOG_REF_PREFIX, EXTRA_REF_PREFIX].some(
    (prefix) =>
      value.startsWith(prefix) && isServerName(value.slice(prefix.length)),
  );

function check(ok: boolean, what: string, value: string): void {
  if (!ok) throw new Error(`Not a valid ${what}: ${JSON.stringify(value)}`);
}

/** The catalog ref for one server. */
export function catalogServerRef(
  server: string,
  catalog: CatalogName = DOCKER_CATALOG,
): string {
  check(isServerName(server), "server name", server);
  check(CATALOGS.includes(catalog), "catalog", catalog);
  return `catalog://${catalog}/${server}`;
}

/** MonoCode's profile id for a connector: one profile per catalog server. */
export function connectorProfileId(server: string): string {
  const slug = server.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `${OWN_PROFILE_PREFIX}${slug}`.slice(0, 64);
}

/** The profile's display name, kept to the server-name pattern. */
export function connectorProfileName(server: string): string {
  return `monocode-${server}`.slice(0, 100);
}

export const versionArgs = (): string[] => ["mcp", "version"];

export function catalogShowArgs(
  catalog: CatalogName = DOCKER_CATALOG,
): string[] {
  check(CATALOGS.includes(catalog), "catalog", catalog);
  return ["mcp", "catalog", "show", catalog, "--format", "json"];
}

export const catalogPullArgs = (): string[] => [
  "mcp",
  "catalog",
  "pull",
  DOCKER_CATALOG,
];

export const profileListArgs = (): string[] => [
  "mcp",
  "profile",
  "list",
  "--format",
  "json",
];

export function profileShowArgs(id: string): string[] {
  check(isProfileId(id), "profile id", id);
  return ["mcp", "profile", "show", id, "--format", "json"];
}

export function profileCreateArgs(input: {
  name: string;
  id: string;
  servers: readonly string[];
}): string[] {
  check(isServerName(input.name), "profile name", input.name);
  check(isOwnProfileId(input.id), "MonoCode profile id", input.id);
  if (
    input.servers.length === 0 ||
    input.servers.length > MAX_PROFILE_SERVERS
  ) {
    throw new Error("A profile needs 1 to 32 servers");
  }
  const args = [
    "mcp",
    "profile",
    "create",
    "--name",
    input.name,
    "--id",
    input.id,
  ];
  for (const ref of input.servers) {
    check(isCatalogServerRef(ref), "server ref", ref);
    args.push("--server", ref);
  }
  return args;
}

export function profileRemoveArgs(id: string): string[] {
  check(isOwnProfileId(id), "MonoCode profile id", id);
  return ["mcp", "profile", "remove", id];
}

export function profileServerAddArgs(id: string, ref: string): string[] {
  check(isOwnProfileId(id), "MonoCode profile id", id);
  check(isCatalogServerRef(ref), "server ref", ref);
  return ["mcp", "profile", "server", "add", id, "--server", ref];
}

export function profileServerRemoveArgs(id: string, server: string): string[] {
  check(isOwnProfileId(id), "MonoCode profile id", id);
  check(isServerName(server), "server name", server);
  return ["mcp", "profile", "server", "remove", id, server];
}

/**
 * Sets config values on a MonoCode profile. A key whose property is also
 * one of the server's secret names is refused: that value belongs in the
 * secret store, not in plain profile config.
 */
export function profileConfigSetArgs(
  id: string,
  values: Readonly<Record<string, string>>,
  secretNames: readonly string[] = [],
): string[] {
  check(isOwnProfileId(id), "MonoCode profile id", id);
  const entries = Object.entries(values);
  if (entries.length === 0 || entries.length > MAX_CONFIG_SETS) {
    throw new Error("Set 1 to 64 values at a time");
  }
  const secretProps = new Set(
    secretNames.map((name) => name.slice(name.lastIndexOf(".") + 1)),
  );
  const args = ["mcp", "profile", "config", id];
  for (const [key, value] of entries) {
    check(isConfigKey(key), "config key", key);
    const property = key.slice(key.lastIndexOf(".") + 1);
    if (secretProps.has(property) || secretNames.includes(key)) {
      throw new Error(`${key} is a secret. Save it as a secret instead.`);
    }
    if (!isConfigValue(value)) {
      throw new Error(
        `The value for ${key} must be one line of at most 1000 characters`,
      );
    }
    args.push("--set", `${key}=${value}`);
  }
  return args;
}

export function profileConfigGetArgs(id: string): string[] {
  check(isOwnProfileId(id), "MonoCode profile id", id);
  return ["mcp", "profile", "config", id, "--get-all", "--format", "json"];
}

export function profileConfigDelArgs(id: string, key: string): string[] {
  check(isOwnProfileId(id), "MonoCode profile id", id);
  check(isConfigKey(key), "config key", key);
  return ["mcp", "profile", "config", id, "--del", key];
}

/**
 * The connector test: the gateway lists the profile's servers and their
 * tools, then exits. It may pull an image first; it never starts a server
 * for use.
 */
export function gatewayDryRunArgs(id: string): string[] {
  check(isOwnProfileId(id), "MonoCode profile id", id);
  return ["mcp", "gateway", "run", "--profile", id, "--dry-run", "--verbose"];
}

export const secretListArgs = (): string[] => ["mcp", "secret", "ls", "--json"];

/** The value goes on stdin, never on the command line. */
export function secretSetArgs(name: string): string[] {
  check(isSecretName(name) && !name.includes("="), "secret name", name);
  return ["mcp", "secret", "set", name];
}

export function secretRemoveArgs(name: string): string[] {
  check(isSecretName(name), "secret name", name);
  return ["mcp", "secret", "rm", name];
}

export const oauthListArgs = (): string[] => ["mcp", "oauth", "ls", "--json"];

export function oauthAuthorizeArgs(app: string): string[] {
  check(isServerName(app), "OAuth app name", app);
  return ["mcp", "oauth", "authorize", app, "--open-browser"];
}

export function oauthRevokeArgs(app: string): string[] {
  check(isServerName(app), "OAuth app name", app);
  return ["mcp", "oauth", "revoke", app];
}

/**
 * The command a harness runs to reach one connector: the gateway serving
 * that connector's profile over stdio. Not run through the app's command.
 */
export function gatewayRunArgs(profileId: string): string[] {
  check(isProfileId(profileId), "profile id", profileId);
  return ["mcp", "gateway", "run", "--profile", profileId];
}

/** The longest each kind of call may run, as the app caps it. */
export const OAUTH_TIMEOUT_MS = 300_000;
export const DRY_RUN_TIMEOUT_MS = 180_000;
export const CATALOG_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * True for an argument list the app's command would run, with `stdin` only
 * for `secret set`. Mirrors the Rust allowlist for catalog refs; the app also
 * takes `file://` refs under `~/.docker/mcp/catalogs/`, which nothing here
 * builds.
 */
export function isAllowedDockerMcpCall(
  args: readonly string[],
  stdin?: string,
): boolean {
  const shape = allowedShape(args);
  if (!shape) return false;
  const secretSet = shape === "secret-set";
  if (secretSet) {
    return (
      typeof stdin === "string" &&
      stdin.length > 0 &&
      new TextEncoder().encode(stdin).length <= MAX_SECRET_BYTES
    );
  }
  return stdin === undefined;
}

function allowedShape(args: readonly string[]): string | null {
  const [mcp, group, verb, ...rest] = args;
  if (mcp !== "mcp") return null;
  const is = (...expected: string[]) =>
    args.length === expected.length + 1 &&
    expected.every(
      (value, index) => value === "*" || args[index + 1] === value,
    );
  if (group === "version" && args.length === 2) return "version";
  if (group === "catalog") {
    if (
      is("catalog", "show", "*", "--format", "json") &&
      CATALOGS.includes(args[3])
    )
      return "catalog-show";
    if (is("catalog", "pull", DOCKER_CATALOG)) return "catalog-pull";
    return null;
  }
  if (group === "profile") {
    if (is("profile", "list", "--format", "json")) return "profile-list";
    if (is("profile", "show", "*", "--format", "json"))
      return isProfileId(args[3]) ? "profile-show" : null;
    if (is("profile", "remove", "*"))
      return isOwnProfileId(args[3]) ? "profile-remove" : null;
    if (verb === "create") {
      const [nameFlag, name, idFlag, id, ...servers] = rest;
      const ok =
        nameFlag === "--name" &&
        isServerName(name ?? "") &&
        idFlag === "--id" &&
        isOwnProfileId(id ?? "") &&
        servers.length > 0 &&
        servers.length % 2 === 0 &&
        servers.length <= MAX_PROFILE_SERVERS * 2 &&
        servers.every((value, index) =>
          index % 2 === 0 ? value === "--server" : isCatalogServerRef(value),
        );
      return ok ? "profile-create" : null;
    }
    if (is("profile", "server", "add", "*", "--server", "*"))
      return isOwnProfileId(args[4]) && isCatalogServerRef(args[6])
        ? "profile-server-add"
        : null;
    if (is("profile", "server", "remove", "*", "*"))
      return isOwnProfileId(args[4]) && isServerName(args[5])
        ? "profile-server-remove"
        : null;
    if (verb === "config" && isOwnProfileId(args[3] ?? "")) {
      const tail = args.slice(4);
      if (is("profile", "config", "*", "--get-all", "--format", "json"))
        return "profile-config-get";
      if (is("profile", "config", "*", "--del", "*"))
        return isConfigKey(args[5]) ? "profile-config-del" : null;
      const ok =
        tail.length > 0 &&
        tail.length % 2 === 0 &&
        tail.length <= MAX_CONFIG_SETS * 2 &&
        tail.every((value, index) => {
          if (index % 2 === 0) return value === "--set";
          const at = value.indexOf("=");
          return (
            at > 0 &&
            isConfigKey(value.slice(0, at)) &&
            isConfigValue(value.slice(at + 1))
          );
        });
      return ok ? "profile-config-set" : null;
    }
    return null;
  }
  if (group === "gateway") {
    return is("gateway", "run", "--profile", "*", "--dry-run", "--verbose") &&
      isOwnProfileId(args[4])
      ? "gateway-dry-run"
      : null;
  }
  if (group === "secret") {
    if (is("secret", "ls", "--json")) return "secret-list";
    if (is("secret", "set", "*"))
      return isSecretName(args[3]) && !args[3].includes("=")
        ? "secret-set"
        : null;
    if (is("secret", "rm", "*"))
      return isSecretName(args[3]) ? "secret-rm" : null;
    return null;
  }
  if (group === "oauth") {
    if (is("oauth", "ls", "--json")) return "oauth-list";
    if (is("oauth", "authorize", "*", "--open-browser"))
      return isServerName(args[3]) ? "oauth-authorize" : null;
    if (is("oauth", "revoke", "*"))
      return isServerName(args[3]) ? "oauth-revoke" : null;
    return null;
  }
  return null;
}
