import { homeDir } from "../../../../platform/tauri/fs";
import {
  killChild,
  resolveClaudeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
  writeChild,
} from "../../core/child";
import {
  buildClaudeSpawnArgs,
  buildControlRequest,
  parseControlResponse,
  parseJsonLine,
} from "./claudeProtocol";
import {
  sanitizeReportedMcpServers,
  type ReportedMcpServer,
} from "../../../../features/session-tools/model/reportedMcpServers";

const INIT_ID = "monocode_mcp_init";
const STATUS_ID = "monocode_mcp_status";
/** First ask once Claude Code has started its servers. */
const FIRST_ASK_MS = 1500;
/** Ask again while some are still connecting. */
const ASK_EVERY_MS = 1500;
/** Give up waiting on slow servers and keep what was answered. */
const SETTLE_MS = 10_000;
/** Hard stop for a process that never answers. */
const TIMEOUT_MS = 15_000;

/**
 * Asks Claude Code which MCP servers it loads, the way a session would load
 * them, without sending a prompt: `initialize`, then `mcp_status` until no
 * server is still connecting. The answer includes the claude.ai account's
 * connectors and plugin servers, which no config file names. No model is
 * called, so it costs nothing, but Claude Code does start every server for
 * the few seconds this takes.
 */
export async function probeClaudeMcpServers(input: {
  cwd?: string;
  providerAccountId?: string;
}): Promise<ReportedMcpServer[]> {
  const { path } = await resolveClaudeBinary();
  const cwd = input.cwd || (await homeDir());
  const probeId = `claude-mcp-status-${crypto.randomUUID()}`;

  let latest: ReportedMcpServer[] | null = null;
  let done: ((servers: ReportedMcpServer[]) => void) | null = null;
  let failed: ((error: Error) => void) | null = null;
  const answer = new Promise<ReportedMcpServer[]>((resolve, reject) => {
    done = resolve;
    failed = reject;
  });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const started = Date.now();

  const ask = () => {
    void writeChild(
      probeId,
      JSON.stringify(buildControlRequest(STATUS_ID, { subtype: "mcp_status" })),
    ).catch((error: unknown) =>
      failed?.(error instanceof Error ? error : new Error(String(error))),
    );
  };

  watchChild(
    probeId,
    (line) => {
      const rec = parseJsonLine(line);
      if (!rec) return;
      const response = parseControlResponse(rec);
      if (!response || response.requestId !== STATUS_ID) return;
      if (!response.ok) {
        failed?.(new Error(response.error ?? "mcp_status failed"));
        return;
      }
      const servers = sanitizeReportedMcpServers(response.payload?.mcpServers);
      if (!servers) {
        failed?.(new Error("mcp_status returned no server list"));
        return;
      }
      latest = servers;
      const connecting = servers.some((server) => server.status === "pending");
      if (!connecting || Date.now() - started >= SETTLE_MS) {
        done?.(servers);
      } else {
        timers.push(setTimeout(ask, ASK_EVERY_MS));
      }
    },
    () => {
      if (latest) done?.(latest);
      else failed?.(new Error("Claude Code exited before listing its servers"));
    },
  );

  const stop = async () => {
    for (const timer of timers) clearTimeout(timer);
    unwatchChild(probeId);
    await killChild(probeId).catch(() => undefined);
  };

  try {
    await spawnChild(
      probeId,
      path,
      [
        ...buildClaudeSpawnArgs({
          includePartialMessages: false,
          // The user's hooks have no business firing for a status check.
          settings: { disableAllHooks: true },
        }),
        "--no-session-persistence",
      ],
      cwd,
      { provider: "claude", id: input.providerAccountId ?? "default" },
      "claude",
    );
    await writeChild(
      probeId,
      JSON.stringify(buildControlRequest(INIT_ID, { subtype: "initialize" })),
    );
    timers.push(setTimeout(ask, FIRST_ASK_MS));
    return await new Promise<ReportedMcpServer[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (latest) resolve(latest);
        else reject(new Error("Claude Code did not list its servers in time"));
      }, TIMEOUT_MS);
      timers.push(timer);
      answer.then(resolve, reject);
    });
  } finally {
    await stop();
  }
}
