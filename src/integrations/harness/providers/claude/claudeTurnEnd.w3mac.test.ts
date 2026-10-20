import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mac test 2.8: "No active turn to steer", and a turn that "finished without
// a reply" while Claude Code still waited on an approval. Stop finishes
// MonoCode's turn at once, but Claude Code still sends the stopped turn's
// result (all of 2.1.292 to 2.1.304, tests/cli-contract probe of 20 Oct:
// `result:error_during_execution` naming the stopped prompt's uuid). Sent
// after the next prompt went out, that result ended the new turn.

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("../../core/existingDirs", () => ({
  existingDirs: async (dirs?: readonly string[]) => [...(dirs ?? [])],
}));
vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  sendClaudeTurn,
  steerClaudeTurn,
  cancelClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");
import { buildClaudeSpawnArgs, CLAUDE_SESSION_ENV } from "./claudeProtocol";
import type { HarnessEvent } from "../../core/types";

const base = {
  sessionId: "s1",
  cwd: "/tmp/proj",
  model: "claude:claude-sonnet-5",
  modelSettings: {},
  runtimeMode: "supervised" as const,
  attachments: [],
};
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const state = (s: string) =>
  emit({ type: "system", subtype: "session_state_changed", state: s });

/** The uuids of the user messages sent so far, in order. */
function userUuids(): (string | undefined)[] {
  return sent
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((m) => m.type === "user")
    .map((m) => m.uuid as string | undefined);
}

function settled(promise: Promise<unknown>) {
  const flag = { done: false };
  void promise.then(
    () => (flag.done = true),
    () => (flag.done = true),
  );
  return flag;
}

async function start(text: string, events: HarnessEvent[]) {
  const done = sendClaudeTurn({
    ...base,
    text,
    onEvent: (event) => events.push(event),
  });
  await vi.advanceTimersByTimeAsync(0);
  if (!initialized) {
    initialized = true;
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await vi.advanceTimersByTimeAsync(0);
  }
  // Wrapped: an async function returning the promise would wait on it.
  return { done };
}
let initialized = false;

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  onLine = undefined;
  initialized = false;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
  vi.useRealTimers();
});

describe("when a Claude Code turn ends", () => {
  it("asks Claude Code for its session state events", () => {
    expect(CLAUDE_SESSION_ENV).toMatchObject({
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    });
    const args = buildClaudeSpawnArgs({ model: "m" } as never);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
  });

  it("a stopped turn's late result does not end the next turn", async () => {
    const events: HarnessEvent[] = [];
    const { done: first } = await start("run the long thing", events);
    await vi.advanceTimersByTimeAsync(0);
    await cancelClaudeTurn("s1");
    await first;

    const { done: second } = await start("next prompt", events);
    const flag = settled(second);
    await vi.advanceTimersByTimeAsync(0);
    const [stopped, next] = userUuids();
    // The stopped turn's result, after the next prompt went out.
    emit({
      type: "result",
      subtype: "error_during_execution",
      session_id: "sess_1",
      is_error: true,
      user_message_uuid: stopped ?? "uuid-of-the-stopped-prompt",
      user_message_uuids: [stopped ?? "uuid-of-the-stopped-prompt"],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.done).toBe(false);
    // Still a turn to steer.
    await expect(
      steerClaudeTurn({ ...base, text: "also this" } as never),
    ).resolves.toBeUndefined();

    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
      user_message_uuid: next,
      user_message_uuids: [next],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.done).toBe(true);
    await second;
  });

  it("every prompt and steer goes with a fresh uuid", async () => {
    const events: HarnessEvent[] = [];
    const { done } = await start("one", events);
    await steerClaudeTurn({ ...base, text: "two" } as never);
    const uuids = userUuids();
    expect(uuids).toHaveLength(2);
    expect(uuids.every((u) => typeof u === "string" && u.length > 0)).toBe(
      true,
    );
    expect(new Set(uuids).size).toBe(2);
    // A result for the steer counts for this turn.
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
      user_message_uuid: uuids[1],
      user_message_uuids: uuids,
    });
    await vi.advanceTimersByTimeAsync(0);
    await done;
  });

  it("once Claude Code reports its state, idle ends the turn, not the result", async () => {
    const events: HarnessEvent[] = [];
    const { done } = await start("one", events);
    const flag = settled(done);
    state("running");
    state("requires_action");
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.done).toBe(false);
    state("running");
    const [uuid] = userUuids();
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
      user_message_uuid: uuid,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.done).toBe(false);
    state("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.done).toBe(true);
    await done;
  });

  it("an older Claude Code with no state events still ends on its result", async () => {
    const events: HarnessEvent[] = [];
    const { done } = await start("one", events);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await vi.advanceTimersByTimeAsync(0);
    await done;
  });

  it("a late idle from the stopped turn does not end the next one", async () => {
    const events: HarnessEvent[] = [];
    const { done: first } = await start("one", events);
    state("running");
    await cancelClaudeTurn("s1");
    await first;
    const { done: second } = await start("two", events);
    const flag = settled(second);
    await vi.advanceTimersByTimeAsync(0);
    const [stopped, next] = userUuids();
    emit({
      type: "result",
      subtype: "error_during_execution",
      session_id: "sess_1",
      is_error: true,
      user_message_uuid: stopped,
    });
    state("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.done).toBe(false);
    state("running");
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
      user_message_uuid: next,
    });
    state("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(flag.done).toBe(true);
  });
});
