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

  it("a failed mark never stops the turn", async () => {
    await expect(turn("broken", "plan")).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});
