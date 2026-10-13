import type { Locality } from "./locality";
import { loadServerMarks, sanitizeServerName, type ServerMark } from "./serverMarks";
import {
  installedState,
  type InstalledConnector,
} from "../../gateway-connectors/model/installed";

/** What Docker's catalog says about a gateway connector. */
export type GatewayFacts = {
  kind: "remote" | "container";
  /** Catalog server name, e.g. `time`. */
  server: string;
  image?: string;
  /** The catalog runs the container with no network. */
  noNetwork?: boolean;
};

/** The fields an MCP server locality decision may read. */
export type LocalityServer = {
  name: string;
  /** Program a stdio server runs. */
  command?: string;
  args?: readonly string[];
  /** Address of an HTTP server. */
  url?: string;
  /** Catalog facts for a Docker gateway connector, when known. */
  gateway?: GatewayFacts;
};

/**
 * Catalog servers known to make no outbound call, by server name and image.
 * `time` reads the clock and the time zone database inside its container.
 */
const KNOWN_LOCAL_IMAGES: Readonly<Record<string, string>> = {
  time: "mcp/time",
};

function imageIs(image: string | undefined, repository: string): boolean {
  if (!image) return false;
  if (image === repository) return true;
  return image.startsWith(`${repository}:`) || image.startsWith(`${repository}@`);
}

export function gatewayFactsOf(connector: Pick<InstalledConnector, "kind" | "server" | "image" | "noNetwork">): GatewayFacts {
  return {
    kind: connector.kind,
    server: connector.server,
    ...(connector.image ? { image: connector.image } : {}),
    ...(connector.noNetwork ? { noNetwork: true } : {}),
  };
}

/** The server a gateway connector is, for a locality decision. */
export function gatewayLocalityServer(
  connector: Pick<InstalledConnector, "sessionName" | "profileId" | "kind" | "server" | "image" | "noNetwork">,
): LocalityServer {
  return {
    name: connector.sessionName,
    command: "docker",
    args: ["mcp", "gateway", "run", "--profile", connector.profileId],
    gateway: gatewayFactsOf(connector),
  };
}

/**
 * The server a connector row stands for, by name: an added gateway connector
 * first (with its catalog facts), then what the harness reported. The
 * composer's list, the privacy panel and the session's locality all decide
 * from this, so a row reads the same while a turn runs and while it does not
 * (Mac finding 12.8: `shopify-remote` once showed Local mid-turn).
 */
export function connectorLocalityServer(
  name: string,
  reported?: { command?: string; args?: readonly string[]; url?: string },
  connectors: readonly InstalledConnector[] = safeConnectors(),
): LocalityServer {
  const gateway = connectors.find((item) => item.sessionName === name);
  if (gateway) return gatewayLocalityServer(gateway);
  return {
    name,
    ...(reported?.command ? { command: reported.command } : {}),
    ...(reported?.args?.length ? { args: [...reported.args] } : {}),
    ...(reported?.url ? { url: reported.url } : {}),
  };
}

function safeConnectors(): readonly InstalledConnector[] {
  try {
    return installedState().connectors;
  } catch {
    return [];
  }
}

/**
 * The catalog facts for a server: given on it, or looked up among the added
 * connectors by the gateway profile in its arguments, then by its name.
 */
function gatewayFacts(server: LocalityServer): GatewayFacts | undefined {
  if (server.gateway) return server.gateway;
  const docker = !!server.command && baseName(server.command) === "docker";
  if (!docker) return undefined;
  const args = server.args ?? [];
  const at = args.indexOf("--profile");
  const profile = at >= 0 ? args[at + 1] : undefined;
  const connectors = safeConnectors();
  const found =
    (profile ? connectors.find((item) => item.profileId === profile) : undefined) ??
    connectors.find((item) => item.sessionName === server.name);
  return found ? gatewayFactsOf(found) : undefined;
}

/** Why a server got its locality, for the label next to it. */
export type LocalityReason =
  | "your-mark"
  | "remote-address"
  | "loopback-address"
  | "docker-gateway"
  | "remote-connector"
  | "no-network"
  | "known-local"
  | "docker-container"
  | "remote-argument"
  | "not-marked";

export type ServerLocalityResult = {
  locality: Locality;
  reason: LocalityReason;
};

/**
 * Whether a URL names this machine. Parsed with `URL`, never by prefix, so
 * `http://localhost:@other.host/` is the host it names (other.host).
 * Returns undefined when the text is not an http(s) or ws(s) address.
 */
export function isLoopbackUrl(text: string): boolean | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) return undefined;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return undefined;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

function baseName(command: string): string {
  const parts = command.trim().split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").replace(/\.exe$/i, "").toLowerCase();
}

/** A server MonoCode or `docker mcp client connect` starts through the gateway. */
export function isDockerGateway(server: LocalityServer): boolean {
  if (!server.command || baseName(server.command) !== "docker") return false;
  const args = server.args ?? [];
  const mcp = args.indexOf("mcp");
  return mcp >= 0 && args[mcp + 1] === "gateway";
}

/**
 * Whether an MCP server keeps what it is given on this Mac, with the reason.
 * One rule for every place a server's mark is shown or used: the composer's
 * connector list, the privacy panel and the session's locality.
 *
 * - A server that calls a hosted service is hosted, so facts that say so
 *   win over your mark: an HTTP server at a non-loopback address, and a
 *   gateway connector of the catalog's remote type.
 * - Your "hosted" mark always wins. Your "local" mark wins where MonoCode
 *   cannot tell.
 * - A gateway container the catalog runs with no network, or one known to
 *   make no outbound call (`time`), is local.
 * - Any other gateway container is unknown: it runs in Docker and may reach
 *   the network.
 * - A gateway entry with no catalog facts is hosted: a profile is hosted if
 *   any server in it is.
 * - A stdio server given a non-loopback address (`mcp-remote`, a proxy) is
 *   hosted.
 * - Anything else, a loopback server included, is unknown until you mark it.
 *   A process on the Mac can still call a hosted API.
 */
export function describeServerLocality(
  server: LocalityServer,
  marks: Record<string, ServerMark> = loadServerMarks(),
): ServerLocalityResult {
  const name = sanitizeServerName(server.name);
  const mark = name ? marks[name] : undefined;
  if (server.url && isLoopbackUrl(server.url) === false) {
    return { locality: "hosted", reason: "remote-address" };
  }
  const facts = gatewayFacts(server);
  if (facts?.kind === "remote") {
    return { locality: "hosted", reason: "remote-connector" };
  }
  if (mark) return { locality: mark, reason: "your-mark" };
  if (server.url && isLoopbackUrl(server.url) === true) {
    return { locality: "unknown", reason: "loopback-address" };
  }
  if (facts) {
    if (facts.noNetwork) return { locality: "local", reason: "no-network" };
    const known = KNOWN_LOCAL_IMAGES[facts.server];
    if (known && imageIs(facts.image, known)) {
      return { locality: "local", reason: "known-local" };
    }
    return { locality: "unknown", reason: "docker-container" };
  }
  if (isDockerGateway(server)) {
    return { locality: "hosted", reason: "docker-gateway" };
  }
  for (const arg of server.args ?? []) {
    if (isLoopbackUrl(arg) === false) {
      return { locality: "hosted", reason: "remote-argument" };
    }
  }
  return { locality: "unknown", reason: "not-marked" };
}

/** Whether your mark can change a server's locality: not where the facts say hosted. */
export function localityMarkable(result: ServerLocalityResult): boolean {
  return result.reason !== "remote-address" && result.reason !== "remote-connector";
}

/**
 * Whether an MCP server keeps what it is given on this Mac. "unknown" counts
 * as hosted everywhere.
 */
export function serverLocality(server: LocalityServer): Locality {
  return describeServerLocality(server).locality;
}

/** Short words for a server's locality, for a label beside its name. */
export function localityLabel(result: ServerLocalityResult): string {
  switch (result.locality) {
    case "local":
      return "Local";
    case "hosted":
      return "Hosted";
    default:
      return result.reason === "docker-container" ? "May reach network" : "Not marked";
  }
}

/** One line on why, for a tooltip. */
export function localityExplanation(result: ServerLocalityResult): string {
  switch (result.reason) {
    case "your-mark":
      return result.locality === "local"
        ? "You marked this server local."
        : "You marked this server hosted.";
    case "remote-address":
      return "Its address is not on this Mac.";
    case "loopback-address":
      return "It listens on this Mac, but it may call a hosted service. Mark it if you know.";
    case "docker-gateway":
      return "A Docker gateway connector. Its containers can reach the network. Mark it local if you know it is.";
    case "remote-connector":
      return "A hosted connector. The service runs it, not this Mac.";
    case "no-network":
      return "Runs in Docker with no network.";
    case "known-local":
      return "Runs in Docker and makes no outbound call.";
    case "docker-container":
      return "Runs in Docker, may reach the network. Counts as hosted until you mark it.";
    case "remote-argument":
      return "It is given an address that is not on this Mac.";
    default:
      return "Not known. Counts as hosted until you mark it.";
  }
}
