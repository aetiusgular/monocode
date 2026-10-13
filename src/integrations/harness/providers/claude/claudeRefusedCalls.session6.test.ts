import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../core/apply";
import { newSession } from "../../../../features/sessions/model/session";
import { suggestPrompts } from "../../../../features/suggested-prompts/model/suggestions";
import type { HarnessEvent, HarnessToolAccess } from "../../core/types";

// Mac 1.11 / 11.T2.1: a background task the user stopped, and a call a Never
// rule blocked, raised "Fix the failing command". Neither ran and exited
// non-zero. Both now settle as cancelled; a command that ran and failed
// stays failed.

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));
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

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } =
  await import("./claude");
const { claudeBlockedToolMessage } = await import("./claudeProtocol");

const parse = () =>
  sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function startTurn(toolAccess?: HarnessToolAccess) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId: "s1",
    cwd: "/Users/tony/my proj",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    toolAccess,
    text: "run the tests",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(
    () =>
      parse().some(
        (m) =>
          (m.request as Record<string, unknown> | undefined)?.subtype ===
          "initialize",
      ),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  return { events, turn };
}

function toolUse(id: string, input: Record<string, unknown>) {
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [{ type: "tool_use", id, name: "Bash", input }],
    },
  });
}

function toolResult(id: string, content: string) {
  emit({
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content, is_error: true },
      ],
    },
  });
}

const answered = (requestId: string) =>
  parse().some(
    (m) => (m.response as Record<string, unknown>)?.request_id === requestId,
  );

function chips(events: HarnessEvent[]) {
  const session = events.reduce(
    applyHarnessEvent,
    newSession("claude", "/Users/tony/my proj"),
  );
  const blocks = [
    { id: "u", role: "user" as const, text: "run the tests" },
    ...session.blocks.filter((block) => block.role !== "user"),
  ];
  return {
    blocks,
    ids: suggestPrompts({
      blocks,
      busy: false,
      hasDraft: false,
      state: { changes: null },
    }).map((chip) => chip.id),
  };
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
});

describe("calls that never ran", () => {
  it("a call a Never rule refused settles cancelled, with no fix chip", async () => {
    const { events, turn } = await startTurn({ never: ["Bash"] });
    toolUse("toolu_1", { command: "ls -- '-my notes.md'" });
    emit({
      type: "control_request",
      request_id: "r1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
        input: { command: "ls -- '-my notes.md'" },
      },
    });
    await waitFor(() => answered("r1"), "answer to r1");
    toolResult("toolu_1", claudeBlockedToolMessage("Bash"));
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    const { blocks, ids } = chips(events);
    expect(blocks.find((b) => b.tool?.callId === "toolu_1")?.tool?.status).toBe(
      "cancelled",
    );
    expect(ids).not.toContain("failed-command");
  });

  it("a command that ran and exited non-zero still offers the fix", async () => {
    const { events, turn } = await startTurn();
    toolUse("toolu_2", { command: "npm test" });
    toolResult("toolu_2", "Error: Exit code 1\n1 failing");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    const { blocks, ids } = chips(events);
    expect(blocks.find((b) => b.tool?.callId === "toolu_2")?.tool?.status).toBe(
      "failed",
    );
    expect(ids).toContain("failed-command");
  });

  it("a background task the user stopped settles cancelled", async () => {
    const { events, turn } = await startTurn();
    toolUse("toolu_bg", { command: "seq 1 3000", run_in_background: true });
    emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "b1", task_type: "local_bash", description: "seq" }],
    });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "b1",
      tool_use_id: "toolu_bg",
      description: "seq",
      task_type: "local_bash",
    });
    emit({
      type: "user",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_bg",
            content: "Command running in background with ID: b1",
          },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await waitFor(
      () =>
        events.some(
          (e) => e.type === "tool.started" && e.callId === "background:b1",
        ),
      "background row",
    );
    // The Stop button on the row.
    emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "b1",
      tool_use_id: "toolu_bg",
      status: "killed",
      summary: 'Background command "seq 1 3000" was stopped',
    });
    await waitFor(
      () =>
        events.some(
          (e) => e.type === "tool.updated" && e.callId === "background:b1",
        ),
      "background row settled",
    );
    void turn.catch(() => undefined);
    const { blocks, ids } = chips(events);
    expect(
      blocks.find((b) => b.tool?.callId === "background:b1")?.tool?.status,
    ).toBe("cancelled");
    expect(ids).not.toContain("failed-command");
  });
});
