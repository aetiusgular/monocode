import { useSyncExternalStore } from "react";

/** One MCP server as Claude Code lists it. */
export type ReportedMcpServer = {
  name: string;
  /** Claude Code's word for it: connected, pending, failed, needs-auth. */
  status: string;
};

/**
 * What Claude Code said a chat loaded when its last turn started. It can be
 * partial: claude.ai connectors still connecting are listed as pending, and a
 * turn that started before the account's connectors arrived may lack them.
 * Kept for this app run only.
 */
const bySession = new Map<string, ReportedMcpServer[]>();
/**
 * What Claude Code lists for an account when asked directly (`mcp_status`),
 * kept across restarts so the switches show every connector as the app
 * opens. claude.ai connectors and plugins belong to the account, not a chat.
 */
const byAccount = new Map<
  string,
  { servers: ReportedMcpServer[]; at: number }
>();
const listeners = new Set<() => void>();
/** Cached answers per session and account, so `useSyncExternalStore` sees stable values. */
const merged = new Map<string, ReportedMcpServer[] | null>();

const MAX_SERVERS = 200;
const STORAGE_KEY = "monocode.claudeMcpServers.v1";

function accountKey(providerAccountId?: string): string {
  return providerAccountId || "default";
}

/** Bounded, de-duplicated names with a status each. */
export function sanitizeReportedMcpServers(
  value: unknown,
): ReportedMcpServer[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const servers: ReportedMcpServer[] = [];
  for (const entry of value) {
    if (servers.length >= MAX_SERVERS) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || name.length > 200 || seen.has(name)) continue;
    seen.add(name);
    const status =
      typeof record.status === "string" && record.status.trim()
        ? record.status.trim()
        : "unknown";
    servers.push({ name, status });
  }
  return servers;
}

function loadSaved(): void {
  try {
    const raw =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return;
    for (const [account, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const record = value as { servers?: unknown; at?: unknown } | null;
      const servers = sanitizeReportedMcpServers(record?.servers);
      if (!servers) continue;
      // A saved list is what the account had; nothing is connected yet.
      byAccount.set(account, {
        servers: servers.map((server) =>
          server.status === "connected"
            ? { ...server, status: "saved" }
            : server,
        ),
        at: 0,
      });
    }
  } catch {
    // private mode or a corrupt entry: start empty
  }
}

function save(): void {
  try {
    const out: Record<string, { servers: ReportedMcpServer[]; at: number }> =
      {};
    for (const [account, entry] of byAccount) out[account] = entry;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // best effort
  }
}

loadSaved();

function changed(): void {
  merged.clear();
  for (const notify of listeners) notify();
}

/** A chat's own list, from the `system/init` message of its latest turn. */
export function noteReportedMcpServers(
  sessionId: string,
  servers: ReportedMcpServer[],
): void {
  bySession.set(sessionId, servers);
  changed();
}

/** An account's list, from asking Claude Code directly. Saved. */
export function noteAccountMcpServers(
  providerAccountId: string | undefined,
  servers: ReportedMcpServer[],
): void {
  byAccount.set(accountKey(providerAccountId), { servers, at: Date.now() });
  save();
  changed();
}

/** When the account was last asked in this app run, or 0. */
export function accountMcpServersAt(providerAccountId?: string): number {
  return byAccount.get(accountKey(providerAccountId))?.at ?? 0;
}

const RANK: Record<string, number> = {
  connected: 4,
  pending: 3,
  saved: 2,
  "needs-auth": 1,
};

/**
 * The account's list and the chat's own, one entry per name. Where both name
 * a server, the more hopeful status wins: the chat's turn may have started
 * before a connector finished connecting.
 */
export function reportedMcpServers(
  sessionId: string | undefined,
  providerAccountId?: string,
): ReportedMcpServer[] | null {
  const key = `${sessionId ?? ""}\n${accountKey(providerAccountId)}`;
  if (merged.has(key)) return merged.get(key) ?? null;
  const account = byAccount.get(accountKey(providerAccountId))?.servers;
  const session = sessionId ? bySession.get(sessionId) : undefined;
  let result: ReportedMcpServer[] | null = null;
  if (account || session) {
    const byName = new Map<string, ReportedMcpServer>();
    for (const server of [...(account ?? []), ...(session ?? [])]) {
      const prior = byName.get(server.name);
      if (!prior || (RANK[server.status] ?? 0) > (RANK[prior.status] ?? 0)) {
        byName.set(server.name, server);
      }
    }
    result = [...byName.values()];
  }
  merged.set(key, result);
  return result;
}

/**
 * Every server name Claude Code listed for any account when asked directly.
 * Used to find claude.ai copies of Docker gateway connectors and names a new
 * connector must not reuse. A chat's own list is left out: it also names the
 * gateway connectors MonoCode added to that chat.
 */
export function knownReportedMcpServerNames(): string[] {
  const names = new Set<string>();
  for (const { servers } of byAccount.values()) {
    for (const server of servers) names.add(server.name);
  }
  return [...names];
}

/** Subscribe outside React; returns the unsubscribe. */
export function subscribeReportedMcpServers(
  onStoreChange: () => void,
): () => void {
  return subscribe(onStoreChange);
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function useReportedMcpServers(
  sessionId: string | undefined,
  providerAccountId: string | undefined,
  enabled: boolean,
): ReportedMcpServer[] | null {
  return useSyncExternalStore(
    subscribe,
    () => (enabled ? reportedMcpServers(sessionId, providerAccountId) : null),
    () => null,
  );
}

/** Exported for tests. */
export function __resetReportedMcpServers(): void {
  bySession.clear();
  byAccount.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  changed();
}

/** Exported for tests: read the saved lists again, as an app start does. */
export function __reloadSavedMcpServers(): void {
  byAccount.clear();
  loadSaved();
  changed();
}
