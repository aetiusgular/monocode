import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/reasoningOnlyEnd.json";

// Mac finding 3.7, retest 3. The fixture is what the real Codex 0.161.0
// app-server sent for one turn whose first model request called
// exec_command and whose last returned only a reasoning item
// (tests/cli-contract, check reasoning-only-end). It is replayed here through
// MonoCode's own Codex handling, then the chat's turn-end pass.

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("./codexStore", () => ({
  prepareCodexMonoContext: vi.fn(async () => ({ config: {}, hasThread: false })),
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

const { sendCodexTurn, stopCodexSession, __codexTestReset } = await import(
  "./codex"
);
import type { HarnessEvent } from "../../core/types";
import { newSession } from "../../../../features/sessions/model/session";
import {
  appendUser,
  applyHarnessEvents,
  stopStreaming,
} from "../../core/apply";
import {
  EMPTY_TURN_NOTICE,
  stoppedAfterStepsNotice,
  withEmptyTurnNotice,
} from "../../../../features/sessions/model/emptyTurn";

type Message = { id?: number; method?: string; params?: unknown };

function parse(): Message[] {
  return sent.map((line) => JSON.parse(line) as Message);
}

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function answer(method: string, result: unknown) {
  await waitFor(() => parse().some((m) => m.method === method), method);
  const id = parse().find((m) => m.method === method)!.id!;
  onLine!(JSON.stringify({ id, result }));
}

const PROMPT = "Change the greeting in hello.py to hello.";

describe("Codex 0.161.0: a turn that ends on a reasoning-only step", () => {
  afterEach(async () => {
    await stopCodexSession("ro-end");
    __codexTestReset();
    sent.length = 0;
  });

  it("the fixture is the case: a command ran, no agent message came", () => {
    const types = fixture.notifications
      .filter((n) => n.method === "item/completed")
      .map((n) => (n.params as { item?: { type?: string } }).item?.type);
    expect(types).toContain("commandExecution");
    expect(types).toContain("reasoning");
    expect(types).not.toContain("agentMessage");
    const done = fixture.notifications.find((n) => n.method === "turn/completed");
    expect(
      (done?.params as { turn?: { status?: string; items?: unknown[] } }).turn,
    ).toMatchObject({ status: "completed", items: [] });
  });

  it("replayed through MonoCode, the chat gets the steps notice", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendCodexTurn({
      sessionId: "ro-end",
      cwd: "/work",
      model: "codex:fake-model",
      modelSettings: {},
      runtimeMode: "full-access",
      text: PROMPT,
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await answer("initialize", {});
    await answer("thread/start", { thread: { id: fixture.threadId } });
    await answer("turn/start", {
      turn: { id: fixture.turnId, status: "inProgress" },
    });
    for (const note of fixture.notifications) {
      onLine!(JSON.stringify({ method: note.method, params: note.params }));
    }
    await turn;

    let chat = appendUser(newSession("codex", "/work", "codex:fake-model"), PROMPT);
    chat = applyHarnessEvents(chat, events);
    const finished = withEmptyTurnNotice(stopStreaming(chat));

    const roles = finished.blocks.map((block) => block.role);
    expect(roles).toContain("tool");
    expect(roles).toContain("reasoning");
    expect(
      finished.blocks.some(
        (block) => block.role === "assistant" && block.text.trim(),
      ),
    ).toBe(false);
    const last = finished.blocks.at(-1);
    expect(last?.text).toBe(stoppedAfterStepsNotice(1));
    expect(last?.text).not.toBe(EMPTY_TURN_NOTICE);
    expect(last?.notice).toBe("error");
  });
});
