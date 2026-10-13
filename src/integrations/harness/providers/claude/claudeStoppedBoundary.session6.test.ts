import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mac 11.T2.8: Retry under a reply carried a request the user had stopped in
// an earlier turn. The turn ran `seq 1 3000` and was stopped with Escape. The
// next prompt's boundary was the stopped turn's tool_use entry, because the
// entries Claude Code writes for a stop are not streamed. Retry cut the
// conversation back there, and Claude Code ran the stopped call again.

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
const lastEntry = vi.hoisted(() => ({
  value: "uuid-interrupt-note" as unknown,
  calls: [] as Array<Record<string, unknown>>,
  fail: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command !== "claude_session_last_entry") return undefined;
    lastEntry.calls.push(args);
    if (lastEntry.fail) throw new Error("no file");
    return lastEntry.value;
  }),
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
  cancelClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");
import type { HarnessEvent } from "../../core/types";

const base = {
  sessionId: "s1",
  cwd: "/Users/tony/-dash proj",
  model: "claude:claude-sonnet-5",
  modelSettings: {},
  runtimeMode: "supervised" as const,
  attachments: [],
};
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const boundaries = (events: HarnessEvent[]) =>
  events.flatMap((event) =>
    event.type === "turn.started" ? [event.providerTurnId] : [],
  );

function answer(uuid: string) {
  emit({
    type: "assistant",
    session_id: "sess_1",
    uuid,
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "ok" }] },
  });
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
}

async function stoppedSeqTurn(events: HarnessEvent[]) {
  const done = sendClaudeTurn({
    ...base,
    text: "run seq 1 3000",
    onEvent: (event) => events.push(event),
  });
  await vi.advanceTimersByTimeAsync(0);
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  await vi.advanceTimersByTimeAsync(0);
  emit({
    type: "assistant",
    session_id: "sess_1",
    uuid: "uuid-tool-use",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "seq 1 3000" },
        },
      ],
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  await cancelClaudeTurn("s1");
  await vi.advanceTimersByTimeAsync(0);
  await done;
}

async function turn(text: string, uuid: string, events: HarnessEvent[]) {
  const done = sendClaudeTurn({
    ...base,
    text,
    onEvent: (event) => events.push(event),
  });
  await vi.advanceTimersByTimeAsync(0);
  answer(uuid);
  await vi.advanceTimersByTimeAsync(0);
  await done;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  onLine = undefined;
  lastEntry.value = "uuid-interrupt-note";
  lastEntry.calls = [];
  lastEntry.fail = false;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
  vi.useRealTimers();
});

describe("the prompt after a stopped Claude Code turn", () => {
  it("follows the transcript's last entry, not the stopped tool_use", async () => {
    const events: HarnessEvent[] = [];
    await stoppedSeqTurn(events);
    await turn("what is 2+2", "uuid-b", events);
    expect(boundaries(events).at(-1)).toBe("uuid-interrupt-note");
    expect(boundaries(events)).not.toContain("uuid-tool-use");
    expect(lastEntry.calls).toEqual([
      { cwd: base.cwd, sessionId: "sess_1", accountId: null },
    ]);
  });

  it("reads the transcript even when an entry streamed after the stop", async () => {
    const events: HarnessEvent[] = [];
    const done = sendClaudeTurn({
      ...base,
      text: "run seq 1 3000",
      onEvent: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await vi.advanceTimersByTimeAsync(0);
    await cancelClaudeTurn("s1");
    // The tool_use arrives while the stop settles.
    emit({
      type: "assistant",
      session_id: "sess_1",
      uuid: "uuid-tool-use",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }] },
    });
    await vi.advanceTimersByTimeAsync(0);
    await done;
    await turn("what is 2+2", "uuid-b", events);
    expect(boundaries(events).at(-1)).toBe("uuid-interrupt-note");
  });

  it("has no boundary when the transcript cannot be read", async () => {
    lastEntry.fail = true;
    const events: HarnessEvent[] = [];
    await stoppedSeqTurn(events);
    await turn("what is 2+2", "uuid-b", events);
    await turn("and 3+3", "uuid-c", events);
    // The second prompt is not taken back past the stop; the third follows
    // what the second streamed.
    expect(boundaries(events).slice(1)).toEqual(["uuid-b"]);
  });

  it("does not read the transcript after a turn that finished", async () => {
    const events: HarnessEvent[] = [];
    const done = sendClaudeTurn({
      ...base,
      text: "first",
      onEvent: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await vi.advanceTimersByTimeAsync(0);
    answer("uuid-a");
    await vi.advanceTimersByTimeAsync(0);
    await done;
    await turn("second", "uuid-b", events);
    expect(boundaries(events).at(-1)).toBe("uuid-a");
    expect(lastEntry.calls).toEqual([]);
  });
});
