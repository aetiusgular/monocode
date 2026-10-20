import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelHarnessTurn,
  observeHarnessTurns,
  registerHarness,
  resetHarnessIdlePark,
  sendHarnessTurn,
  type HarnessAdapter,
} from "./registry";
import type { HarnessEvent, SendTurnInput } from "./types";

// Mac test 2.2: a turn's end was written on `turn.ready` ("the provider
// accepted the prompt"), so Claude turns ended milliseconds after they began
// and Codex turns never did. The real end is when the send settles.

function stub(sendTurn: HarnessAdapter["sendTurn"]): HarnessAdapter {
  return {
    id: "codex",
    live: true,
    sendTurn,
    async steerTurn() {},
    async cancelTurn() {},
    respondApproval() {},
    async stopSession() {},
    async forgetSession() {},
    bindSession() {},
  };
}

function send(sessionId: string, onEvent: (e: HarnessEvent) => void) {
  return sendHarnessTurn({
    harness: "codex",
    sessionId,
    cwd: "/tmp",
    model: "codex:gpt-5.4",
    runtimeMode: "supervised",
    text: "Hello",
    onEvent,
  });
}

const completed = (events: HarnessEvent[]) =>
  events.filter((e) => e.type === "turn.completed");

afterEach(() => resetHarnessIdlePark());

describe("turn.completed", () => {
  it("comes once, when the send settles, not when the prompt is accepted", async () => {
    let finish!: () => void;
    let input!: SendTurnInput;
    registerHarness(
      stub(async (i) => {
        input = i;
        await new Promise<void>((resolve) => (finish = resolve));
      }),
    );
    const events: HarnessEvent[] = [];
    const sending = send("t1", (e) => events.push(e));
    await vi.waitFor(() => expect(input).toBeDefined());
    input.onAccepted?.();
    expect(events).toEqual([{ type: "turn.ready" }]);
    finish();
    await sending;
    expect(completed(events)).toEqual([
      { type: "turn.completed", status: "completed" },
    ]);
  });

  it("says failed when the send throws or the turn reported an error", async () => {
    registerHarness(
      stub(async () => {
        throw new Error("boom");
      }),
    );
    const events: HarnessEvent[] = [];
    await expect(send("t2", (e) => events.push(e))).rejects.toThrow("boom");
    expect(completed(events)).toEqual([
      { type: "turn.completed", status: "failed" },
    ]);

    registerHarness(
      stub(async (i) => {
        i.onEvent({ type: "session.error", message: "Codex turn failed." });
      }),
    );
    const more: HarnessEvent[] = [];
    await send("t3", (e) => more.push(e));
    expect(completed(more)).toEqual([
      { type: "turn.completed", status: "failed" },
    ]);
  });

  it("says interrupted after Stop, and reaches the observer even when the chat drops the event", async () => {
    let finish!: () => void;
    registerHarness({
      ...stub(async () => {
        await new Promise<void>((resolve) => (finish = resolve));
      }),
      async cancelTurn() {
        finish();
      },
    });
    const seen: [string, HarnessEvent][] = [];
    const stop = observeHarnessTurns((id, e) => seen.push([id, e]));
    let dropping = false;
    const events: HarnessEvent[] = [];
    const sending = send("t4", (e) => {
      if (!dropping) events.push(e);
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    // The chat bumps its turn generation on Stop and drops what follows.
    dropping = true;
    await cancelHarnessTurn("codex", "t4");
    await sending;
    stop();
    expect(completed(events)).toEqual([]);
    expect(seen).toEqual([
      ["t4", { type: "turn.completed", status: "interrupted" }],
    ]);
  });
});
