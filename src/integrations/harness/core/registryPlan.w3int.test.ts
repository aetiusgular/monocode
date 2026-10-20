import { beforeEach, describe, expect, it, vi } from "vitest";

// Wave 3 integration, security review S6: every harness's turn tells
// computer use whether it is a plan turn, and clears it after.
const calls: Array<[string, unknown]> = [];
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    calls.push([cmd, args]);
    if (cmd === "computer_use_set_plan" && (args as { chatId: string }).chatId === "broken")
      throw new Error("no computer use");
    return undefined;
  }),
}));

import { registerHarness, sendHarnessTurn } from "./registry";

let seen: string[] = [];
beforeEach(() => {
  calls.length = 0;
  seen = [];
  registerHarness({
    id: "codex",
    live: true,
    sendTurn: async () => {
      seen.push(
        calls
          .filter(([c]) => c === "computer_use_set_plan")
          .map(([, a]) => JSON.stringify(a))
          .join("|"),
      );
    },
  } as never);
});

function turn(sessionId: string, intent?: "plan") {
  return sendHarnessTurn({
    harness: "codex",
    sessionId,
    cwd: "/tmp/x",
    onEvent: () => {},
    ...(intent ? { intent } : {}),
  } as never);
}

describe("plan turns reach computer use", () => {
  it("a plan turn is marked before it runs and cleared after", async () => {
    await turn("c1", "plan");
    expect(seen[0]).toBe(JSON.stringify({ chatId: "c1", plan: true }));
    const marks = calls.filter(([c]) => c === "computer_use_set_plan").map(([, a]) => a);
    expect(marks).toEqual([
      { chatId: "c1", plan: true },
      { chatId: "c1", plan: false },
    ]);
  });

  it("an ordinary turn is marked not planning", async () => {
    await turn("c2");
    expect(seen[0]).toBe(JSON.stringify({ chatId: "c2", plan: false }));
  });

  it("a plan turn whose mark fails does not run (security review T7)", async () => {
    await expect(turn("broken", "plan")).rejects.toThrow(/plan turn/);
    expect(seen).toHaveLength(0);
    expect(calls.some(([c]) => c === "control_turn_finished")).toBe(true);
  });

  it("an ordinary turn whose mark fails still runs", async () => {
    await expect(turn("broken")).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});

describe("a re-attached turn holds the computer use plan mark (security review X7)", () => {
  async function attach(
    sessionId: string,
    intent: "plan" | "default" | undefined,
  ) {
    const { attachHarnessSession } = await import("./registry");
    const marksAtAttach: string[] = [];
    registerHarness({
      id: "claude",
      live: true,
      attachSession: async () => {
        marksAtAttach.push(
          calls
            .filter(([c]) => c === "computer_use_set_plan")
            .map(([, a]) => JSON.stringify(a))
            .join("|"),
        );
        return { turn: Promise.resolve() };
      },
    } as never);
    const outcome = await attachHarnessSession({
      harness: "claude",
      sessionId,
      cwd: "/tmp/x",
      model: "claude:claude-sonnet-5",
      runtimeMode: "full-access",
      providerSessionId: "conv",
      openTools: [],
      ...(intent ? { intent } : {}),
      onEvent: () => {},
    } as never);
    return { outcome, marksAtAttach };
  }

  it("a re-attached plan turn is marked before it is taken back and cleared after", async () => {
    const { outcome, marksAtAttach } = await attach("a1", "plan");
    expect(outcome.attached).toBe(true);
    expect(marksAtAttach).toEqual([
      JSON.stringify({ chatId: "a1", plan: true }),
    ]);
    expect(
      calls.filter(([c]) => c === "computer_use_set_plan").map(([, a]) => a),
    ).toEqual([
      { chatId: "a1", plan: true },
      { chatId: "a1", plan: false },
    ]);
  });

  it("a re-attached plan turn whose mark fails is not taken back", async () => {
    const { outcome, marksAtAttach } = await attach("broken", "plan");
    expect(outcome).toEqual({ attached: false, status: "interrupted" });
    expect(marksAtAttach).toHaveLength(0);
  });

  it("a re-attach without an intent is not taken back", async () => {
    const { outcome, marksAtAttach } = await attach("a2", undefined);
    expect(outcome).toEqual({ attached: false, status: "interrupted" });
    expect(marksAtAttach).toHaveLength(0);
  });
});
