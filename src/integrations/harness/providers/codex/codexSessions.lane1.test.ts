import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A fake `codex app-server`: each line MonoCode writes is answered by
 * `answer`, and the reply goes back through the watched line handler.
 */
const fake = vi.hoisted(() => {
  const state = {
    onLine: undefined as ((line: string) => void) | undefined,
    onExit: undefined as (() => void) | undefined,
    sent: [] as Array<{ id?: number; method: string; params?: unknown }>,
    answer: (_method: string, _params: unknown): unknown => ({}),
    spawned: [] as unknown[][],
    killed: [] as string[],
    released: 0,
    spawnError: undefined as Error | undefined,
  };
  return state;
});

vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/bin/codex" }),
  acquireHarnessBridge: async () => () => {
    fake.released += 1;
  },
  spawnChild: async (...args: unknown[]) => {
    fake.spawned.push(args);
    if (fake.spawnError) throw fake.spawnError;
  },
  watchChild: (_id: string, onLine: (line: string) => void, onExit: () => void) => {
    fake.onLine = onLine;
    fake.onExit = onExit;
  },
  unwatchChild: () => {
    fake.onLine = undefined;
  },
  killChild: async (id: string) => {
    fake.killed.push(id);
  },
  writeChild: async (_id: string, line: string) => {
    const message = JSON.parse(line) as {
      id?: number;
      method: string;
      params?: unknown;
    };
    fake.sent.push(message);
    if (message.id === undefined) return;
    const result = fake.answer(message.method, message.params);
    queueMicrotask(() => {
      fake.onLine?.(
        JSON.stringify(
          result instanceof Error
            ? { id: message.id, error: { code: -32600, message: result.message } }
            : { id: message.id, result },
        ),
      );
    });
  },
}));

import {
  codexThreadRows,
  codexTurnsHistory,
  listCodexSessions,
  readCodexSessionTurns,
} from "./codexSessions";

const CWD = "/tmp/probe/work dir";

/** A thread as Codex 0.161.0 listed it on 12 Oct (fields MonoCode reads). */
function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "01a12f38-b4d1-7a53-b18c-c890daa747d4",
    preview: "first question",
    name: null,
    source: "vscode",
    modelProvider: "mock",
    model: "mock-model",
    status: { type: "notLoaded" },
    historyMode: "paginated",
    ephemeral: false,
    parentThreadId: null,
    updatedAt: 1791793608,
    recencyAt: null,
    cwd: CWD,
    turns: [],
    ...overrides,
  };
}

/** Two turns as `thread/read` with turns returned them at 0.161.0. */
const TURNS = [
  {
    id: "01a12f38-b4f0-7580-b560-91aff1b9478c",
    status: "completed",
    itemsView: "full",
    startedAt: 1791793600,
    items: [
      { type: "userMessage", content: [{ type: "text", text: "first question", text_elements: [] }] },
      { type: "agentMessage", text: "Answer number 1" },
    ],
  },
  {
    id: "01a12f38-b55f-72a3-ad22-b1d502a549df",
    status: "completed",
    itemsView: "full",
    startedAt: null,
    items: [
      { type: "userMessage", content: [{ type: "text", text: "second question", text_elements: [] }] },
      { type: "agentMessage", text: "Answer number 2" },
    ],
  },
];

beforeEach(() => {
  fake.sent = [];
  fake.spawned = [];
  fake.killed = [];
  fake.released = 0;
  fake.spawnError = undefined;
  fake.answer = () => ({});
});

describe("codexThreadRows", () => {
  it("maps a listed thread to a row", () => {
    expect(codexThreadRows([thread()], CWD)).toEqual([
      {
        id: "01a12f38-b4d1-7a53-b18c-c890daa747d4",
        title: "first question",
        updatedAt: 1791793608000,
        detail: "recorded with mock · mock-model",
      },
    ]);
  });

  it("prefers the thread's name and its recency time", () => {
    const [row] = codexThreadRows(
      [thread({ name: "Named", recencyAt: 1791799999 })],
      `${CWD}/`,
    );
    expect(row.title).toBe("Named");
    expect(row.updatedAt).toBe(1791799999000);
  });

  it("leaves out subagents, ephemeral threads, other folders and bad ids", () => {
    expect(
      codexThreadRows(
        [
          thread({ id: "sub", parentThreadId: "root" }),
          thread({ id: "eph", ephemeral: true }),
          thread({ id: "else", cwd: "/tmp/probe" }),
          thread({ id: "-c" }),
          null,
        ],
        CWD,
      ),
    ).toEqual([]);
    expect(codexThreadRows({ data: [] }, CWD)).toEqual([]);
  });
});

describe("codexTurnsHistory", () => {
  it("keeps each turn's prompt, final answer and id", () => {
    expect(codexTurnsHistory(TURNS)).toEqual({
      truncated: false,
      turns: [
        {
          user: "first question",
          assistant: "Answer number 1",
          providerTurnId: "01a12f38-b4f0-7580-b560-91aff1b9478c",
          startedAt: 1791793600000,
        },
        {
          user: "second question",
          assistant: "Answer number 2",
          providerTurnId: "01a12f38-b55f-72a3-ad22-b1d502a549df",
        },
      ],
    });
  });

  it("names images and mentions, takes the last answer, skips turns with no prompt", () => {
    const history = codexTurnsHistory([
      {
        id: "t1",
        items: [
          {
            type: "userMessage",
            content: [
              { type: "text", text: "look" },
              { type: "localImage", path: "/x.png" },
              { type: "mention", name: "app.ts", path: "/a" },
            ],
          },
          { type: "commandExecution", command: "ls" },
          { type: "agentMessage", text: "checking" },
          { type: "agentMessage", text: "done" },
        ],
      },
      { id: "t2", items: [{ type: "agentMessage", text: "orphan" }] },
    ]);
    expect(history.turns).toEqual([
      { user: "look\n[image]\n@app.ts", assistant: "done", providerTurnId: "t1" },
    ]);
  });

  it("is empty for anything but a list", () => {
    expect(codexTurnsHistory(undefined)).toEqual({ turns: [], truncated: false });
  });
});

describe("listCodexSessions", () => {
  it("asks thread/list for this folder, every provider, interactive sources", async () => {
    fake.answer = (method) =>
      method === "thread/list" ? { data: [thread()], nextCursor: null } : {};
    const rows = await listCodexSessions({ cwd: CWD, providerAccountId: "local" });
    expect(rows.map((row) => row.id)).toEqual([
      "01a12f38-b4d1-7a53-b18c-c890daa747d4",
    ]);
    expect(fake.sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/list",
    ]);
    expect(fake.sent[2].params).toEqual({
      cwd: [CWD],
      modelProviders: [],
      sourceKinds: ["cli", "vscode", "exec", "appServer"],
      archived: false,
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    // Started as the chat's own account, in its folder, then stopped.
    const [, path, args, cwd, account] = fake.spawned[0];
    expect([path, args, cwd, account]).toEqual([
      "/bin/codex",
      ["app-server"],
      CWD,
      { provider: "codex", id: "local" },
    ]);
    expect(fake.killed).toHaveLength(1);
    expect(fake.released).toBe(1);
  });

  it("stops the server and passes the error on when the list fails", async () => {
    fake.answer = (method) =>
      method === "thread/list" ? new Error("unknown method") : {};
    await expect(listCodexSessions({ cwd: CWD })).rejects.toThrow("unknown method");
    expect(fake.killed).toHaveLength(1);
    expect(fake.released).toBe(1);
    expect(fake.spawned[0][4]).toEqual({ provider: "codex", id: "default" });
  });

  it("releases the bridge when Codex is missing", async () => {
    fake.spawnError = new Error("codex not found");
    await expect(listCodexSessions({ cwd: CWD })).rejects.toThrow("codex not found");
    expect(fake.released).toBe(1);
  });
});

describe("readCodexSessionTurns", () => {
  it("reads the rollout with turns, without resuming the thread", async () => {
    fake.answer = (method) =>
      method === "thread/read" ? { thread: thread({ turns: TURNS }) } : {};
    const history = await readCodexSessionTurns({
      cwd: CWD,
      providerSessionId: "01a12f38-b4d1-7a53-b18c-c890daa747d4",
    });
    expect(history.turns).toHaveLength(2);
    const methods = fake.sent.map((message) => message.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/read"]);
    expect(methods).not.toContain("thread/resume");
    expect(fake.sent[2].params).toEqual({
      threadId: "01a12f38-b4d1-7a53-b18c-c890daa747d4",
      includeTurns: true,
    });
  });

  it("refuses a thread from another folder and a bad id", async () => {
    fake.answer = (method) =>
      method === "thread/read" ? { thread: thread({ cwd: "/elsewhere", turns: TURNS }) } : {};
    await expect(
      readCodexSessionTurns({ cwd: CWD, providerSessionId: "thr" }),
    ).rejects.toThrow("another folder");
    await expect(
      readCodexSessionTurns({ cwd: CWD, providerSessionId: "../thr" }),
    ).rejects.toThrow("Not a Codex thread id");
  });
});
