import type { HarnessLaunchMcpServer } from "./types";
import {
  JsonRpcClient,
  type JsonRpcHandlers,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./jsonRpc";

export type { JsonRpcMessage };

export type AcpHandlers = {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (
    id: number,
    method: string,
    params: unknown,
  ) => void | Promise<void>;
};

/** ACP JSON-RPC client — thin wrapper preserving the Cursor numeric-id API. */
export class AcpClient {
  private readonly rpc: JsonRpcClient;

  constructor(
    sessionId: string,
    private readonly handlers: AcpHandlers,
  ) {
    const rpcHandlers: JsonRpcHandlers = {
      onNotification: (method, params) =>
        this.handlers.onNotification?.(method, params),
      onRequest: (id, method, params) => {
        const numeric =
          typeof id === "number" ? id : Number(id);
        void this.handlers.onRequest?.(numeric, method, params);
      },
    };
    this.rpc = new JsonRpcClient(sessionId, rpcHandlers, {
      includeJsonrpc: true,
      label: "acp",
    });
  }

  pushLine(line: string) {
    this.rpc.pushLine(line);
  }

  close(error?: Error) {
    this.rpc.close(error);
  }

  rejectPending(error?: Error) {
    this.rpc.rejectPending(error);
  }

  request<T>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    return this.rpc.request<T>(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.rpc.notify(method, params);
  }

  respond(id: number, result: unknown): Promise<void> {
    return this.rpc.respond(id as JsonRpcId, result);
  }

  respondError(
    id: number,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    return this.rpc.respondError(id as JsonRpcId, error);
  }
}

/** An ACP stdio MCP server, as `session/new`, `session/load` and `session/resume` take it. */
export type AcpStdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

const ACP_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Change 8: the chat's Docker gateway connectors as ACP stdio servers, one
 * each, sorted by name. A bad name, an empty command or a repeated name is
 * left out. No environment is passed: the gateway reads its own.
 */
export function acpMcpServers(
  servers: readonly HarnessLaunchMcpServer[] | undefined,
): AcpStdioMcpServer[] {
  const byName = new Map<string, AcpStdioMcpServer>();
  for (const server of servers ?? []) {
    if (!ACP_MCP_SERVER_NAME.test(server.name) || !server.command) continue;
    if (byName.has(server.name)) continue;
    byName.set(server.name, {
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: [],
    });
  }
  return [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/**
 * What decides whether a running ACP session still has the right servers.
 * A change means a restart that loads the same conversation with the new set.
 */
export function acpMcpKey(
  servers: readonly HarnessLaunchMcpServer[] | undefined,
): string {
  return JSON.stringify(
    acpMcpServers(servers).map((server) => [
      server.name,
      server.command,
      server.args,
    ]),
  );
}
