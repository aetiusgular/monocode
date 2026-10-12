import type { HarnessId } from "../../sessions/model/session";
import type { LocalityServer } from "./serverLocality";

/**
 * The MCP servers a harness itself reported for one account and folder, as
 * the Connectors list last asked it. A session's own servers are known only
 * once the harness has been asked; until then its tools are unknown and the
 * session cannot count as local. Kept for this app run only.
 */
const reported = new Map<string, LocalityServer[]>();
const MAX_SERVERS = 200;

function key(harness: HarnessId, providerAccountId: string | undefined, cwd: string): string {
  return `${harness}\n${providerAccountId ?? ""}\n${cwd}`;
}

export function noteHarnessServers(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
  servers: readonly { name: string; enabled?: boolean; command?: string; args?: readonly string[]; url?: string }[] | undefined,
): void {
  const id = key(harness, providerAccountId, cwd);
  if (!servers) {
    reported.delete(id);
    return;
  }
  reported.set(
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
}

/** The servers last reported, or undefined when the harness was never asked. */
export function knownHarnessServers(
  harness: HarnessId,
  providerAccountId: string | undefined,
  cwd: string,
): readonly LocalityServer[] | undefined {
  return reported.get(key(harness, providerAccountId, cwd));
}

/** Test seam. */
export function __resetHarnessServers(): void {
  reported.clear();
}
