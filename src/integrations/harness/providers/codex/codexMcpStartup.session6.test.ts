import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_STARTUP_TIMED_OUT,
  MCP_STARTUP_WAITING,
  mcpStillStarting,
  newMcpStartup,
  noteMcpStartup,
  waitForMcpStartup,
} from "./codexMcpStartup";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild: async () => undefined,
  restoreMonoCodexAgentState: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  acquireHarnessBridge: async () => () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));
const { sendCodexTurn, stopCodexSession, __codexTestReset } =
  await import("./codex");
import type { HarnessEvent } from "../../core/types";

// The notification Codex 0.161.0 sends, seen with a stub server that answers
// `initialize` four seconds late (tests/cli-contract, check mcp-startup).
const report = (name: string, status: string, threadId = "thr_1") => ({
  threadId,
  name,
  status,
  error:
    status === "failed" ? `MCP client for \`${name}\` failed to start` : null,
  failureReason: null,
});

describe("Mac fix 8.3: MCP startup state", () => {
  it("tracks Codex's per-thread reports and ignores other threads", () => {
    const state = newMcpStartup();
    state.threadId = "thr_1";
    expect(
      noteMcpStartup(
        state,
        "mcpServer/startupStatus/updated",
        report("time", "starting"),
      ),
    ).toBe(true);
    noteMcpStartup(
      state,
      "mcpServer/startupStatus/updated",
      report("other", "starting", "thr_child"),
    );
    expect(mcpStillStarting(state)).toEqual(["time"]);
    noteMcpStartup(
      state,
      "mcpServer/startupStatus/updated",
      report("time", "failed"),
    );
    expect(mcpStillStarting(state)).toEqual([]);
    expect(noteMcpStartup(state, "turn/started", {})).toBe(false);
    // Garbage is swallowed, not counted.
    noteMcpStartup(state, "mcpServer/startupStatus/updated", { name: 3 });
    noteMcpStartup(state, "mcpServer/startupStatus/updated", null);
    expect(mcpStillStarting(state)).toEqual([]);
  });

  it("counts reports that arrive before the thread id is known", () => {
    const state = newMcpStartup();
    noteMcpStartup(
      state,
      "mcpServer/startupStatus/updated",
      report("exa", "starting"),
    );
    state.threadId = "thr_1";
    expect(mcpStillStarting(state)).toEqual(["exa"]);
  });

  it("expects gateway connectors not heard from yet, for a grace period", () => {
    const state = newMcpStartup(["notion-remote"]);
    expect(mcpStillStarting(state)).toEqual(["notion-remote"]);
    expect(mcpStillStarting(state, false)).toEqual([]);
  });
});

describe("Mac fix 8.3: waiting for connectors", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns at once when nothing is starting, without a notice", async () => {
    const onWaiting = vi.fn();
    expect(await waitForMcpStartup(newMcpStartup(), { onWaiting })).toBe(
      "ready",
    );
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it("waits until the server reports ready", async () => {
    const state = newMcpStartup();
    noteMcpStartup(
      state,
      "mcpServer/startupStatus/updated",
      report("time", "starting"),
    );
    const onWaiting = vi.fn();
    const done = waitForMcpStartup(state, { onWaiting });
    await vi.advanceTimersByTimeAsync(4_000);
    noteMcpStartup(
      state,
      "mcpServer/startupStatus/updated",
      report("time", "ready"),
    );
    expect(await done).toBe("ready");
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it("gives up at the cap", async () => {
    const state = newMcpStartup();
    noteMcpStartup(
      state,
      "mcpServer/startupStatus/updated",
      report("slow", "starting"),
    );
    const done = waitForMcpStartup(state, { capMs: 20_000 });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await done).toBe("timeout");
  });

  it("stops waiting for a gateway connector Codex never reports", async () => {
    const state = newMcpStartup(["dropped"]);
    const done = waitForMcpStartup(state);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await done).toBe("ready");
  });

  it("stops when the turn is cancelled", async () => {
    const state = newMcpStartup();
    noteMcpStartup(
      state,
      "mcpServer/startupStatus/updated",
      report("slow", "starting"),
    );
    let cancelled = false;
    const done = waitForMcpStartup(state, { stop: () => cancelled });
    await vi.advanceTimersByTimeAsync(1_000);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(await done).toBe("stopped");
  });
});

const parse = () =>
  sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const find = (method: string) => parse().find((m) => m.method === method);
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const notify = (method: string, params: unknown) =>
  onLine!(JSON.stringify({ method, params }));

describe("Mac fix 8.3: the first turn of a local Codex chat waits for its connectors", () => {
  beforeEach(() => {
    sent.length = 0;
    onLine = undefined;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await stopCodexSession("mcp");
    __codexTestReset();
  });

  async function open(events: HarnessEvent[]) {
    const turn = sendCodexTurn({
      sessionId: "mcp",
      cwd: "/Users/me/scratch",
      model: "codex:qwen2.5-coder:7b",
      modelSettings: {},
      runtimeMode: "supervised",
      gatewayConnectors: [
        {
          name: "time",
          command: "/usr/local/bin/docker",
          args: ["mcp", "gateway", "run"],
        },
      ],
      text: "what time is it in Tokyo",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => !!find("initialize"), "initialize");
    onLine!(JSON.stringify({ id: find("initialize")!.id, result: {} }));
    await waitFor(() => !!find("thread/start"), "thread/start");
    onLine!(
      JSON.stringify({
        id: find("thread/start")!.id,
        result: { thread: { id: "thr_1" } },
      }),
    );
    notify("mcpServer/startupStatus/updated", report("time", "starting"));
    return { turn };
  }

  async function finish(turn: Promise<void>) {
    await waitFor(() => !!find("turn/start"), "turn/start");
    onLine!(
      JSON.stringify({
        id: find("turn/start")!.id,
        result: { turn: { id: "turn_1" } },
      }),
    );
    notify("turn/completed", { turn: { id: "turn_1", status: "completed" } });
    await turn;
  }

  it("holds turn/start until the connector is ready, and clears the status line", async () => {
    const events: HarnessEvent[] = [];
    const { turn } = await open(events);
    await new Promise((r) => setTimeout(r, 300));
    expect(find("turn/start")).toBeUndefined();
    expect(events).toContainEqual({
      type: "status",
      key: "codex-mcp-startup",
      text: MCP_STARTUP_WAITING,
    });
    notify("mcpServer/startupStatus/updated", report("time", "ready"));
    await finish(turn);
    expect(events).toContainEqual({
      type: "status",
      key: "codex-mcp-startup",
      text: "",
    });
  });

  it("sends anyway at the cap with a one-line notice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const events: HarnessEvent[] = [];
    const { turn } = await open(events);
    await waitFor(
      () =>
        events.some(
          (e) => e.type === "status" && e.text === MCP_STARTUP_WAITING,
        ),
      "waiting status",
    );
    expect(find("turn/start")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_500);
    await finish(turn);
    expect(events).toContainEqual({
      type: "status",
      key: "codex-mcp-startup",
      text: MCP_STARTUP_TIMED_OUT,
    });
  });
});
