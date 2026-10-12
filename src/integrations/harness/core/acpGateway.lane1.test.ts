import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Change 8 against the five ACP adapters, with a fake agent behind the child
 * module: it answers every request, so each adapter runs its real start-up
 * and prompt code. None of the five CLIs runs here (none is on the Mac
 * either); what is checked is the wire shape the ACP schema gives.
 */
const fake = vi.hoisted(() => ({
  sent: [] as Array<{ id?: number; method?: string; params?: Record<string, unknown> }>,
  lines: new Map<string, (line: string) => void>(),
  sessions: 0,
}));

vi.mock("./child", async (importOriginal) => {
  const original = await importOriginal<typeof import("./child")>();
  const binary = async () => ({ path: "/fake/agent" });
  return {
    ...original,
    resolveCursorBinary: binary,
    resolveGrokBinary: binary,
    resolveFxBinary: binary,
    resolveHermesBinary: binary,
    resolveAntigravityBinary: binary,
    spawnChild: async () => undefined,
    killChild: async () => undefined,
    unwatchChild: (id: string) => {
      fake.lines.delete(id);
    },
    watchChild: (id: string, line: (l: string) => void) => {
      fake.lines.set(id, line);
    },
    writeChild: async (id: string, line: string) => {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      fake.sent.push(message);
      if (message.id === undefined || !message.method) return;
      const result = answer(message.method);
      setTimeout(() =>
        fake.lines.get(id)?.(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })),
      );
    },
  };

  function answer(method: string): unknown {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } };
      case "session/new":
        fake.sessions += 1;
        return { sessionId: `S${fake.sessions}` };
      case "session/prompt":
        return { stopReason: "end_turn" };
      default:
        return {};
    }
  }
});

import { acpMcpKey, acpMcpServers } from "./acp";
import type { HarnessLaunchMcpServer, SendTurnInput } from "./types";
import { sendCursorTurn, stopCursorSession } from "../providers/cursor/cursor";
import { sendGrokTurn, stopGrokSession } from "../providers/grok/grok";
import { sendFxTurn, stopFxSession } from "../providers/fx/fx";
import { sendHermesTurn, stopHermesSession } from "../providers/hermes/hermes";
import {
  sendAntigravityTurn,
  stopAntigravitySession,
} from "../providers/antigravity/antigravity";

const GITHUB: HarnessLaunchMcpServer = {
  name: "github",
  command: "/usr/local/bin/docker",
  args: ["mcp", "gateway", "run", "--profile", "monocode-github"],
};
const NOTION: HarnessLaunchMcpServer = {
  name: "notion",
  command: "/usr/local/bin/docker",
  args: ["mcp", "gateway", "run", "--profile", "monocode-notion"],
};

describe("acpMcpServers", () => {
  it("makes one ACP stdio server per connector, sorted, with an empty env", () => {
    expect(acpMcpServers([NOTION, GITHUB])).toEqual([
      { name: "github", command: GITHUB.command, args: GITHUB.args, env: [] },
      { name: "notion", command: NOTION.command, args: NOTION.args, env: [] },
    ]);
  });

  it("drops bad names, empty commands and repeats", () => {
    expect(
      acpMcpServers([
        { name: "bad name", command: "/d", args: [] },
        { name: "../x", command: "/d", args: [] },
        { name: "nocmd", command: "", args: [] },
        GITHUB,
        { ...GITHUB, args: ["other"] },
      ]).map((server) => server.args),
    ).toEqual([GITHUB.args]);
    expect(acpMcpServers(undefined)).toEqual([]);
  });

  it("keys on the set, not its order, and copies the arguments", () => {
    expect(acpMcpKey([GITHUB, NOTION])).toBe(acpMcpKey([NOTION, GITHUB]));
    expect(acpMcpKey([GITHUB])).not.toBe(acpMcpKey([GITHUB, NOTION]));
    expect(acpMcpKey(undefined)).toBe(acpMcpKey([]));
    const servers = acpMcpServers([GITHUB]);
    servers[0].args.push("--x");
    expect(GITHUB.args).not.toContain("--x");
  });
});

type Adapter = {
  name: string;
  model: string;
  send: (input: SendTurnInput) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
};

const ADAPTERS: Adapter[] = [
  { name: "Cursor", model: "cursor:auto", send: sendCursorTurn, stop: stopCursorSession },
  { name: "Grok Build", model: "grok:grok-4.6", send: sendGrokTurn, stop: stopGrokSession },
  { name: "fx", model: "fx:default", send: sendFxTurn, stop: stopFxSession },
  { name: "Hermes", model: "hermes:default", send: sendHermesTurn, stop: stopHermesSession },
  {
    name: "Antigravity",
    model: "antigravity:default",
    send: sendAntigravityTurn,
    stop: stopAntigravitySession,
  },
];

const SETUP = ["session/new", "session/load", "session/resume"];

function setupCalls() {
  return fake.sent.filter((message) => SETUP.includes(message.method ?? ""));
}

let thread = 0;
beforeEach(() => {
  fake.sent.length = 0;
  fake.sessions = 0;
  thread += 1;
});

describe.each(ADAPTERS)("$name with gateway connectors", (adapter) => {
  const sessionId = () => `acp-gateway-${adapter.name}-${thread}`;
  afterEach(async () => {
    await adapter.stop(sessionId());
  });

  const turn = (gatewayConnectors?: HarnessLaunchMcpServer[]) =>
    adapter.send({
      sessionId: sessionId(),
      cwd: "/repo",
      model: adapter.model,
      runtimeMode: "supervised",
      text: "hi",
      onEvent: () => {},
      ...(gatewayConnectors ? { gatewayConnectors } : {}),
    });

  it("starts with the chat's connectors, and with none when it has none", async () => {
    await turn([GITHUB]);
    const [start] = setupCalls();
    expect(start.method).toBe("session/new");
    expect(start.params?.mcpServers).toEqual(acpMcpServers([GITHUB]));
    await adapter.stop(sessionId());
    fake.sent.length = 0;
    thread += 1;
    await turn();
    expect(setupCalls()[0].params?.mcpServers).toEqual([]);
  });

  it("keeps the running session while the set is the same", async () => {
    await turn([GITHUB, NOTION]);
    await turn([NOTION, GITHUB]);
    expect(setupCalls()).toHaveLength(1);
  });

  it("restarts into the same conversation with the new set", async () => {
    await turn([GITHUB]);
    const first = setupCalls()[0];
    expect(first.method).toBe("session/new");
    fake.sent.length = 0;
    await turn([GITHUB, NOTION]);
    const [again] = setupCalls();
    expect(again.method === "session/load" || again.method === "session/resume").toBe(true);
    expect(again.params?.sessionId).toBe("S1");
    expect(again.params?.cwd).toBe("/repo");
    expect(again.params?.mcpServers).toEqual(acpMcpServers([GITHUB, NOTION]));
    // Switched off again: the same conversation, no servers.
    fake.sent.length = 0;
    await turn([]);
    const [off] = setupCalls();
    expect(off.params?.sessionId).toBe("S1");
    expect(off.params?.mcpServers).toEqual([]);
  });
});
