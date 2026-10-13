import { runtimeProviderBinaryPath } from "../../../../features/providers/model/providerBinaryPaths";
import { DEFAULT_PROVIDER_ACCOUNT_ID } from "../../../../features/providers/model/providerAccounts";
import { acquireHarnessBridge } from "../../core/child";
import type { HarnessMcpServer, ListMcpServersInput } from "../../core/types";
import { withCodexProbe } from "./codexCatalog";
import {
  codexMcpServerList,
  codexModelRoute,
  type CodexModelRoute,
} from "./codexProtocol";
import {
  noteHarnessModelRoute,
  noteHarnessServers,
} from "../../../../features/server-locality/model/sessionServers";

const PROBE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** How long an answer stands in for asking Codex again. */
const CACHE_TTL_MS = 60_000;
/** A failed probe is retried sooner, but not on every open of the list. */
const FAILURE_TTL_MS = 15_000;

/** What one `config/read` said: the servers, and the model route when readable. */
export type CodexConfigReport = {
  servers: HarnessMcpServer[];
  route?: CodexModelRoute;
};

type Entry =
  { at: number; report: CodexConfigReport } | { at: number; error: Error };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<CodexConfigReport>>();

/** Forget every answer, so the next call asks Codex again. */
export function clearCodexMcpServersCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * The MCP servers the Codex of one session has, as that Codex reports them.
 *
 * A session's Codex is the configured binary (possibly a wrapper that sets its
 * own Codex home) running under the session's provider account, so its servers
 * can differ from the ones in the app's own `~/.codex/config.toml`. Only that
 * Codex can say what it has: this starts it the way a session does and asks
 * for its effective configuration. Answers are kept per directory, account and
 * binary for a minute, so opening the list does not start a process each time.
 */
export function listCodexMcpServers(
  input: ListMcpServersInput,
): Promise<HarnessMcpServer[]> {
  return readCodexConfigReport(input).then((report) => report.servers);
}

/**
 * The servers and the model route of one session's Codex, from the same
 * cached `config/read` (Mac finding 5.6). A wrapper script may set its own
 * `CODEX_HOME`, which MonoCode cannot see; the Codex it starts can say which
 * provider it uses and where that provider's base URL points.
 */
export function readCodexConfigReport(
  input: ListMcpServersInput,
): Promise<CodexConfigReport> {
  const account = input.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
  const key = [
    account,
    runtimeProviderBinaryPath("codex") ?? "",
    input.cwd,
  ].join("\n");
  const cached = cache.get(key);
  if (cached && !input.refresh) {
    const failed = "error" in cached;
    const age = Date.now() - cached.at;
    if (age >= 0 && age < (failed ? FAILURE_TTL_MS : CACHE_TTL_MS)) {
      return failed
        ? Promise.reject(cached.error)
        : Promise.resolve(cached.report);
    }
  }
  // A refresh asked for while a probe is running is answered by that probe.
  const pending = inFlight.get(key);
  if (pending) return pending;
  const probe = probeCodexConfig(input.cwd, account)
    .then(
      (report) => {
        if (inFlight.get(key) === probe) {
          cache.set(key, { at: Date.now(), report });
        }
        // #9 and 5.6: what this Codex reported decides whether its sessions
        // in this folder are local.
        noteHarnessServers("codex", account, input.cwd, report.servers);
        noteHarnessModelRoute("codex", account, input.cwd, report.route);
        return report;
      },
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (inFlight.get(key) === probe) {
          cache.set(key, { at: Date.now(), error });
        }
        throw error;
      },
    )
    .finally(() => {
      if (inFlight.get(key) === probe) inFlight.delete(key);
    });
  inFlight.set(key, probe);
  return probe;
}

async function probeCodexConfig(
  cwd: string,
  providerAccountId: string,
): Promise<CodexConfigReport> {
  const release = await acquireHarnessBridge();
  try {
    return await withCodexProbe(
      {
        cwd,
        providerAccountId,
        timeoutMs: PROBE_TIMEOUT_MS,
        timeoutMessage: "Codex did not report its MCP servers in time",
      },
      async (rpc) => {
        const result = await rpc.request(
          "config/read",
          { cwd },
          REQUEST_TIMEOUT_MS,
        );
        const servers = codexMcpServerList(result);
        if (!servers) {
          throw new Error("Codex returned an unreadable configuration");
        }
        const route = codexModelRoute(result);
        return route ? { servers, route } : { servers };
      },
    );
  } finally {
    release();
  }
}
