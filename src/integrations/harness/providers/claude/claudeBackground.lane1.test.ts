import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import type { BackgroundItem } from "../../core/background";
import { applyHarnessEvent, stopStreaming } from "../../core/apply";
import { newSession } from "../../../../features/sessions/model/session";
import { claudeBackgroundItems, claudeBackgroundKind } from "./claudeBackground";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

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
  cancelClaudeTurn,
  sendClaudeTurn,
  stopClaudeSession,
  stopClaudeBackgroundTask,
  __claudeTestReset,
} = await import("./claude");

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startTurn(sessionId: string) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "run the tests in the background",
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

function taskStarted(taskId: string, taskType: string, description: string) {
  emit({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description,
    task_type: taskType,
  });
}

function itemLists(events: HarnessEvent[]): BackgroundItem[][] {
  return events.flatMap((event) =>
    event.type === "background.items" ? [event.items] : [],
  );
}

function stopRequests(): string[] {
  return parse().flatMap((m) => {
    const request = m.request as Record<string, unknown> | undefined;
    return request?.subtype === "stop_task" ? [String(request.task_id)] : [];
  });
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

describe("claudeBackgroundKind", () => {
  it("tells subagents, monitors and shells apart", () => {
    expect(claudeBackgroundKind("local_agent")).toBe("subagent");
    expect(claudeBackgroundKind("remote_agent")).toBe("subagent");
    expect(claudeBackgroundKind("local_monitor")).toBe("monitor");
    expect(claudeBackgroundKind("local_bash")).toBe("shell");
    expect(claudeBackgroundKind(undefined)).toBe("shell");
    expect(claudeBackgroundKind("something_new")).toBe("shell");
  });

  it("lists every task as stoppable, newest first", () => {
    const items = claudeBackgroundItems(
      new Map([
        ["a", { description: "Older", taskType: "local_bash", startedAt: 10 }],
        ["b", { description: "Newer", taskType: "local_agent", startedAt: 20 }],
        ["c", { description: "  ", taskType: "local_bash" }],
      ]),
    );
    expect(items.map((item) => [item.id, item.kind, item.title])).toEqual([
      ["b", "subagent", "Newer"],
      ["a", "shell", "Older"],
      ["c", "shell", "Background task"],
    ]);
    expect(items.every((item) => item.stoppable && item.source === "harness"))
      .toBe(true);
  });
});

describe("claude Running items", () => {
  it("lists a task while Claude still works, not only after it yields", async () => {
    const { events } = await startTurn("s1");
    taskStarted("b1", "local_bash", "Run the test suite");
    await waitFor(() => itemLists(events).length > 0, "items");
    expect(itemLists(events).at(-1)).toMatchObject([
      { id: "b1", kind: "shell", title: "Run the test suite", status: "running" },
    ]);
    // No yield yet, so the older "waiting on" list stays empty.
    expect(events.some((event) => event.type === "background.updated")).toBe(
      false,
    );
  });

  it("sends a list once per change, not on every event", async () => {
    const { events } = await startTurn("s1");
    taskStarted("b1", "local_bash", "Run the test suite");
    taskStarted("b1", "local_bash", "Run the test suite");
    taskStarted("m1", "local_monitor", "Watch the log");
    await new Promise((r) => setTimeout(r, 20));
    const lists = itemLists(events).map((list) =>
      list.map((item) => item.id).sort(),
    );
    expect(lists).toEqual([["b1"], ["b1", "m1"]]);
    expect(itemLists(events)[1].find((item) => item.id === "m1")?.kind).toBe(
      "monitor",
    );
  });

  it("clears the list once the cancelled turn stops streaming", async () => {
    const { events, turn } = await startTurn("s1");
    taskStarted("b1", "local_bash", "Run the test suite");
    await waitFor(() => itemLists(events).length > 0, "items");
    await cancelClaudeTurn("s1");
    await turn.catch(() => undefined);
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    // Claude was told to stop every task; the app stops streaming the turn.
    expect(stopRequests()).toEqual(["b1"]);
    expect(stopStreaming(session).backgroundItems).toBeUndefined();
  });

  it("stops one task by id with stop_task", async () => {
    await startTurn("s1");
    taskStarted("b1", "local_bash", "Run the test suite");
    taskStarted("b2", "local_bash", "Serve the docs");
    await expect(stopClaudeBackgroundTask("s1", "b2")).resolves.toBe(true);
    expect(stopRequests()).toEqual(["b2"]);
  });

  it("refuses a task or session it does not know", async () => {
    await expect(stopClaudeBackgroundTask("nope", "b1")).resolves.toBe(
      false,
    );
    await startTurn("s1");
    await expect(stopClaudeBackgroundTask("s1", "missing")).resolves.toBe(
      false,
    );
    expect(stopRequests()).toEqual([]);
  });
});
