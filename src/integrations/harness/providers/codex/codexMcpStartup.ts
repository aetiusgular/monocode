/**
 * Codex starts a thread's MCP servers after `thread/start` or
 * `thread/resume` returns and does not wait for them: a turn sent at once
 * goes to the model without the tools of a server still starting (Mac test
 * 8.3). Codex 0.161.0 reports each enabled server's startup on the thread as
 * `mcpServer/startupStatus/updated` with `{ threadId, name, status }`, status
 * "starting", then "ready" or "failed". A server switched off sends nothing.
 *
 * MonoCode holds the first turn of each opened thread until every server it
 * heard about, and every gateway connector it launched, has finished
 * starting, up to a cap.
 */

export const MCP_STARTUP_METHOD = "mcpServer/startupStatus/updated";
export const MCP_STARTUP_CAP_MS = 20_000;
export const MCP_STARTUP_STATUS_KEY = "codex-mcp-startup";
export const MCP_STARTUP_WAITING = "Waiting for connectors to start…";
export const MCP_STARTUP_TIMED_OUT =
  "Connectors still starting: this turn may not see their tools.";

const MAX_SERVERS = 200;

export type McpStartup = {
  /** The thread whose servers count; reports for other threads are ignored. */
  threadId?: string;
  /** Status by thread id, then server name, as Codex last reported it. */
  statuses: Map<string, Map<string, string>>;
  /** Gateway connectors this app-server was started with. */
  expected: Set<string>;
  /** The first turn has been let through. */
  settled: boolean;
  wake: (() => void) | null;
};

export function newMcpStartup(expected: Iterable<string> = []): McpStartup {
  return {
    statuses: new Map(),
    expected: new Set(expected),
    settled: false,
    wake: null,
  };
}

/** Records a startup notification for this thread. Returns whether it was one. */
export function noteMcpStartup(
  state: McpStartup,
  method: string,
  params: unknown,
): boolean {
  if (method !== MCP_STARTUP_METHOD) return false;
  if (!params || typeof params !== "object") return true;
  const { threadId, name, status } = params as Record<string, unknown>;
  if (typeof name !== "string" || typeof status !== "string") return true;
  const thread = typeof threadId === "string" ? threadId : "";
  let byName = state.statuses.get(thread);
  if (!byName) {
    if (state.statuses.size >= MAX_SERVERS) return true;
    byName = new Map();
    state.statuses.set(thread, byName);
  }
  if (!byName.has(name) && byName.size >= MAX_SERVERS) return true;
  byName.set(name, status);
  state.wake?.();
  return true;
}

function threadStatuses(state: McpStartup): Map<string, string> {
  const out = new Map<string, string>();
  for (const [thread, byName] of state.statuses) {
    if (state.threadId && thread && thread !== state.threadId) continue;
    for (const [name, status] of byName) out.set(name, status);
  }
  return out;
}

/**
 * Servers that are still starting, or, with `expectUnheard`, gateway
 * connectors not heard from yet.
 */
export function mcpStillStarting(
  state: McpStartup,
  expectUnheard = true,
): string[] {
  const statuses = threadStatuses(state);
  const out = new Set<string>();
  for (const [name, status] of statuses) {
    if (status === "starting") out.add(name);
  }
  if (expectUnheard) {
    for (const name of state.expected) {
      if (!statuses.has(name)) out.add(name);
    }
  }
  return [...out].sort();
}

// Codex reports "starting" right after the thread opens. A gateway connector
// it never reports (a name it dropped) stops counting after this long.
export const MCP_UNHEARD_GRACE_MS = 3_000;

/**
 * Waits until no server is starting, the cap passes, or `stop()` says the turn
 * was cancelled. "ready" when nothing is left, "timeout" on the cap,
 * "stopped" when cancelled. Calls `onWaiting` once, only when it has to wait.
 */
export async function waitForMcpStartup(
  state: McpStartup,
  options: {
    capMs?: number;
    stop?: () => boolean;
    onWaiting?: () => void;
  } = {},
): Promise<"ready" | "timeout" | "stopped"> {
  const start = Date.now();
  const left = () =>
    mcpStillStarting(state, Date.now() - start < MCP_UNHEARD_GRACE_MS).length;
  if (left() === 0) return "ready";
  options.onWaiting?.();
  const deadline = start + (options.capMs ?? MCP_STARTUP_CAP_MS);
  try {
    for (;;) {
      if (options.stop?.()) return "stopped";
      if (left() === 0) return "ready";
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout";
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 250));
        state.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      state.wake = null;
    }
  } finally {
    state.wake = null;
  }
}
