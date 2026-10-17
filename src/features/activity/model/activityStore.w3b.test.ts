import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  droppedActivityRecords,
  flushActivity,
  FLUSH_MS,
  MAX_BATCH,
  MAX_QUEUED,
  recordActivity,
  recordApproval,
  resetActivityQueue,
  setActivityTransport,
  type ActivityTransport,
} from "./activityStore";
import type { ActivityEvent, ApprovalRecord } from "./activityTypes";

function event(id: string): ActivityEvent {
  return {
    id,
    at: 1,
    chatId: "c1",
    harness: "codex",
    source: "adapter",
    kind: "tool.call",
    summary: "",
    detail: {},
  };
}

const approval: ApprovalRecord = {
  id: "a1",
  chatId: "c1",
  harness: "codex",
  subject: "command",
  target: "npm test",
  scope: "chat",
  granted: true,
  grantedAt: 1,
};

function fakeTransport() {
  const sent = {
    events: [] as ActivityEvent[][],
    approvals: [] as ApprovalRecord[][],
  };
  const transport: ActivityTransport = {
    record: async (events) => {
      sent.events.push(events);
    },
    recordApprovals: async (records) => {
      sent.approvals.push(records);
    },
  };
  return { sent, transport };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetActivityQueue();
});
afterEach(() => {
  setActivityTransport(null);
  resetActivityQueue();
  vi.useRealTimers();
});

describe("activity store (B1, case 9)", () => {
  it("sends queued records in one batch after a short wait", async () => {
    const { sent, transport } = fakeTransport();
    setActivityTransport(transport);
    recordActivity(event("e1"));
    recordActivity(event("e2"));
    recordApproval(approval);
    expect(sent.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(sent.events).toEqual([[event("e1"), event("e2")]]);
    expect(sent.approvals).toEqual([[approval]]);
  });

  it("splits a large queue into batches the Rust side accepts", async () => {
    const { sent, transport } = fakeTransport();
    setActivityTransport(transport);
    for (let i = 0; i < MAX_BATCH + 10; i++) recordActivity(event(`e${i}`));
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 3);
    expect(sent.events.map((batch) => batch.length)).toEqual([MAX_BATCH, 10]);
  });

  it("drops the oldest and counts when nothing drains the queue", () => {
    for (let i = 0; i < MAX_QUEUED + 3; i++) recordActivity(event(`e${i}`));
    expect(droppedActivityRecords()).toBe(3);
  });

  it("never throws, even when the transport throws or rejects", async () => {
    setActivityTransport({
      record: () => {
        throw new Error("boom");
      },
      recordApprovals: () => Promise.reject(new Error("no app")),
    });
    expect(() => recordActivity(event("e1"))).not.toThrow();
    expect(() => recordApproval(approval)).not.toThrow();
    await expect(flushActivity()).resolves.toBeUndefined();
    setActivityTransport({
      record: () => Promise.reject(new Error("no app")),
      recordApprovals: () => Promise.reject(new Error("no app")),
    });
    recordActivity(event("e2"));
    await expect(flushActivity()).resolves.toBeUndefined();
  });

  it("ignores records that are not records", async () => {
    const { sent, transport } = fakeTransport();
    setActivityTransport(transport);
    recordActivity(null as unknown as ActivityEvent);
    recordActivity({ id: 5 } as unknown as ActivityEvent);
    recordApproval({} as ApprovalRecord);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(sent.events).toHaveLength(0);
    expect(sent.approvals).toHaveLength(0);
  });

  it("outside the app there is no transport and nothing breaks", async () => {
    recordActivity(event("e1"));
    await expect(flushActivity()).resolves.toBeUndefined();
  });
});
