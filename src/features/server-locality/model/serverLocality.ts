import type { Locality } from "./locality";
import { loadServerMarks, sanitizeServerName, type ServerMark } from "./serverMarks";

/** The fields an MCP server locality decision may read. */
export type LocalityServer = {
  name: string;
  /** Program a stdio server runs. */
  command?: string;
  args?: readonly string[];
  /** Address of an HTTP server. */
  url?: string;
};

/** Why a server got its locality, for the label next to it. */
export type LocalityReason =
  | "your-mark"
  | "remote-address"
  | "loopback-address"
  | "docker-gateway"
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
 *
 * - Your mark wins.
 * - An HTTP server at a non-loopback address is hosted.
 * - A stdio server given a non-loopback address (`mcp-remote`, a proxy) is
 *   hosted.
 * - A Docker gateway entry is hosted: a profile is hosted if any server in it
 *   is, and its containers have the network unless the entry says otherwise.
 *   Mark a gateway connector local if you know it is.
 * - Anything else, a loopback server included, is unknown until you mark it.
 *   A process on the Mac can still call a hosted API.
 */
export function describeServerLocality(
  server: LocalityServer,
  marks: Record<string, ServerMark> = loadServerMarks(),
): ServerLocalityResult {
  const name = sanitizeServerName(server.name);
  const mark = name ? marks[name] : undefined;
  if (mark) return { locality: mark, reason: "your-mark" };
  if (server.url) {
    const loopback = isLoopbackUrl(server.url);
    if (loopback === false) return { locality: "hosted", reason: "remote-address" };
    if (loopback === true) return { locality: "unknown", reason: "loopback-address" };
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
      return "Not marked";
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
    case "remote-argument":
      return "It is given an address that is not on this Mac.";
    default:
      return "Not known. Counts as hosted until you mark it.";
  }
}
