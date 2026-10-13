import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 1.6: "Rewind chat to here" was off on a Claude Code turn sent minutes
// earlier, with "sent before a restart or a compaction". The chat predated an
// app restart. Its process was started with `--resume`, which streams no
// entry of the old conversation, so the first prompt after the restart had no
// entry to follow and was sent without a boundary.

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
const lastEntry = vi.hoisted(() => ({
  value: "uuid-last-before-restart" as unknown,
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
  bindClaudeSession,
  sendClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
  CLAUDE_FIRST_TURN,
} = await import("./claude");
import type { HarnessEvent } from "../../core/types";

const base = {
  sessionId: "s1",
  cwd: "/Users/tony/my proj",
  model: "claude:claude-sonnet-5",
  modelSettings: {},
  runtimeMode: "supervised" as const,
  attachments: [],
};
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));

async function turn(
  text: string,
  uuid: string,
  events: HarnessEvent[],
  providerAccountId?: string,
) {
  const done = sendClaudeTurn({
    ...base,
    ...(providerAccountId ? { providerAccountId } : {}),
    text,
    onEvent: (event) => events.push(event),
  });
  await vi.advanceTimersByTimeAsync(0);
  emit({ type: "system", subtype: "init", session_id: "sess_old" });
  await vi.advanceTimersByTimeAsync(0);
  emit({
    type: "assistant",
    session_id: "sess_old",
    uuid,
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "ok" }] },
  });
  emit({ type: "result", subtype: "success", session_id: "sess_old" });
  await vi.advanceTimersByTimeAsync(0);
  await done;
}

const boundaries = (events: HarnessEvent[]) =>
  events.flatMap((event) =>
    event.type === "turn.started" ? [event.providerTurnId] : [],
  );

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  onLine = undefined;
  lastEntry.value = "uuid-last-before-restart";
  lastEntry.calls = [];
  lastEntry.fail = false;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
  vi.useRealTimers();
});

describe("a Claude Code chat resumed after an app restart", () => {
  it("records a boundary for its first prompt from the transcript's end", async () => {
    // What the app does on launch for a saved chat.
    bindClaudeSession("s1", "sess_old", base.cwd);
    const events: HarnessEvent[] = [];
    await turn("Turn after restart", "uuid-a", events);
    await turn("Next turn", "uuid-b", events);
    expect(boundaries(events)).toEqual(["uuid-last-before-restart", "uuid-a"]);
    expect(lastEntry.calls).toEqual([
      { cwd: base.cwd, sessionId: "sess_old", accountId: null },
    ]);
  });

  it("asks the named account's transcripts", async () => {
    bindClaudeSession("s1", "sess_old", base.cwd, "work");
    await turn("x", "uuid-a", [], "work");
    expect(lastEntry.calls[0]).toMatchObject({ accountId: "work" });
  });

  it("sends with no boundary when the transcript cannot be read", async () => {
    lastEntry.fail = true;
    bindClaudeSession("s1", "sess_old", base.cwd);
    const events: HarnessEvent[] = [];
    await turn("x", "uuid-a", events);
    await turn("y", "uuid-b", events);
    // The first stays unknown; the second follows what the first streamed.
    expect(boundaries(events)).toEqual(["uuid-a"]);
  });

  it("ignores an answer that is not an entry id", async () => {
    lastEntry.value = "--resume-session-at x";
    bindClaudeSession("s1", "sess_old", base.cwd);
    const events: HarnessEvent[] = [];
    await turn("x", "uuid-a", events);
    expect(boundaries(events)).toEqual([]);
  });

  it("does not read a transcript for a new conversation", async () => {
    const events: HarnessEvent[] = [];
    await turn("x", "uuid-a", events);
    expect(boundaries(events)).toEqual([CLAUDE_FIRST_TURN]);
    expect(lastEntry.calls).toEqual([]);
  });
});
