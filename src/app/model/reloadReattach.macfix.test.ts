import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../integrations/harness/core/types";
import type { Session } from "../../features/sessions/model/session";

/**
 * Mac test 2.8, end to end through the real child bridge, Claude adapter,
 * registry and session layer: a Supervised Claude chat runs `sleep 30`, the
 * page reloads mid-call, Claude finishes meanwhile. After the reload the
 * call's result, the reply and the turn's end must land once, and the
 * activity log must get its tool.call.
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    mocks.handlers.set(name, handler);
    return () => undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const CHAT = "chat-1";
const CONVERSATION = "6533353b-1111-4222-8333-444455556666";
const PID = 4242;

function line(rec: Record<string, unknown>) {
  return JSON.stringify({ session_id: CONVERSATION, ...rec });
}

/** What Claude Code printed while the page reloaded. */
const MISSED = [
  line({
    type: "user",
    uuid: "e-result",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "toolu_sleep", content: "slept" },
      ],
    },
  }),
  line({
    type: "assistant",
    uuid: "e-reply",
    message: { content: [{ type: "text", text: "It printed slept." }] },
  }),
  line({ type: "result", subtype: "success", user_message_uuid: "u-prompt" }),
  line({ type: "system", subtype: "session_state_changed", state: "idle" }),
];

function busyChat(base: Session): Session {
  return {
    ...base,
    id: CHAT,
    harness: "claude",
    cwd: "/repo",
    runtimeMode: "supervised",
    providerSessionId: CONVERSATION,
    busy: true,
    blocks: [
      {
        id: "b-user",
        role: "user",
        text: "run the sleep",
        providerTurnId: "e-before",
      },
      {
        id: "b-tool",
        role: "tool",
        text: "python3 -c ...",
        streaming: true,
        tool: {
          callId: "toolu_sleep",
          title: "python3 -c ...",
          kind: "execute",
          status: "pending",
          command: `python3 -c "import time; time.sleep(30); print('slept')"`,
        },
      },
    ],
  };
}

async function fresh() {
  vi.resetModules();
  mocks.handlers.clear();
  const child = await import("../../integrations/harness/core/child");
  const registry = await import("../../integrations/harness/core/registry");
  const { ensureClaudeRegistered } =
    await import("../../integrations/harness/providers/claude/claudeAdapter");
  ensureClaudeRegistered();
  const lifecycle = await import("./appLifecycle");
  const apply = await import("../../integrations/harness/core/apply");
  const { TelemetryFeed } =
    await import("../../features/harness-telemetry/model/telemetryFeed");
  const session = await import("../../features/sessions/model/session");
  const inFlight = await import("../../features/sessions/model/inFlight");
  const layout = await import("../../features/workspace/model/layout");
  return {
    child,
    registry,
    lifecycle,
    apply,
    TelemetryFeed,
    session,
    inFlight,
    layout,
  };
}

/** The first page: spawned the child, saw nothing of the result, unloads. */
async function firstPageUnloads(): Promise<Session> {
  const page = await fresh();
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "harness_spawn" ? PID : undefined,
  );
  page.child.startHarnessBridge();
  await page.child.acquireHarnessBridge();
  page.child.watchChild(
    CHAT,
    () => undefined,
    () => undefined,
  );
  await page.child.spawnChild(CHAT, "/bin/claude", [], "/repo");
  mocks.handlers.get("harness-stdout")!({
    payload: { sessionId: CHAT, lines: ["{}", "{}"], seq: 1 },
  });
  const chat = busyChat(page.session.newSession("claude", "/repo"));
  await page.lifecycle.persistQuitState(
    [chat],
    [page.layout.newTab(CHAT)],
    "",
    "/repo",
    new Map(),
    "unload",
  );
  // What the next page loads from disk: the turn the unload saved
  // interrupted, as `persistQuitState` wrote it.
  return page.inFlight.markTurnInterrupted(chat);
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  mocks.invoke.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function harnessAfterReload(
  replay: { entries: { seq: number; line: string }[] } | null,
) {
  mocks.invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "harness_live_sessions")
        return replay
          ? [
              {
                sessionId: CHAT,
                pid: PID,
                lastSeq: 2 + MISSED.length,
                exited: false,
              },
            ]
          : [];
      if (command === "harness_replay") {
        expect(args).toEqual({ sessionId: CHAT, afterSeq: 2 });
        return {
          ...replay,
          exit: null,
          firstSeq: 1,
          lastSeq: 2 + MISSED.length,
          truncated: false,
        };
      }
      if (command === "git_repo_names_commands") return false;
      return undefined;
    },
  );
}

async function reload(saved: Session) {
  const page = await fresh();
  let state = saved;
  const events: HarnessEvent[] = [];
  const written: { kind: string; detail?: Record<string, unknown> }[] = [];
  const feed = new page.TelemetryFeed((event) => written.push(event), {
    joinWindowMs: 0,
    maxHoldMs: 0,
    earlyMs: 0,
  });
  const ends: HarnessEvent[] = [];
  page.registry.observeHarnessTurns((sessionId, event) => {
    ends.push(event);
    feed.adapter(sessionId, "claude", event, 1);
  });
  page.child.startHarnessBridge();
  await page.lifecycle.attachResumedSessions([saved], {
    onEvent: (sessionId, event) => {
      expect(sessionId).toBe(CHAT);
      events.push(event);
      if (event.type !== "turn.completed")
        feed.adapter(sessionId, "claude", event, 1);
    },
    flush: () => {
      state = page.apply.applyHarnessEvents(state, events.splice(0));
    },
    update: (sessionId, change) => {
      expect(sessionId).toBe(CHAT);
      state = change(state);
    },
  });
  feed.tick(10);
  return { state: () => state, written, ends };
}

describe("a turn in flight across a page reload (Mac test 2.8)", () => {
  it("re-attaches: the tool result, the reply and the turn end land once", async () => {
    const saved = await firstPageUnloads();
    harnessAfterReload({
      entries: MISSED.map((text, index) => ({ seq: 3 + index, line: text })),
    });
    const { state, written, ends } = await reload(saved);
    const blocks = state().blocks;
    const tools = blocks.filter((block) => block.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].tool).toMatchObject({
      callId: "toolu_sleep",
      status: "completed",
      detail: "slept",
    });
    expect(
      blocks.filter((block) => block.role === "assistant").map((b) => b.text),
    ).toEqual(["It printed slept."]);
    expect(blocks.some((block) => block.notice === "interrupt")).toBe(false);
    expect(state().busy).toBe(false);
    expect(ends).toEqual([{ type: "turn.completed", status: "completed" }]);
    expect(written.filter((event) => event.kind === "tool.call")).toHaveLength(
      1,
    );
    expect(written.filter((event) => event.kind === "turn.end")).toHaveLength(
      1,
    );
  });

  it("falls back to interrupted and Continue when the child is gone", async () => {
    const saved = await firstPageUnloads();
    harnessAfterReload(null);
    const { state, ends } = await reload(saved);
    const last = state().blocks.at(-1);
    expect(last?.notice).toBe("interrupt");
    expect(state().busy).toBe(false);
    expect(
      state().blocks.find((block) => block.id === "b-tool")?.tool?.status,
    ).toBe("cancelled");
    expect(ends).toEqual([{ type: "turn.completed", status: "interrupted" }]);
    // The process the old page spared is stopped, as a reload did before.
    expect(mocks.invoke).toHaveBeenCalledWith("harness_kill", {
      sessionId: CHAT,
    });
  });
});
