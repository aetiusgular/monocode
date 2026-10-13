/**
 * #45: Codex threads recorded for a folder, outside MonoCode or by an earlier
 * chat, listed with `thread/list` and read with `thread/read`. Both run in a
 * short-lived `codex app-server` started as the chat's own account, so the
 * list comes from the same Codex home the chat would resume from. Nothing is
 * resumed or written here.
 */
import {
  acquireHarnessBridge,
  killChild,
  resolveCodexBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import { JsonRpcClient } from "../../core/jsonRpc";
import { findModelProvider } from "../../../../features/model-setup/model/modelProviders";
import {
  isProviderSessionId,
  limitImportedHistory,
  oneLine,
  sanitizeSessionRows,
} from "../../../../features/session-import/model/sessionImport";
import type {
  HarnessSessionRow,
  ImportedHistory,
  ImportedTurn,
  ListSessionsInput,
  ReadSessionInput,
} from "../../../../features/session-import/model/types";

const REQUEST_TIMEOUT_MS = 30_000;
const LIST_LIMIT = 50;
/** Interactive threads only: subagents, reviews and compactions are left out. */
const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"] as const;

type Rpc = <T = unknown>(method: string, params: unknown) => Promise<T>;

let serial = 0;

/** Starts `codex app-server` for one call, then stops it. */
async function withCodexServer<T>(
  input: ListSessionsInput,
  run: (request: Rpc) => Promise<T>,
): Promise<T> {
  const { path } = await resolveCodexBinary();
  const release = await acquireHarnessBridge();
  const id = `session-import:codex:${++serial}:${Date.now()}`;
  const rpc: JsonRpcClient = new JsonRpcClient(
    id,
    {
      onRequest: (requestId, method) => {
        if (method === "currentTime/read")
          return rpc.respond(requestId, {
            currentTimeAt: Math.floor(Date.now() / 1000),
          });
        // A listing never runs a turn, so no approval or question is expected.
        return rpc.respondError(requestId, {
          code: -32601,
          message: `Unsupported request while listing: ${method}`,
        });
      },
    },
    { includeJsonrpc: false, label: "codex-sessions" },
  );
  const request: Rpc = (method, params) =>
    rpc.request(method, params, REQUEST_TIMEOUT_MS);
  watchChild(
    id,
    (line) => rpc.pushLine(line),
    () => rpc.close(new Error("Codex exited while listing its sessions")),
  );
  try {
    await spawnChild(
      id,
      path,
      ["app-server"],
      input.cwd,
      { provider: "codex", id: input.providerAccountId ?? "default" },
      "codex",
    );
    await request("initialize", {
      clientInfo: { name: "monocode", title: "MonoCode", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    await rpc.notify("initialized", undefined);
    return await run(request);
  } finally {
    rpc.close();
    unwatchChild(id);
    await killChild(id).catch(() => undefined);
    release();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function samePath(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const trim = (path: string) =>
    path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  return trim(a) === trim(b);
}

/**
 * Rows from a `thread/list` page. Subagent, ephemeral and other-folder
 * threads are left out, whatever the server's filter did.
 */
export function codexThreadRows(
  data: unknown,
  cwd: string,
): HarnessSessionRow[] {
  if (!Array.isArray(data)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const raw of data) {
    const thread = record(raw);
    if (!thread || !isProviderSessionId(thread.id)) continue;
    if (thread.ephemeral === true) continue;
    if (typeof thread.parentThreadId === "string" && thread.parentThreadId)
      continue;
    if (!samePath(thread.cwd, cwd)) continue;
    const seconds =
      typeof thread.recencyAt === "number"
        ? thread.recencyAt
        : typeof thread.updatedAt === "number"
          ? thread.updatedAt
          : 0;
    const name = typeof thread.name === "string" ? thread.name : "";
    // The provider's own name where MonoCode knows it, not its config id
    // (Mac finding 1.14: "ollama_local" for "Ollama on this Mac").
    const providerId =
      typeof thread.modelProvider === "string" ? thread.modelProvider : "";
    const provider = providerId
      ? oneLine(providerDisplayName(providerId), 40)
      : "";
    const model = typeof thread.model === "string" ? oneLine(thread.model, 60) : "";
    rows.push({
      id: thread.id,
      title: name || thread.preview,
      updatedAt: seconds * 1000,
      detail: [provider && `recorded with ${provider}`, model]
        .filter(Boolean)
        .join(" · "),
    });
  }
  return sanitizeSessionRows(rows);
}

function userText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts: string[] = [];
  for (const raw of content) {
    const input = record(raw);
    if (!input) continue;
    if (input.type === "text" && typeof input.text === "string") {
      parts.push(input.text);
    } else if (input.type === "image" || input.type === "localImage") {
      parts.push("[image]");
    } else if (
      (input.type === "mention" || input.type === "skill") &&
      typeof input.name === "string"
    ) {
      parts.push(`@${input.name}`);
    }
  }
  return parts.join("\n").trim();
}

/** Earlier turns from a `thread/read` with turns: user text and final reply. */
export function codexTurnsHistory(turns: unknown): ImportedHistory {
  if (!Array.isArray(turns)) return { turns: [], truncated: false };
  const out: ImportedTurn[] = [];
  for (const raw of turns) {
    const turn = record(raw);
    if (!turn) continue;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const users: string[] = [];
    let assistant = "";
    for (const rawItem of items) {
      const item = record(rawItem);
      if (!item) continue;
      if (item.type === "userMessage") {
        const text = userText(item);
        if (text) users.push(text);
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        // The last agent message is the turn's answer.
        if (item.text.trim()) assistant = item.text;
      }
    }
    if (users.length === 0) continue;
    out.push({
      user: users.join("\n\n"),
      ...(assistant ? { assistant } : {}),
      ...(isProviderSessionId(turn.id) ? { providerTurnId: turn.id } : {}),
      ...(typeof turn.startedAt === "number"
        ? { startedAt: turn.startedAt * 1000 }
        : {}),
    });
  }
  return limitImportedHistory(out);
}

/** The Codex threads recorded in this folder, newest first. */
export function listCodexSessions(
  input: ListSessionsInput,
): Promise<HarnessSessionRow[]> {
  return withCodexServer(input, async (request) => {
    const page = await request<{ data?: unknown }>("thread/list", {
      cwd: [input.cwd],
      // Empty means every provider: a thread on the local model shows too.
      modelProviders: [],
      sourceKinds: [...SOURCE_KINDS],
      archived: false,
      limit: LIST_LIMIT,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    return codexThreadRows(page.data, input.cwd);
  });
}

/**
 * A thread's earlier turns, as text. `thread/read` with turns reads the
 * rollout file without loading the thread. Codex marks that read deprecated
 * for paginated threads; it worked for one at 0.161.0 (run 12 Oct). A refusal
 * comes back as an error and the chat opens without its old turns.
 */
export function readCodexSessionTurns(
  input: ReadSessionInput,
): Promise<ImportedHistory> {
  if (!isProviderSessionId(input.providerSessionId)) {
    return Promise.reject(new Error("Not a Codex thread id"));
  }
  return withCodexServer(input, async (request) => {
    const read = await request<{ thread?: unknown }>("thread/read", {
      threadId: input.providerSessionId,
      includeTurns: true,
    });
    const thread = record(read.thread);
    if (thread && !samePath(thread.cwd, input.cwd)) {
      throw new Error("That thread belongs to another folder");
    }
    return codexTurnsHistory(thread?.turns);
  });
}

function providerDisplayName(id: string): string {
  try {
    return findModelProvider(id)?.label || id;
  } catch {
    return id;
  }
}
