import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code?: number | null) => void) | undefined;

vi.mock("../../core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) => [...(dirs ?? [])],
}));

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (code?: number | null) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  REWIND_INIT_TIMEOUT_MS,
  rewindClaudeLastTurn,
  sendClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");
import { CHAT_REWIND_TIMEOUT_MS } from "../../../../features/rewind/model/chatRewindRun";
import type { HarnessEvent } from "../../core/types";

const base = {
  sessionId: "s1",
  cwd: "/repo",
  model: "claude:claude-sonnet-5",
  modelSettings: {},
  runtimeMode: "supervised" as const,
  attachments: [],
};

const parse = () =>
  sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const userCount = () => parse().filter((m) => m.type === "user").length;

/** Lets the async start-up steps run under fake timers. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function turn(text: string, uuid: string, first: boolean) {
  const before = userCount();
  const done = sendClaudeTurn({ ...base, text, onEvent: () => undefined });
  await settle();
  if (first) {
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await settle();
  }
  expect(userCount()).toBe(before + 1);
  emit({
    type: "assistant",
    session_id: "sess_1",
    uuid,
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "ok" }] },
  });
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await settle();
  await done;
}

/** The tester's chat: three turns, so turn 2 follows the end of turn 1. */
async function threeTurns() {
  await turn("Turn 1", "uuid-end-of-turn-1", true);
  await turn("Turn 2", "uuid-end-of-turn-2", false);
  await turn("Turn 3", "uuid-end-of-turn-3", false);
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  onExit = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
  vi.useRealTimers();
});

describe("Claude Code rewind to an earlier turn (session 6)", () => {
  it("waits longer than a plain start, and less than the menu does", () => {
    expect(REWIND_INIT_TIMEOUT_MS).toBeGreaterThan(8_000);
    expect(REWIND_INIT_TIMEOUT_MS).toBeLessThan(CHAT_REWIND_TIMEOUT_MS);
  });

  it("succeeds when Claude Code takes 20 s to load the cut conversation", async () => {
    await threeTurns();
    const events: HarnessEvent[] = [];
    const starts = spawned.length;
    const done = rewindClaudeLastTurn({
      ...base,
      providerTurnId: "uuid-end-of-turn-1",
      onEvent: (event) => events.push(event),
    });
    const outcome = done.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await settle();
    expect(spawned).toHaveLength(starts + 1);
    const args = spawned[starts];
    expect(args[args.indexOf("--resume") + 1]).toBe("sess_1");
    expect(args[args.indexOf("--resume-session-at") + 1]).toBe(
      "uuid-end-of-turn-1",
    );
    // The 8 s limit of a plain start passes with no answer yet.
    await settle(20_000);
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await settle();
    expect(await outcome).toEqual({ ok: true, value: { submitted: false } });
    expect(events.map((event) => event.type)).toEqual([
      "session.providerBound",
      "session.started",
    ]);
  });

  it("fails with an error, and keeps the conversation whole, when Claude Code never starts", async () => {
    await threeTurns();
    const starts = spawned.length;
    const done = rewindClaudeLastTurn({
      ...base,
      providerTurnId: "uuid-end-of-turn-1",
      onEvent: () => undefined,
    });
    const outcome = done.then(
      () => "resolved",
      (error: unknown) => (error as Error).message,
    );
    await settle(REWIND_INIT_TIMEOUT_MS);
    expect(await outcome).toBe(
      "Claude Code did not start in time to edit this message. Try again",
    );
    // The next prompt resumes the whole conversation, not the cut.
    const next = sendClaudeTurn({ ...base, text: "go on", onEvent: () => undefined });
    await settle();
    expect(spawned).toHaveLength(starts + 2);
    expect(spawned[starts + 1]).toEqual(
      expect.arrayContaining(["--resume", "sess_1"]),
    );
    expect(spawned[starts + 1]).not.toContain("--resume-session-at");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await settle();
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await settle();
    await next;
  });

  it("fails at once when Claude Code exits on the cut", async () => {
    await threeTurns();
    const done = rewindClaudeLastTurn({
      ...base,
      providerTurnId: "uuid-end-of-turn-1",
      onEvent: () => undefined,
    });
    const outcome = done.then(
      () => "resolved",
      (error: unknown) => (error as Error).message,
    );
    await settle();
    onExit?.(1);
    await settle();
    expect(await outcome).toBe(
      "Claude Code could not go back to before this message",
    );
  });
});
