import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../core/apply";
import { newSession } from "../../../../features/sessions/model/session";
import {
  foldableWork,
  foldedBlocks,
  groupTurnItems,
  workSummaryLine,
} from "../../../../features/sessions/model/transcriptActivity";

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code?: number | null) => void) | undefined;
const writeChild = vi.fn(async (_id: string, line: string) => {
  sent.push(line);
});

const existingDirs = vi.hoisted(() =>
  vi.fn(async (dirs?: readonly string[]) => [...(dirs ?? [])]),
);
vi.mock("../../core/existingDirs", () => ({ existingDirs }));

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
  writeChild,
}));

const {
  bindClaudeSession,
  cancelClaudeTurn,
  compactClaudeContext,
  respondClaudeApproval,
  respondClaudeQuestion,
  restoreClaudeTaskLists,
  rewindClaudeLastTurn,
  sendClaudeTurn,
  stopClaudeSession,
  CLAUDE_FIRST_TURN,
  __claudeTestReset,
} = await import("./claude");
import type { HarnessEvent } from "../../core/types";
import type { RuntimeMode, TurnIntent } from "../../../../features/sessions/model/session";

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(parse())}`,
  );
};

async function startTurn(
  sessionId: string,
  options: {
    runtimeMode?: RuntimeMode;
    intent?: TurnIntent;
    providerAccountId?: string;
  } = {},
) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    intent: options.intent,
    providerAccountId: options.providerAccountId,
    text: "explore the codebase",
    attachments: [],
    onEvent: (event) => events.push(event),
  });

  await waitFor(
    () =>
      parse().some((m) => {
        const request = m.request as Record<string, unknown> | undefined;
        return request?.subtype === "initialize";
      }),
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

/** What Claude streams when a finished task wakes it for another turn. */
function emitFollowUpTurn(text: string) {
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "stream_event",
    session_id: "sess_1",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: { content: [{ type: "text", text }] },
  });
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
}

/** A subagent Claude ran inline: its report comes back on the parent's stream. */
function emitInlineSubagent(taskId = "t1") {
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_agent",
          name: "Task",
          input: {
            description: "Explore the auth module",
            subagent_type: "explore",
          },
        },
      ],
    },
  });
  emit({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: "toolu_agent",
    description: "Explore the auth module",
    task_type: "local_agent",
  });
  emit({
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_agent",
          content: "Auth lives in src/auth.",
        },
      ],
    },
  });
}

function emitBackgroundBash(taskId = "b1") {
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_bash",
          name: "Bash",
          input: { command: "sleep 30 && echo done", run_in_background: true },
        },
      ],
    },
  });
  emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      {
        task_id: taskId,
        task_type: "local_bash",
        description: "Wait 30 seconds then print done",
      },
    ],
  });
  emit({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: "toolu_bash",
    description: "Wait 30 seconds then print done",
    task_type: "local_bash",
  });
  emit({
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          content: `Command running in background with ID: ${taskId}`,
        },
      ],
    },
  });
  emit({
    type: "stream_event",
    session_id: "sess_1",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "waiting" },
    },
  });
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: { content: [{ type: "text", text: "waiting" }] },
  });
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
}

function emitBashFinished(taskId = "b1") {
  emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  emit({
    type: "system",
    subtype: "task_updated",
    task_id: taskId,
    patch: { status: "completed" },
  });
  emit({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: "toolu_bash",
    status: "completed",
    summary: 'Background command "sleep 30 && echo done" completed (exit code 0)',
  });
}

function backgroundUpdates(events: HarnessEvent[]): string[][] {
  return events.flatMap((event) =>
    event.type === "background.updated" ? [event.tasks] : [],
  );
}

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  onExit = undefined;
  writeChild.mockClear();
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
});

describe("claude streamed tool inputs", () => {
  it("replaces an empty Shell row with the complete assistant tool input", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "stream_event",
      session_id: "sess_1",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_shell",
          name: "Bash",
          input: {},
        },
      },
    });
    emit({
      type: "stream_event",
      session_id: "sess_1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"command":"git status',
        },
      },
    });
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_shell",
            name: "Bash",
            input: {
              command: "git status --short",
              description: "Check changes",
            },
          },
        ],
      },
    });
    emit({
      type: "user",
      session_id: "sess_1",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_shell", content: "clean" },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.updated",
        callId: "toolu_shell",
        title: "git status --short",
        status: "pending",
      }),
    );
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const tool = session.blocks.find(
      (block) => block.tool?.callId === "toolu_shell",
    );
    expect(tool?.text).toBe("git status --short");
    expect(tool?.tool?.status).toBe("completed");
  });
});

describe("claude task tools", () => {
  function emitTaskTool(
    id: string,
    name: string,
    input: Record<string, unknown>,
    result: string,
    providerSessionId = "sess_1",
  ) {
    emit({
      type: "assistant",
      session_id: providerSessionId,
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
    emit({
      type: "user",
      session_id: providerSessionId,
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: result }],
      },
    });
  }

  it("builds the task list from TaskCreate and TaskUpdate, not subagent rows", async () => {
    const { events, turn } = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests", description: "Cover the parser" },
      "Task #1 created successfully: Write tests",
    );
    emitTaskTool(
      "toolu_c2",
      "TaskCreate",
      { subject: "Ship it", description: "Open the PR" },
      "Task #2 created successfully: Ship it",
    );
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "in_progress" },
      "Updated task #1 status",
    );
    emitTaskTool(
      "toolu_u2",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const lists = session.blocks.filter((block) => block.role === "tasks");
    expect(lists).toHaveLength(1);
    expect(lists[0].taskList?.items).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
      { id: "2", text: "Ship it", status: "pending" },
    ]);
    expect(
      session.blocks.some(
        (block) => block.tool?.kind === "agent" || block.agent !== undefined,
      ),
    ).toBe(false);
  });

  it("keeps earlier tasks updatable after a restart resumes the conversation", async () => {
    const first = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests", description: "Cover the parser" },
      "Task #1 created successfully: Write tests",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const events: HarnessEvent[] = [...first.events];
    const userCount = parse().filter(
      (message) => message.type === "user",
    ).length;
    const second = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:opus-5",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "finish it",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => spawned.length === 2, "replacement Claude process");
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length > userCount,
      "follow-up prompt",
    );
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const lists = session.blocks.filter((block) => block.role === "tasks");
    expect(lists.at(-1)?.taskList?.items).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
    ]);
  });

  /** A later turn that must launch a new Claude process. */
  async function restartedTurn(
    events: HarnessEvent[],
    options: {
      intent?: TurnIntent;
      providerAccountId?: string;
      providerSessionId?: string;
    } = {},
  ) {
    const spawnCount = spawned.length;
    const userCount = parse().filter(
      (message) => message.type === "user",
    ).length;
    const turn = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      intent: options.intent,
      providerAccountId: options.providerAccountId,
      text: "finish it",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(
      () => spawned.length === spawnCount + 1,
      "replacement Claude process",
    );
    emit({
      type: "system",
      subtype: "init",
      session_id: options.providerSessionId ?? "sess_1",
    });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length > userCount,
      "follow-up prompt",
    );
    return { turn };
  }

  function lastTaskItems(events: HarnessEvent[]) {
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    return session.blocks.filter((block) => block.role === "tasks").at(-1)
      ?.taskList?.items;
  }

  it("shows a TaskUpdate subject rename in the panel", async () => {
    const { events, turn } = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests", description: "Cover the parser" },
      "Task #1 created successfully: Write tests",
    );
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", subject: "Write parser tests", status: "in_progress" },
      "Updated task #1 subject, status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write parser tests", status: "in_progress" },
    ]);
  });

  it("keeps earlier tasks across a plan to build restart", async () => {
    const first = await startTurn("s1", { intent: "plan" });
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const events: HarnessEvent[] = [...first.events];
    const { turn: second } = await restartedTurn(events, { intent: "build" });
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
    ]);
  });

  it("keeps earlier tasks after the Claude child exits", async () => {
    const first = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    onExit!(1);

    const events: HarnessEvent[] = [...first.events];
    const { turn: second } = await restartedTurn(events);
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
    ]);
  });

  it("rehydrates tasks from the persisted panel after an app restart", async () => {
    const first = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emitTaskTool(
      "toolu_c2",
      "TaskCreate",
      { subject: "Ship it" },
      "Task #2 created successfully: Ship it",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    const restored = first.events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );

    // App restart: all module state is gone; only the saved transcript remains.
    await stopClaudeSession("s1");
    __claudeTestReset();
    bindClaudeSession("s1", "sess_1", "/repo");
    restoreClaudeTaskLists(
      "s1",
      restored.blocks.flatMap((block) =>
        block.taskList ? [block.taskList] : [],
      ),
    );

    const events: HarnessEvent[] = [...first.events];
    const { turn: second } = await restartedTurn(events);
    expect(spawned.at(-1)).toEqual(
      expect.arrayContaining(["--resume", "sess_1"]),
    );
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emitTaskTool(
      "toolu_c3",
      "TaskCreate",
      { subject: "Tag release" },
      "Task #3 created successfully: Tag release",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
      { id: "2", text: "Ship it", status: "pending" },
      { id: "3", text: "Tag release", status: "pending" },
    ]);
  });

  /** Conversation A: tasks #1 and #2 in sess_1, reduced like the saved transcript. */
  async function conversationWithTasks() {
    const first = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emitTaskTool(
      "toolu_c2",
      "TaskCreate",
      { subject: "Ship it" },
      "Task #2 created successfully: Ship it",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    return first.events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
  }

  /** Conversation B updates A's #1, then creates its own #1. */
  function emitConversationB() {
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
      "sess_2",
    );
    emitTaskTool(
      "toolu_c3",
      "TaskCreate",
      { subject: "Fresh task" },
      "Task #1 created successfully: Fresh task",
      "sess_2",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_2" });
  }

  it("rehydrates the bound conversation's panel past a later conversation's panel", async () => {
    const restored = await conversationWithTasks();
    const lists = [
      ...restored.blocks.flatMap((block) =>
        block.taskList ? [block.taskList] : [],
      ),
      {
        key: "claude-tasks",
        providerSessionId: "sess_2",
        items: [{ id: "1", text: "Other conversation", status: "pending" as const }],
      },
    ];

    await stopClaudeSession("s1");
    __claudeTestReset();
    bindClaudeSession("s1", "sess_1", "/repo");
    restoreClaudeTaskLists("s1", lists);

    const events: HarnessEvent[] = [];
    const { turn } = await restartedTurn(events);
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "2", status: "completed" },
      "Updated task #2 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write tests", status: "pending" },
      { id: "2", text: "Ship it", status: "completed" },
    ]);
  });

  it("does not carry tasks to another conversation bound to the same thread", async () => {
    const restored = await conversationWithTasks();
    expect(
      restored.blocks.find((block) => block.role === "tasks")?.taskList
        ?.providerSessionId,
    ).toBe("sess_1");

    await stopClaudeSession("s1");
    bindClaudeSession("s1", "sess_2", "/repo");
    restoreClaudeTaskLists(
      "s1",
      restored.blocks.flatMap((block) =>
        block.taskList ? [block.taskList] : [],
      ),
    );

    const events: HarnessEvent[] = [];
    const { turn } = await restartedTurn(events, { providerSessionId: "sess_2" });
    expect(spawned.at(-1)).toEqual(
      expect.arrayContaining(["--resume", "sess_2"]),
    );
    emitConversationB();
    await turn;

    const updates = events.filter((event) => event.type === "tasks.updated");
    expect(updates).toEqual([
      expect.objectContaining({
        providerSessionId: "sess_2",
        items: [{ id: "1", text: "Fresh task", status: "pending" }],
      }),
    ]);
  });

  it("starts a clean task map when Claude reports a different conversation", async () => {
    await conversationWithTasks();

    const events: HarnessEvent[] = [];
    const turn = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "keep going",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(
      () => parse().filter((message) => message.type === "user").length > 1,
      "follow-up prompt",
    );
    emitConversationB();
    await turn;

    expect(
      events.filter((event) => event.type === "tasks.updated").at(-1),
    ).toEqual(
      expect.objectContaining({
        providerSessionId: "sess_2",
        items: [{ id: "1", text: "Fresh task", status: "pending" }],
      }),
    );
  });

  it("drops the task map when the conversation cannot resume", async () => {
    const first = await startTurn("s1", { providerAccountId: "work" });
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const events: HarnessEvent[] = [];
    const { turn: second } = await restartedTurn(events, { providerAccountId: "home" });
    expect(spawned.at(-1)).not.toContain("--resume");
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    expect(events.some((event) => event.type === "tasks.updated")).toBe(false);
  });
});

describe("claude assistant message boundaries", () => {
  it("keeps a follow-up paragraph separate and does not replay its snapshot", async () => {
    const { events, turn } = await startTurn("s1");
    const progress = "- update the notes and commit";
    const update =
      "Connect returned an empty file for one image on one post. The catch-up skips it and carries on, and I'll include it in the final tally.";
    for (const text of [progress, update]) {
      emit({
        type: "stream_event",
        session_id: "sess_1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
      });
      emit({
        type: "assistant",
        session_id: "sess_1",
        message: { content: [{ type: "text", text }] },
      });
    }
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(session.blocks.map((block) => block.text)).toEqual([
      progress,
      update,
    ]);
    expect(events.filter((event) => event.type === "message.delta")).toEqual([
      { type: "message.delta", text: progress },
      { type: "message.delta", text: update },
    ]);
  });
});

describe("claude model switching", () => {
  it("restarts a named account with the new model while resuming the provider conversation", async () => {
    const first = await startTurn("s1", {
      providerAccountId: "account-work",
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const userCount = parse().filter(
      (message) => message.type === "user",
    ).length;
    const second = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:opus-5",
      modelSettings: {},
      runtimeMode: "supervised",
      providerAccountId: "account-work",
      text: "what did I ask before?",
      attachments: [],
      onEvent: () => undefined,
    });

    await waitFor(() => spawned.length === 2, "replacement Claude process");
    expect(spawned[1]).toEqual(
      expect.arrayContaining([
        "--model",
        "claude-opus-5",
        "--resume",
        "sess_1",
      ]),
    );
    expect(spawned[1]).not.toContain("--session-id");

    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length > userCount,
      "follow-up prompt",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;
  });
});

describe("claude extra folders", () => {
  it("restarts with --add-dir when a folder is added between turns, resuming the conversation", async () => {
    const first = await startTurn("s1");
    expect(spawned[0]).not.toContain("--add-dir");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const userCount = parse().filter(
      (message) => message.type === "user",
    ).length;
    const send = () =>
      sendClaudeTurn({
        sessionId: "s1",
        cwd: "/repo",
        model: "claude:claude-sonnet-5",
        modelSettings: {},
        runtimeMode: "supervised",
        extraDirs: ["/work/docs"],
        text: "now update the docs",
        attachments: [],
        onEvent: () => undefined,
      });
    const second = send();

    await waitFor(() => spawned.length === 2, "replacement Claude process");
    expect(spawned[1]).toEqual(
      expect.arrayContaining(["--add-dir", "/work/docs", "--resume", "sess_1"]),
    );
    expect(spawned[1]).not.toContain("--session-id");

    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length > userCount,
      "follow-up prompt",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    // The same folders keep the process: no restart on every later turn.
    const third = send();
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length >
        userCount + 1,
      "third prompt",
    );
    expect(spawned).toHaveLength(2);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await third;
  });
});

describe("claude connector switches", () => {
  it("restarts with a deny rule when a connector is switched off between turns, resuming the conversation", async () => {
    const first = await startTurn("s1");
    expect(spawned[0]).not.toContain("--disallowedTools");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const userCount = parse().filter(
      (message) => message.type === "user",
    ).length;
    const send = (disabledMcpServers: string[]) =>
      sendClaudeTurn({
        sessionId: "s1",
        cwd: "/repo",
        model: "claude:claude-sonnet-5",
        modelSettings: {},
        runtimeMode: "supervised",
        disabledMcpServers,
        text: "carry on",
        attachments: [],
        onEvent: () => undefined,
      });
    const second = send(["github"]);

    await waitFor(() => spawned.length === 2, "replacement Claude process");
    const flag = spawned[1].indexOf("--disallowedTools");
    expect(spawned[1].slice(flag, flag + 2)).toEqual([
      "--disallowedTools",
      "mcp__github",
    ]);
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    expect(spawned[1]).not.toContain("--session-id");

    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length > userCount,
      "follow-up prompt",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    // Switching it back on restarts once more, without the rule.
    const third = send([]);
    await waitFor(() => spawned.length === 3, "second replacement");
    expect(spawned[2]).not.toContain("--disallowedTools");
    expect(spawned[2]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length >
        userCount + 1,
      "third prompt",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await third;
  });
});

describe("claude extra folders that no longer exist", () => {
  it("leaves a missing folder off the command line", async () => {
    existingDirs.mockImplementationOnce(async (dirs) =>
      (dirs ?? []).filter((dir) => dir !== "/work/gone"),
    );
    const turn = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      extraDirs: ["/work/docs", "/work/gone"],
      text: "update the docs",
      attachments: [],
      onEvent: () => undefined,
    });
    await waitFor(() => spawned.length === 1, "Claude process");
    const dirs = spawned[0].flatMap((arg, index) =>
      arg === "--add-dir" ? [spawned[0][index + 1]] : [],
    );
    expect(dirs).toEqual(["/work/docs"]);

    await waitFor(
      () =>
        parse().some((m) => {
          const request = m.request as Record<string, unknown> | undefined;
          return request?.subtype === "initialize";
        }),
      "initialize",
    );
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: "monocode_1" },
    });
    await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });
});

describe("claude legacy account resume", () => {
  it("resumes a legacy thread when the missing account resolves to default", async () => {
    bindClaudeSession("s1", "legacy-session", "/repo");
    const { turn } = await startTurn("s1", {
      providerAccountId: "default",
    });
    expect(spawned[0]).toEqual(
      expect.arrayContaining(["--resume", "legacy-session"]),
    );
    expect(spawned[0]).not.toContain("--session-id");
    emit({ type: "result", subtype: "success", session_id: "legacy-session" });
    await turn;
  });

  it("does not resume a legacy default thread under a named account", async () => {
    bindClaudeSession("s1", "legacy-session", "/repo");
    const { turn } = await startTurn("s1", {
      providerAccountId: "account-work",
    });
    expect(spawned[0]).not.toContain("--resume");
    expect(spawned[0]).toContain("--session-id");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });
});

describe("claude subagents", () => {
  it.each(["allow", "deny"] as const)(
    "routes a child permission decision: %s",
    async (decision) => {
      const { events, turn } = await startTurn("s1");
      emit({
        type: "control_request",
        request_id: "child_permission",
        session_id: "sess_child",
        parent_tool_use_id: "toolu_agent",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          tool_use_id: "child_read",
          input: { file_path: "/home/user/.gitconfig" },
        },
      });
      const approval = events.find(
        (event) => event.type === "approval.requested",
      )!;
      expect(approval).toMatchObject({ callId: "child_read" });
      respondClaudeApproval("s1", approval.requestId, decision);
      await waitFor(
        () =>
          parse().some(
            (message) =>
              (message.response as Record<string, unknown>)?.request_id ===
              "child_permission",
          ),
        "child decision",
      );
      expect(
        parse().find(
          (message) =>
            (message.response as Record<string, unknown>)?.request_id ===
            "child_permission",
        ),
      ).toMatchObject({
        type: "control_response",
        response: { response: { behavior: decision } },
      });
      expect(
        events.filter((event) => event.type === "session.providerBound").at(-1),
      ).toMatchObject({ providerSessionId: "sess_1" });
      emit({ type: "result", subtype: "success", session_id: "sess_1" });
      await turn;
    },
  );

  it("keeps simultaneous child questions reachable in the single-question UI", async () => {
    const { events, turn } = await startTurn("s1");
    for (const id of ["child_a", "child_b"]) {
      emit({
        type: "control_request",
        request_id: id,
        parent_tool_use_id: `agent_${id}`,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: `Question from ${id}`,
                options: [{ label: "Proceed" }],
              },
            ],
          },
        },
      });
    }
    expect(
      events.filter((event) => event.type === "question.asked"),
    ).toHaveLength(1);
    for (const id of ["child_a", "child_b"]) {
      const session = events.reduce(
        applyHarnessEvent,
        newSession("claude", "/repo"),
      );
      const request = session.pendingQuestion!;
      expect(request.questions[0].prompt).toBe(`Question from ${id}`);
      respondClaudeQuestion(
        "s1",
        request.requestId,
        id === "child_a"
          ? {
              kind: "answered",
              answers: {
                [request.questions[0].id]: [request.questions[0].options[0].id],
              },
            }
          : { kind: "skipped" },
      );
      await waitFor(
        () =>
          parse().some(
            (message) =>
              (message.response as Record<string, unknown>)?.request_id === id,
          ),
        "question response",
      );
      expect(
        parse().find(
          (message) =>
            (message.response as Record<string, unknown>)?.request_id === id,
        ),
      ).toMatchObject({
        response: {
          response: { behavior: id === "child_a" ? "allow" : "deny" },
        },
      });
    }
    expect(
      events.reduce(applyHarnessEvent, newSession("claude", "/repo"))
        .pendingQuestion,
    ).toBeUndefined();
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  it.each(["child_a", "child_b"])(
    "preserves the remaining question when %s is cancelled by the server",
    async (cancelled) => {
      const { events, turn } = await startTurn("s1");
      for (const id of ["child_a", "child_b"]) {
        emit({
          type: "control_request",
          request_id: id,
          parent_tool_use_id: `agent_${id}`,
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            input: {
              questions: [{ question: id, options: [{ label: "Proceed" }] }],
            },
          },
        });
      }
      emit({ type: "control_cancel_request", request_id: cancelled });
      await waitFor(
        () => events.some((event) => event.type === "question.resolved"),
        "cancelled question",
      );
      const session = events.reduce(
        applyHarnessEvent,
        newSession("claude", "/repo"),
      );
      const remaining = cancelled === "child_a" ? "child_b" : "child_a";
      expect(session.pendingQuestion?.questions[0].prompt).toBe(remaining);
      respondClaudeQuestion("s1", session.pendingQuestion!.requestId, {
        kind: "skipped",
      });
      await waitFor(
        () =>
          parse().some(
            (message) =>
              (message.response as Record<string, unknown>)?.request_id ===
              remaining,
          ),
        "remaining question response",
      );
      expect(
        parse().some(
          (message) =>
            (message.response as Record<string, unknown>)?.request_id ===
            cancelled,
        ),
      ).toBe(false);
      emit({ type: "result", subtype: "success", session_id: "sess_1" });
      await turn;
    },
  );

  it("fails the active turn if a child permission reply cannot be delivered", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "control_request",
      request_id: "child_permission",
      parent_tool_use_id: "toolu_agent",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/home/user/.gitconfig" },
      },
    });
    const approval = events.find(
      (event) => event.type === "approval.requested",
    )!;
    let outcome: unknown;
    void turn.catch((error) => {
      outcome = error;
    });
    writeChild.mockRejectedValueOnce(new Error("Broken pipe"));
    respondClaudeApproval("s1", approval.requestId, "allow");
    await waitFor(() => outcome instanceof Error, "failed permission delivery");
    expect(outcome).toMatchObject({ message: "Broken pipe" });
    expect(events).toContainEqual({
      type: "session.error",
      message: "Broken pipe",
    });
  });

  it.each([
    {
      scenario: "different descriptions",
      descriptions: ["Explore the auth module", "Review the tests"],
    },
    {
      scenario: "identical descriptions",
      descriptions: ["Explore the auth module", "Explore the auth module"],
    },
  ])(
    "shows one row per background subagent when the task list comes first ($scenario)",
    async ({ descriptions }) => {
      const { events, turn } = await startTurn("s1");
      const agents = [
        { id: "toolu_a", task: "t1", description: descriptions[0] },
        { id: "toolu_b", task: "t2", description: descriptions[1] },
      ];

      emit({
        type: "assistant",
        session_id: "sess_1",
        message: {
          content: agents.map((agent) => ({
            type: "tool_use",
            id: agent.id,
            name: "Agent",
            input: {
              description: agent.description,
              subagent_type: "explore",
              run_in_background: true,
            },
          })),
        },
      });
      // Claude lists the tasks, with no tool_use_id, before it announces them.
      emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: agents.map((agent) => ({
          task_id: agent.task,
          task_type: "local_agent",
          description: agent.description,
        })),
      });
      // Each listed task must claim a different call, even before task_started
      // supplies the authoritative IDs for agents with identical descriptions.
      expect(
        new Set(
          events.flatMap((event) =>
            event.type === "tool.updated" ? [event.callId] : [],
          ),
        ),
      ).toEqual(new Set(["toolu_a", "toolu_b"]));
      for (const agent of agents) {
        emit({
          type: "system",
          subtype: "task_started",
          task_id: agent.task,
          tool_use_id: agent.id,
          description: agent.description,
          task_type: "local_agent",
          is_backgrounded: true,
        });
      }

      await waitFor(
        () =>
          events.filter(
            (event) =>
              event.type === "tool.updated" && event.callId === "toolu_b",
          ).length > 0,
        "second task started",
      );
      const rows = events.flatMap((event) =>
        event.type === "tool.started" && event.kind === "agent"
          ? [event.callId]
          : [],
      );
      expect(rows).toEqual(["toolu_a", "toolu_b"]);

      emit({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        tool_use_id: "toolu_a",
        status: "completed",
        summary: "First agent finished",
      });
      const session = events.reduce(
        applyHarnessEvent,
        newSession("claude", "/repo"),
      );
      expect(
        session.blocks.find((block) => block.tool?.callId === "toolu_a")?.tool,
      ).toMatchObject({ status: "completed", detail: "First agent finished" });
      expect(
        session.blocks.find((block) => block.tool?.callId === "toolu_b")?.tool,
      ).toMatchObject({ status: "in_progress" });
      emit({
        type: "system",
        subtype: "task_notification",
        task_id: "t2",
        tool_use_id: "toolu_b",
        status: "completed",
        summary: "Second agent finished",
      });
      emit({ type: "result", subtype: "success", session_id: "sess_1" });
      await turn;
    },
  );

  it("keeps an unmatched background subagent visible until it finishes", async () => {
    const { events, turn } = await startTurn("s1");
    const description = "Explore the auth module";
    const task = {
      task_id: "t1",
      task_type: "local_agent",
      description,
    };
    // A task can be listed without an Agent call in the parent transcript.
    for (let i = 0; i < 2; i++) {
      emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [task],
      });
    }
    emit({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      description,
      summary: "Reading the auth module",
    });
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(
      session.blocks.filter((block) => block.tool?.kind === "agent"),
    ).toHaveLength(1);
    expect(
      session.blocks.find(
        (block) => block.tool?.callId === `agent:${description}`,
      )?.tool,
    ).toMatchObject({
      status: "in_progress",
      detail: "Reading the auth module",
    });

    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "Found the auth entry points",
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const finished = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(
      finished.blocks.filter((block) => block.tool?.kind === "agent"),
    ).toHaveLength(1);
    expect(
      finished.blocks.find(
        (block) => block.tool?.callId === `agent:${description}`,
      )?.tool,
    ).toMatchObject({
      status: "completed",
      detail: "Found the auth entry points",
    });
  });

  it("stays busy after a parent result while a background subagent is running", async () => {
    const { events, turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: {
              description: "Explore the auth module",
              subagent_type: "explore",
            },
          },
        ],
      },
    });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore the auth module",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    emit({
      type: "user",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_agent",
            content: "Backgrounded",
          },
        ],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "tool.started" &&
          event.kind === "agent" &&
          event.title === "Explore the auth module",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );

    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      status: "completed",
      summary: "Found the tokens",
    });
    // The notification wakes Claude for a follow-up turn; that turn's result
    // is what ends the MonoCode turn.
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    emitFollowUpTurn("The explorer found the tokens.");
    await turn;
    expect(settled).toBe(true);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      true,
    );
  });

  it("does not end the turn on a subagent result", async () => {
    const { events, turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore", subagent_type: "explore" },
          },
        ],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_sub",
      parent_tool_use_id: "toolu_agent",
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );

    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(settled).toBe(true);
  });

  it("does not dump subagent assistant text into the parent transcript", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore", subagent_type: "explore" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "I will grep for tokens" }] },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(
      events.some(
        (event) =>
          event.type === "message.delta" &&
          event.text.includes("I will grep for tokens"),
      ),
    ).toBe(false);
  });

  it("mirrors a subagent's tools, thinking and prose onto its own row", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: {
              description: "Correctness review",
              subagent_type: "explore",
            },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: {
        id: "msg_sub_1",
        model: "claude-haiku-4-5",
        content: [
          { type: "thinking", thinking: "Start with the reducer." },
          { type: "text", text: "I will grep for tokens" },
          {
            type: "tool_use",
            id: "toolu_sub_read",
            name: "Read",
            input: { file_path: "/repo/src/App.tsx" },
          },
        ],
      },
    });
    emit({
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sub_read",
            content: "export function App() {}",
          },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(
      events
        .reduce(applyHarnessEvent, newSession("claude", "/repo"))
        .blocks.find((block) => block.tool?.callId === "toolu_agent")?.agentRun
        ?.model,
    ).toBe("claude-haiku-4-5");
    const steps = events.filter((event) => event.type === "agent.step");
    expect(steps.every((step) => step.callId === "toolu_agent")).toBe(true);
    expect(
      steps.map((step) => [step.stepId, step.kind, step.text, step.status]),
    ).toEqual([
      ["msg_sub_1:thinking", "reasoning", "Start with the reducer.", undefined],
      ["msg_sub_1:text", "message", "I will grep for tokens", undefined],
      ["toolu_sub_read", "tool", "Read /repo/src/App.tsx", "in_progress"],
      ["toolu_sub_read", "tool", "", "completed"],
    ]);
  });

  it("keeps a failed subagent tool result on its tool row", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Run tests" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_sub_bash",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    });
    emit({
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sub_bash",
            is_error: true,
            content: [{ type: "text", text: "Tests failed: assertion error" }],
          },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(
      session.blocks.find((block) => block.tool?.callId === "toolu_agent")
        ?.agentRun?.steps,
    ).toMatchObject([
      {
        id: "toolu_sub_bash",
        kind: "tool",
        text: "npm test",
        toolKind: "execute",
        status: "failed",
        detail: "Tests failed: assertion error",
      },
    ]);
  });

  it("does not mirror a subagent result onto the parent tool row", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Correctness review" },
          },
        ],
      },
    });
    emit({
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sub_read",
            content: "export function App() {}",
          },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    // The parent stays in flight: only the subagent's own row settles.
    expect(
      events.some(
        (event) =>
          event.type === "tool.updated" &&
          event.callId === "toolu_agent" &&
          event.status === "completed",
      ),
    ).toBe(false);
  });

  it("ends the turn once a subagent has reported back inline", async () => {
    const { turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emitInlineSubagent();
    emit({ type: "result", subtype: "success", session_id: "sess_1" });

    await turn;
    expect(settled).toBe(true);
  });

  it("routes an unexpected provider exit to the turn that is actually running", async () => {
    const first = await startTurn("s1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const secondEvents: HarnessEvent[] = [];
    const userMessages = parse().filter(
      (message) => message.type === "user",
    ).length;
    const second = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      runtimeMode: "supervised",
      text: "try again",
      attachments: [],
      onEvent: (event) => secondEvents.push(event),
    });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length >
        userMessages,
      "second user prompt",
    );

    onExit?.(1);
    await expect(second).rejects.toThrow("Claude Code exited");
    expect(first.events.some((event) => event.type === "session.ended")).toBe(
      false,
    );
    expect(secondEvents).toContainEqual({ type: "session.ended", code: 1 });
    expect(secondEvents).toContainEqual({
      type: "session.error",
      message: "Claude Code exited",
    });
  });
});

describe("claude background tasks", () => {
  it("keeps the turn working through a background command and Claude's follow-up", async () => {
    const { events, turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emitBackgroundBash();
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );
    expect(backgroundUpdates(events)).toEqual([
      ["Wait 30 seconds then print done"],
    ]);

    emitBashFinished();
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    emitFollowUpTurn("It finished and printed done.");
    await turn;
    expect(backgroundUpdates(events)).toEqual([
      ["Wait 30 seconds then print done"],
      [],
    ]);
    // The command waited on sits under the message Claude left off with as
    // a row of its own, and the reply is a new message after it, once.
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const turn1 = session.blocks.slice(1);
    const background = turn1.find((block) => block.tool?.background);
    expect(background?.tool).toMatchObject({
      callId: "background:b1",
      status: "completed",
      detail:
        'Background command "sleep 30 && echo done" completed (exit code 0)',
    });
    expect(background?.text).toContain("sleep 30");
    expect(
      turn1
        .filter((block) => block.role === "assistant" || block.tool?.background)
        .map((block) => (block.tool?.background ? "[background]" : block.text)),
    ).toEqual(["waiting", "[background]", "It finished and printed done."]);
    const items = groupTurnItems(turn1, { settled: true });
    const fold = foldableWork(items);
    const answer = items.at(-1);
    expect(answer?.type === "block" && answer.block.text).toBe(
      "It finished and printed done.",
    );
    // What Claude yielded with is its answer; the follow-up does not fold it.
    expect(
      (fold ? foldedBlocks(items, fold) : []).map((block) => block.text),
    ).not.toContain("waiting");
  });

  it("shows the waited-on command as a live row under Claude's last message", async () => {
    const { events } = await startTurn("s1");
    emitBackgroundBash();
    await new Promise((r) => setTimeout(r, 10));

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const last = session.blocks.at(-1);
    expect(session.blocks.at(-2)?.text).toBe("waiting");
    expect(last?.tool).toMatchObject({
      background: true,
      status: "in_progress",
      kind: "execute",
    });
    const items = groupTurnItems(session.blocks.slice(1));
    const group = items.at(-1);
    expect(group?.type === "activity" && workSummaryLine(group.blocks, true)).toBe(
      "Running in background",
    );
  });

  it("lets the turn go if a finished task never wakes Claude", async () => {
    const { turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    emitBackgroundBash();

    vi.useFakeTimers();
    try {
      emitBashFinished();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops background commands when the turn is stopped", async () => {
    const { events, turn } = await startTurn("s1");
    emitBackgroundBash("b7");

    await cancelClaudeTurn("s1");
    await turn;
    const requests = parse().flatMap((m) => {
      const request = m.request as Record<string, unknown> | undefined;
      return request ? [request] : [];
    });
    expect(requests).toContainEqual({ subtype: "stop_task", task_id: "b7" });
    expect(requests.at(-1)).toEqual({ subtype: "interrupt" });
    expect(events.some((event) => event.type === "message.completed")).toBe(
      true,
    );
  });
});

describe("claude plan permissions", () => {
  it("answers residual plan-mode permissions without prompting the user", async () => {
    const { events, turn } = await startTurn("s1", {
      runtimeMode: "auto",
      intent: "plan",
    });

    emit({
      type: "control_request",
      request_id: "read_1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/repo/src/App.tsx" },
      },
    });
    emit({
      type: "control_request",
      request_id: "write_1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "/repo/src/new.ts" },
      },
    });

    await waitFor(
      () =>
        parse().filter((message) => message.type === "control_response")
          .length >= 2,
      "plan permission responses",
    );
    const responses = parse().filter(
      (message) => message.type === "control_response",
    );
    const read = responses.find(
      (message) =>
        (message.response as Record<string, unknown>)?.request_id === "read_1",
    );
    const write = responses.find(
      (message) =>
        (message.response as Record<string, unknown>)?.request_id === "write_1",
    );
    expect(
      (
        (read?.response as Record<string, unknown>)?.response as Record<
          string,
          unknown
        >
      )?.behavior,
    ).toBe("allow");
    expect(
      (
        (write?.response as Record<string, unknown>)?.response as Record<
          string,
          unknown
        >
      )?.behavior,
    ).toBe("deny");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false,
    );

    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  it("leaves the captured plan ready to build after a subagent explored for it", async () => {
    const { events, turn } = await startTurn("s1", { intent: "plan" });
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emitInlineSubagent();
    emit({
      type: "control_request",
      request_id: "exit_1",
      request: {
        subtype: "can_use_tool",
        tool_name: "ExitPlanMode",
        tool_use_id: "toolu_exit",
        input: { plan: "# Plan\n\nRewrite the auth module." },
      },
    });
    await waitFor(
      () =>
        parse().some(
          (message) =>
            (message.response as Record<string, unknown>)?.request_id ===
            "exit_1",
        ),
      "exit plan mode response",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });

    // The turn must end for the session to stop being busy; until it does, the
    // plan's Build control stays disabled however the plan block itself reads.
    await turn;
    expect(settled).toBe(true);

    let session = newSession("claude", "/repo");
    for (const event of events) session = applyHarnessEvent(session, event);
    const plan = session.blocks.find((block) => block.role === "plan");
    expect(plan?.text).toContain("Rewrite the auth module.");
    expect(plan?.streaming).toBeFalsy();
    expect(plan?.plan?.status).toBe("ready");
  });
});

describe("claude manual compaction", () => {
  it("runs the built-in command and requires a compact boundary", async () => {
    const { turn } = await startTurn("s1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    sent.length = 0;

    const events: HarnessEvent[] = [];
    const compact = compactClaudeContext({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      runtimeMode: "supervised",
      onEvent: (event) => events.push(event),
    });
    await waitFor(
      () => parse().some((message) => message.type === "user"),
      "compact command",
    );
    expect(parse().find((message) => message.type === "user")).toMatchObject({
      message: { content: [{ type: "text", text: "/compact" }] },
    });

    emit({
      type: "assistant",
      session_id: "sess_1",
      message: { content: [{ type: "text", text: "not transcript output" }] },
    });
    emit({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess_1",
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await compact;

    expect(events).toContainEqual({
      type: "status",
      text: "Compacted context",
    });
    expect(events.some((event) => event.type === "message.delta")).toBe(false);
  });
});

describe("claude edit and resend", () => {
  const base = {
    sessionId: "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised" as RuntimeMode,
    attachments: [],
  };
  const boundaries = (events: HarnessEvent[]) =>
    events.flatMap((event) =>
      event.type === "turn.started" ? [event.providerTurnId] : [],
    );
  const userCount = () =>
    parse().filter((message) => message.type === "user").length;

  /** A reply on the main chain, as Claude Code stamps it. */
  function reply(uuid: string, text = "done") {
    emit({
      type: "assistant",
      session_id: "sess_1",
      uuid,
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text }] },
    });
  }

  /** Sends another prompt on the process already running. */
  async function nextTurn(text: string) {
    const events: HarnessEvent[] = [];
    const before = userCount();
    const turn = sendClaudeTurn({
      ...base,
      text,
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => userCount() > before, `prompt "${text}"`);
    return { events, turn };
  }

  /** Takes the last prompt back, answering the replacement process's start. */
  async function rewind(providerTurnId: string | undefined) {
    const events: HarnessEvent[] = [];
    const starts = spawned.length;
    const done = rewindClaudeLastTurn({
      ...base,
      ...(providerTurnId ? { providerTurnId } : {}),
      onEvent: (event) => events.push(event),
    });
    done.catch(() => undefined);
    return { events, done, starts };
  }

  it("marks a conversation's first prompt, then each prompt with the entry before it", async () => {
    const first = await startTurn("s1");
    expect(boundaries(first.events)).toEqual([CLAUDE_FIRST_TURN]);
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const second = await nextTurn("and the tests?");
    expect(boundaries(second.events)).toEqual(["uuid-reply-1"]);
    // A tool result is an entry too, and the newest one is the boundary.
    emit({
      type: "user",
      session_id: "sess_1",
      uuid: "uuid-tool-result",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
    });
    reply("uuid-reply-2");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second.turn;

    const third = await nextTurn("ship it");
    expect(boundaries(third.events)).toEqual(["uuid-reply-2"]);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await third.turn;
  });

  it("does not take a subagent's entries or stream events for the main chain", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({
      type: "assistant",
      session_id: "sess_child",
      uuid: "uuid-subagent",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "child" }] },
    });
    emit({
      type: "stream_event",
      session_id: "sess_1",
      uuid: "uuid-stream",
      event: { type: "message_stop" },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const second = await nextTurn("again");
    expect(boundaries(second.events)).toEqual(["uuid-reply-1"]);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second.turn;
  });

  it("gives a prompt no boundary when the conversation was resumed unseen", async () => {
    // After an app restart: the conversation is known, its last entry is not.
    bindClaudeSession("s1", "legacy-session", "/repo");
    const { events, turn } = await startTurn("s1");
    expect(spawned[0]).toEqual(
      expect.arrayContaining(["--resume", "legacy-session"]),
    );
    expect(boundaries(events)).toEqual([]);
    emit({ type: "result", subtype: "success", session_id: "legacy-session" });
    await turn;
  });

  it("gives the second prompt no boundary when the first left no entry", async () => {
    const first = await startTurn("s1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    // Taking this one back as a first turn would drop the prompt before it.
    const second = await nextTurn("again");
    expect(boundaries(second.events)).toEqual([]);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second.turn;
  });

  it("restarts the conversation cut back to before the prompt, then resumes it whole", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    const second = await nextTurn("delete the old tests");
    reply("uuid-reply-2");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second.turn;

    const { done, starts } = await rewind("uuid-reply-1");
    await waitFor(() => spawned.length === starts + 1, "replacement process");
    const args = spawned[starts];
    expect(args).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    expect(args[args.indexOf("--resume-session-at") + 1]).toBe("uuid-reply-1");
    expect(args).not.toContain("--session-id");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await expect(done).resolves.toEqual({ submitted: false });

    // The edited prompt goes to the process the rewind started, and follows
    // the same entry the prompt it replaces did.
    const edited = await nextTurn("delete only the flaky tests");
    expect(spawned).toHaveLength(starts + 1);
    expect(boundaries(edited.events)).toEqual(["uuid-reply-1"]);
    reply("uuid-reply-3");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await edited.turn;

    // A later restart resumes wherever the conversation has got to.
    const before = userCount();
    const later = sendClaudeTurn({
      ...base,
      model: "claude:opus-5",
      text: "and now?",
      onEvent: () => undefined,
    });
    await waitFor(() => spawned.length === starts + 2, "restart for the model");
    expect(spawned[starts + 1]).toEqual(
      expect.arrayContaining(["--resume", "sess_1"]),
    );
    expect(spawned[starts + 1]).not.toContain("--resume-session-at");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(() => userCount() > before, "later prompt");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await later;
  });

  it("keeps the cut when the edited prompt needs a different process", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    const second = await nextTurn("delete the old tests");
    reply("uuid-reply-2");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second.turn;

    const { done, starts } = await rewind("uuid-reply-1");
    await waitFor(() => spawned.length === starts + 1, "replacement process");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await done;

    // The edit is sent with another model, which restarts Claude Code again.
    // A plain resume here would bring the old prompt back.
    const before = userCount();
    const edited = sendClaudeTurn({
      ...base,
      model: "claude:opus-5",
      text: "delete only the flaky tests",
      onEvent: () => undefined,
    });
    await waitFor(() => spawned.length === starts + 2, "restart for the model");
    const args = spawned[starts + 1];
    expect(args).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    expect(args[args.indexOf("--resume-session-at") + 1]).toBe("uuid-reply-1");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(() => userCount() > before, "edited prompt");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await edited;
  });

  it("starts a new conversation when the first prompt is taken back", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const { done, starts } = await rewind(CLAUDE_FIRST_TURN);
    await waitFor(() => spawned.length === starts + 1, "new process");
    expect(spawned[starts]).not.toContain("--resume");
    expect(spawned[starts]).not.toContain("--resume-session-at");
    expect(spawned[starts]).toContain("--session-id");
    emit({ type: "system", subtype: "init", session_id: "sess_2" });
    await done;

    const edited = await nextTurn("explore the tests instead");
    expect(boundaries(edited.events)).toEqual([CLAUDE_FIRST_TURN]);
    emit({ type: "result", subtype: "success", session_id: "sess_2" });
    await edited.turn;
  });

  it("fails, and forgets the cut, when Claude Code cannot find the entry", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const { done, starts } = await rewind("uuid-not-in-the-file");
    await waitFor(() => spawned.length === starts + 1, "replacement process");
    // No message found with that uuid: Claude Code prints so and exits.
    onExit?.(1);
    await expect(done).rejects.toThrow(
      "Claude Code could not go back to before this message",
    );

    // The next prompt resumes the conversation as it stands.
    const before = userCount();
    const next = sendClaudeTurn({
      ...base,
      text: "never mind",
      onEvent: () => undefined,
    });
    await waitFor(() => spawned.length === starts + 2, "plain resume");
    expect(spawned[starts + 1]).toEqual(
      expect.arrayContaining(["--resume", "sess_1"]),
    );
    expect(spawned[starts + 1]).not.toContain("--resume-session-at");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(() => userCount() > before, "next prompt");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await next;
  });

  it("refuses while a turn is running, and without a boundary", async () => {
    const first = await startTurn("s1");
    await expect(
      rewindClaudeLastTurn({
        ...base,
        providerTurnId: "uuid-reply-1",
        onEvent: () => undefined,
      }),
    ).rejects.toThrow("Stop the current turn before editing the last message");
    expect(spawned).toHaveLength(1);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    await expect(
      rewindClaudeLastTurn({ ...base, onEvent: () => undefined }),
    ).rejects.toThrow("This message cannot be edited");
    expect(spawned).toHaveLength(1);
  });

  it("keeps the boundary of a turn that was stopped part way", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const second = await nextTurn("refactor everything");
    reply("uuid-partial");
    await cancelClaudeTurn("s1");
    // What Claude writes while the stop settles is still in its conversation.
    reply("uuid-after-stop");
    await second.turn;

    // A prompt sent now follows that last entry, not the one the app last
    // showed.
    const third = await nextTurn("just the tests then");
    expect(boundaries(third.events)).toEqual(["uuid-after-stop"]);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await third.turn;

    // And the stopped prompt's own boundary is still the entry before it.
    expect(boundaries(second.events)).toEqual(["uuid-reply-1"]);
  });

  it("gives the second of two prompts in a row no boundary", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    // Stopped before Claude wrote anything back.
    const second = await nextTurn("refactor everything");
    expect(boundaries(second.events)).toEqual(["uuid-reply-1"]);
    await cancelClaudeTurn("s1");
    await second.turn;

    // Cutting back to uuid-reply-1 for this one would drop the prompt before
    // it as well, which the transcript keeps.
    const third = await nextTurn("refactor only the tests");
    expect(boundaries(third.events)).toEqual([]);
    reply("uuid-reply-3");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await third.turn;

    const fourth = await nextTurn("thanks");
    expect(boundaries(fourth.events)).toEqual(["uuid-reply-3"]);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await fourth.turn;
  });

  it("gives a compaction no boundary, and forgets the entries before it", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const events: HarnessEvent[] = [];
    const before = userCount();
    const compact = compactClaudeContext({
      ...base,
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => userCount() > before, "compact command");
    emit({ type: "system", subtype: "compact_boundary", session_id: "sess_1" });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await compact;
    // Nothing for the app to stamp onto the prompt before the compaction.
    expect(boundaries(events)).toEqual([]);

    // The summary Claude now starts from has no entry seen yet.
    const next = await nextTurn("carry on");
    expect(boundaries(next.events)).toEqual([]);
    reply("uuid-reply-2");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await next.turn;

    const after = await nextTurn("and then?");
    expect(boundaries(after.events)).toEqual(["uuid-reply-2"]);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await after.turn;
  });

  it("does not resume a new conversation that was never sent a prompt", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const { done, starts } = await rewind(CLAUDE_FIRST_TURN);
    await waitFor(() => spawned.length === starts + 1, "new process");
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: "monocode_1" },
    });
    await done;

    // The edit is sent in plan mode, which restarts Claude Code. There is
    // nothing saved under the new conversation's id to resume.
    const before = userCount();
    const edited = sendClaudeTurn({
      ...base,
      intent: "plan",
      text: "plan the tests instead",
      onEvent: () => undefined,
    });
    await waitFor(() => spawned.length === starts + 2, "restart for plan mode");
    expect(spawned[starts + 1]).not.toContain("--resume");
    expect(spawned[starts + 1]).toContain("--session-id");
    emit({ type: "system", subtype: "init", session_id: "sess_3" });
    await waitFor(() => userCount() > before, "edited prompt");
    emit({ type: "result", subtype: "success", session_id: "sess_3" });
    await edited;
  });

  it("puts the conversation back when a first-turn edit cannot start", async () => {
    const first = await startTurn("s1");
    reply("uuid-reply-1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const { done, starts } = await rewind(CLAUDE_FIRST_TURN);
    await waitFor(() => spawned.length === starts + 1, "new process");
    onExit?.(1);
    await expect(done).rejects.toThrow(
      "Claude Code could not go back to before this message",
    );

    // The app kept the prompt and its reply, so Claude must still have them.
    const next = await (async () => {
      const events: HarnessEvent[] = [];
      const before = userCount();
      const turn = sendClaudeTurn({
        ...base,
        text: "never mind",
        onEvent: (event) => events.push(event),
      });
      await waitFor(() => spawned.length === starts + 2, "plain resume");
      emit({ type: "system", subtype: "init", session_id: "sess_1" });
      await waitFor(() => userCount() > before, "next prompt");
      return { events, turn };
    })();
    expect(spawned[starts + 1]).toEqual(
      expect.arrayContaining(["--resume", "sess_1"]),
    );
    expect(boundaries(next.events)).toEqual(["uuid-reply-1"]);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await next.turn;
  });

  it("cuts back from a boundary saved before the app restarted", async () => {
    bindClaudeSession("s1", "saved-session", "/repo");
    const { done, starts } = await rewind("uuid-saved");
    await waitFor(() => spawned.length === starts + 1, "cut process");
    const args = spawned[starts];
    expect(args).toEqual(expect.arrayContaining(["--resume", "saved-session"]));
    expect(args[args.indexOf("--resume-session-at") + 1]).toBe("uuid-saved");
    emit({ type: "system", subtype: "init", session_id: "saved-session" });
    await expect(done).resolves.toEqual({ submitted: false });
  });

  it("refuses when the conversation cannot be resumed in this folder", async () => {
    bindClaudeSession("s1", "saved-session", "/another/repo");
    const { done, starts } = await rewind("uuid-saved");
    await waitFor(() => spawned.length === starts + 1, "process");
    expect(spawned[starts]).not.toContain("--resume-session-at");
    emit({ type: "system", subtype: "init", session_id: "sess_9" });
    await expect(done).rejects.toThrow("cannot be resumed here");
  });
});
