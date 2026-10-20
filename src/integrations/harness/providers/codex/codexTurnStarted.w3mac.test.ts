import { afterEach, describe, expect, it, vi } from "vitest";

// Mac test 2.2: Codex can send `turn/started` (and even `turn/completed`)
// before the `turn/start` reply. The adapter only announced the start from
// that reply, after `turn.ready`, so the activity log saw no start it could
// end. The notification now starts the turn, once.

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("./codexStore", () => ({
  prepareCodexMonoContext: vi.fn(async () => ({
    config: {},
    hasThread: false,
  })),
}));
vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild: vi.fn(async () => undefined),
  restoreMonoCodexAgentState: vi.fn(async () => undefined),
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));
vi.mock("../../../../platform/tauri/fs", () => ({
  saveGeneratedImage: vi.fn(),
  deleteGeneratedImages: vi.fn(async () => undefined),
}));

const { sendCodexTurn, stopCodexSession, __codexTestReset } =
  await import("./codex");
import { mapCodexNotification } from "./codexProtocol";
import type { HarnessEvent } from "../../core/types";

type Message = { id?: number; method?: string };
const parse = () => sent.map((line) => JSON.parse(line) as Message);
const reply = (id: number, result: unknown) =>
  onLine!(JSON.stringify({ id, result }));
const notify = (method: string, params: unknown) =>
  onLine!(JSON.stringify({ method, params }));
async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
const request = (method: string) => parse().find((m) => m.method === method)!;

afterEach(async () => {
  await stopCodexSession("codex-started");
  __codexTestReset();
  sent.length = 0;
});

describe("Codex's turn/started", () => {
  it("maps to turn.started", () => {
    expect(
      mapCodexNotification("turn/started", { turn: { id: "turn_9" } }).events,
    ).toEqual([{ type: "turn.started", providerTurnId: "turn_9" }]);
  });

  it("starts the turn once, before the turn/start reply", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendCodexTurn({
      sessionId: "codex-started",
      cwd: "/repo",
      model: "codex:gpt-5.4",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "hi",
      attachments: [],
      onAccepted: () => events.push({ type: "turn.ready" }),
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => parse().some((m) => m.method === "initialize"), "init");
    reply(request("initialize").id!, {});
    await waitFor(
      () => parse().some((m) => m.method === "thread/start"),
      "thread",
    );
    reply(request("thread/start").id!, { thread: { id: "thr_1" } });
    await waitFor(() => parse().some((m) => m.method === "turn/start"), "turn");
    notify("turn/started", { turn: { id: "turn_1", status: "inProgress" } });
    notify("turn/completed", { turn: { id: "turn_1", status: "completed" } });
    reply(request("turn/start").id!, {
      turn: { id: "turn_1", status: "inProgress" },
    });
    await turn;
    const kinds = events
      .map((e) => e.type)
      .filter((t) => t === "turn.started" || t === "turn.ready");
    expect(kinds).toEqual(["turn.started", "turn.ready"]);
  });
});
