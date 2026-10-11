import { probeClaudeMcpServers } from "../../../integrations/harness/providers/claude/claudeMcpStatus";
import {
  accountMcpServersAt,
  noteAccountMcpServers,
} from "./reportedMcpServers";

/** Ask again at most this often per account. */
const FRESH_MS = 5 * 60_000;

const inFlight = new Map<string, Promise<void>>();

/**
 * Asks Claude Code for the account's MCP servers unless it was asked
 * recently. The answer lands in the reported-servers store, which the
 * connector switches read. Failures are quiet: the switches still list the
 * servers from config files.
 */
export function loadClaudeConnectors(input: {
  cwd?: string;
  providerAccountId?: string;
  force?: boolean;
}): Promise<void> {
  const account = input.providerAccountId || "default";
  const running = inFlight.get(account);
  if (running) return running;
  if (
    !input.force &&
    Date.now() - accountMcpServersAt(input.providerAccountId) < FRESH_MS
  ) {
    return Promise.resolve();
  }
  const run = probeClaudeMcpServers(input)
    .then((servers) => noteAccountMcpServers(input.providerAccountId, servers))
    .catch(() => undefined)
    .finally(() => inFlight.delete(account));
  inFlight.set(account, run);
  return run;
}

/** True while the account is being asked. */
export function loadingClaudeConnectors(providerAccountId?: string): boolean {
  return inFlight.has(providerAccountId || "default");
}
