import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("./codexStore", () => ({
  prepareCodexMonoContext: async () => ({ config: {}, hasThread: false }),
}));
vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild: async () => undefined,
  restoreMonoCodexAgentState: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));
vi.mock("../../../../platform/tauri/fs", () => ({
  saveGeneratedImage: async () => ({ path: "/x.png", mimeType: "image/png", size: 1 }),
  deleteGeneratedImages: async () => undefined,
}));

const {
  sendCodexTurn,
  stopCodexSession,
  forkCodexSession_l1,
  __codexTestReset,
} = await import("./codex");
const { listCodexBackgroundTasks, stopCodexBackgroundTask } = await import(
  "./codexBackground"
);
import type { HarnessSessionInput } from "../../core/types";

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}
function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ id, result }));
}
function replyError(id: number, message: string, code = -32601) {
  onLine!(JSON.stringify({ id, error: { code, message } }));
}
function notify(method: string, params: unknown) {
  onLine!(JSON.stringify({ method, params }));
}
async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
function request(method: string) {
  return parse().find((message) => message.method === method);
}

const input: HarnessSessionInput = {
  sessionId: "codex-src",
  cwd: "/repo",
  model: "codex:qwen2.5:7b",
  runtimeMode: "supervised",
  onEvent: () => undefined,
};

/** One finished turn, so the source has a live thread `thr_1`. */
async function finishedTurn() {
  const turn = sendCodexTurn({ ...input, text: "hi", attachments: [] });
  await waitFor(() => !!request("initialize"), "initialize");
  reply(request("initialize")!.id as number, {});
  await waitFor(() => !!request("thread/start"), "thread/start");
  reply(request("thread/start")!.id as number, { thread: { id: "thr_1" } });
  await waitFor(() => !!request("turn/start"), "turn/start");
  reply(request("turn/start")!.id as number, {
    turn: { id: "turn_1", status: "inProgress" },
  });
  notify("turn/started", { turn: { id: "turn_1", status: "inProgress" } });
  notify("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  await turn;
  sent.length = 0;
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
});

afterEach(async () => {
  await stopCodexSession("codex-src");
  __codexTestReset();
});

describe("Codex fork", () => {
  it("forks through a turn with thread/fork and returns the new thread", async () => {
    await finishedTurn();
    const forked = forkCodexSession_l1({ source: input, boundary: "turn_1" });
    await waitFor(() => !!request("thread/fork"), "thread/fork");
    expect(request("thread/fork")!.params).toEqual({
      threadId: "thr_1",
      lastTurnId: "turn_1",
    });
    reply(request("thread/fork")!.id as number, { thread: { id: "thr_2" } });
    await expect(forked).resolves.toEqual({ providerSessionId: "thr_2" });
  });

  it("forks the whole thread without a boundary", async () => {
    await finishedTurn();
    const forked = forkCodexSession_l1({ source: input });
    await waitFor(() => !!request("thread/fork"), "thread/fork");
    expect(request("thread/fork")!.params).toEqual({ threadId: "thr_1" });
    reply(request("thread/fork")!.id as number, { thread: { id: "thr_2" } });
    await expect(forked).resolves.toEqual({ providerSessionId: "thr_2" });
  });

  it("fails rather than binding the fork to its own source", async () => {
    await finishedTurn();
    const forked = forkCodexSession_l1({ source: input });
    await waitFor(() => !!request("thread/fork"), "thread/fork");
    reply(request("thread/fork")!.id as number, { thread: { id: "thr_1" } });
    await expect(forked).rejects.toThrow("did not return a new thread");
  });

  it("passes a refused fork on, for the approximate fallback", async () => {
    await finishedTurn();
    const forked = forkCodexSession_l1({ source: input, boundary: "turn_1" });
    await waitFor(() => !!request("thread/fork"), "thread/fork");
    replyError(request("thread/fork")!.id as number, "thread is not paginated", -32000);
    await expect(forked).rejects.toThrow("not paginated");
  });

  it("refuses an ephemeral chat", async () => {
    await expect(
      forkCodexSession_l1({ source: { ...input, ephemeral: true } }),
    ).rejects.toThrow("no Codex thread");
  });
});

describe("Codex background terminals on a live thread", () => {
  it("lists and terminates through the session's own connection", async () => {
    await finishedTurn();
    const listed = listCodexBackgroundTasks("codex-src");
    await waitFor(
      () => !!request("thread/backgroundTerminals/list"),
      "terminals list",
    );
    reply(request("thread/backgroundTerminals/list")!.id as number, {
      data: [{ itemId: "i1", processId: "7", command: "npm run dev", cwd: "/repo" }],
      nextCursor: null,
    });
    await expect(listed).resolves.toEqual([
      expect.objectContaining({ id: "7", title: "npm run dev" }),
    ]);

    const stopped = stopCodexBackgroundTask("codex-src", "7");
    await waitFor(
      () => !!request("thread/backgroundTerminals/terminate"),
      "terminate",
    );
    expect(request("thread/backgroundTerminals/terminate")!.params).toEqual({
      threadId: "thr_1",
      processId: "7",
    });
    reply(request("thread/backgroundTerminals/terminate")!.id as number, {
      terminated: true,
    });
    await expect(stopped).resolves.toBe(true);
  });

  it("answers no list when this Codex lacks the method (corner case 6)", async () => {
    await finishedTurn();
    const listed = listCodexBackgroundTasks("codex-src");
    await waitFor(
      () => !!request("thread/backgroundTerminals/list"),
      "terminals list",
    );
    replyError(
      request("thread/backgroundTerminals/list")!.id as number,
      "Method not found",
    );
    await expect(listed).resolves.toBeNull();
  });
});
