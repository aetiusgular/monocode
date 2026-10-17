// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

const tapped = vi.hoisted(() => [] as { sessionId: string; type: string }[]);
vi.mock("../../features/harness-telemetry/model/telemetryTap", () => ({
  tapHarnessEvent: (sessionId: string, event: { type: string }) => tapped.push({ sessionId, type: event.type }),
}));

import { HarnessEventQueue } from "./harnessFlush";

it("the telemetry feed sees each tapped live event once, in order, and nothing else", async () => {
  const applied: string[] = [];
  const queue = new HarnessEventQueue(
    () => false,
    (batches) => {
      for (const [, events] of batches) applied.push(...events.map((e) => e.type));
    },
  );
  queue.enqueue("c1", { type: "message.delta", text: "hi" });
  queue.enqueue("c1", { type: "tool.started", callId: "t", title: "ls", kind: "execute" });
  queue.enqueue("c1", { type: "approval.requested", requestId: 1, title: "ls" });
  queue.enqueue("c2", { type: "turn.started", providerTurnId: "p" });
  queue.enqueue("c1", { type: "tool.updated", callId: "t", status: "completed" });
  await vi.waitFor(() => expect(tapped).toHaveLength(4), { timeout: 10_000 });
  expect(tapped).toEqual([
    { sessionId: "c1", type: "tool.started" },
    { sessionId: "c1", type: "approval.requested" },
    { sessionId: "c2", type: "turn.started" },
    { sessionId: "c1", type: "tool.updated" },
  ]);
  // The queue still delivers every event to the reducer as before.
  queue.flush();
  expect(applied).toContain("message.delta");
  expect(applied.filter((t) => t === "tool.started")).toHaveLength(1);
});
