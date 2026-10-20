import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: () => false,
}));

async function registryWith(
  attachSession: (input: {
    onEvent: (event: HarnessEvent) => void;
  }) => Promise<{ turn: Promise<void> } | null>,
) {
  vi.resetModules();
  const registry = await import("./registry");
  registry.registerHarness({
    id: "claude",
    live: true,
    attachSession,
  } as never);
  const ends: HarnessEvent[] = [];
  const chat: HarnessEvent[] = [];
  registry.observeHarnessTurns((_id, event) => ends.push(event));
  const run = () =>
    registry.attachHarnessSession({
      harness: "claude",
      sessionId: "chat",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      runtimeMode: "supervised",
      providerSessionId: "conv",
      openTools: [],
      onEvent: (event) => chat.push(event),
    });
  return { run, ends, chat };
}

describe("attachHarnessSession announces the turn's end once (Mac 2.8)", () => {
  it("completed when the re-attached turn ends", async () => {
    const { run, ends, chat } = await registryWith(async () => ({
      turn: Promise.resolve(),
    }));
    expect(await run()).toEqual({ attached: true, status: "completed" });
    expect(ends).toEqual([{ type: "turn.completed", status: "completed" }]);
    expect(chat.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("interrupted when the attach throws partway", async () => {
    const { run, ends } = await registryWith(async () => {
      throw new Error("replay read failed");
    });
    expect(await run()).toEqual({ attached: false, status: "interrupted" });
    expect(ends).toEqual([{ type: "turn.completed", status: "interrupted" }]);
  });

  it("interrupted when there is nothing to take back", async () => {
    const { run, ends } = await registryWith(async () => null);
    expect(await run()).toEqual({ attached: false, status: "interrupted" });
    expect(ends).toEqual([{ type: "turn.completed", status: "interrupted" }]);
  });

  it("failed when the child exits before the turn ends", async () => {
    const { run, ends } = await registryWith(async (input) => {
      input.onEvent({ type: "session.ended", code: 1 });
      return { turn: Promise.reject(new Error("Claude Code exited")) };
    });
    expect(await run()).toEqual({ attached: true, status: "failed" });
    expect(ends).toEqual([{ type: "turn.completed", status: "failed" }]);
  });
});
