// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_REPORT,
  expectedNote,
  keepCollectorState,
  reportNotes,
  type FlagsReport,
} from "./activityPanel";
import {
  CALL_END_SETTLE_MS,
  BACKSTOP_MS,
  harnessGeneration,
  isCallEnd,
  noteActivityEvent,
  onActivityChange,
  RefreshScheduler,
} from "./activityRefresh";
import { statusLine, NO_STATUS } from "./collectorSettings";

describe("the collector's state in the panel (Mac test 2.9, 3.11, 3.12b)", () => {
  it("never says the collector is not running before it was asked", () => {
    expect(reportNotes(EMPTY_REPORT).join(" ")).not.toContain("not running");
  });

  it("says not running only on no, and why a reply was partial", () => {
    const no: FlagsReport = {
      ...EMPTY_REPORT,
      collectorReachable: "no",
      collectorReason: "not running",
    };
    expect(reportNotes(no).join(" ")).toContain("The collector is not running");
    const slow: FlagsReport = {
      ...EMPTY_REPORT,
      collectorReachable: "yes",
      collectorReason: "timeout",
      truncated: true,
    };
    const notes = reportNotes(slow).join(" ");
    expect(notes).not.toContain("not running");
    expect(notes).toContain("took too long");
    const stopped: FlagsReport = {
      ...EMPTY_REPORT,
      collectorReachable: "yes",
      collectorReason:
        "eslogger: Caller lacks TCC authorization for Full Disk Access",
    };
    expect(reportNotes(stopped).join(" ")).toContain(
      "eslogger stopped: Caller lacks TCC authorization for Full Disk Access",
    );
  });

  it("past the read limit says the newest are shown", () => {
    expect(
      reportNotes({ ...EMPTY_REPORT, truncated: true }).join(" "),
    ).toContain("the newest is shown");
  });

  it("Mark seen keeps the last known collector state", () => {
    const seen = keepCollectorState({
      ...EMPTY_REPORT,
      collectorReachable: "yes",
      collectorReason: "timeout",
      flags: [
        {
          id: "x",
          chatId: "c",
          at: 1,
          reason: "newHost",
          summary: "s",
          eventId: "e",
          context: [],
        },
      ],
    });
    expect(seen.flags).toEqual([]);
    expect(seen.collectorReachable).toBe("yes");
    expect(seen.collectorReason).toBe("timeout");
  });

  it("counts what the check hid", () => {
    expect(expectedNote(EMPTY_REPORT)).toBeNull();
    expect(
      expectedNote({
        ...EMPTY_REPORT,
        suppressed: { harnessRead: 2, shellInit: 1 },
      }),
    ).toBe("3 expected events hidden");
    expect(
      expectedNote({ ...EMPTY_REPORT, suppressed: { harnessRead: 1 } }),
    ).toBe("1 expected event hidden");
  });

  it("the settings page names eslogger's reason (Mac test 3.4)", () => {
    expect(
      statusLine({
        ...NO_STATUS,
        supported: true,
        installed: true,
        reachable: true,
        detail: {
          eslogger: "stopped",
          esloggerError: "Caller lacks TCC authorization for Full Disk Access",
        },
      }),
    ).toBe(
      "Running, but eslogger stopped: Caller lacks TCC authorization for Full Disk Access",
    );
  });
});

describe("the panel's refresh (Mac test 3.8, 3.12b)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("knows a tool call's end", () => {
    expect(
      isCallEnd({ type: "tool.updated", callId: "a", status: "completed" }),
    ).toBe(true);
    expect(
      isCallEnd({ type: "tool.updated", callId: "a", status: "in_progress" }),
    ).toBe(false);
    expect(
      isCallEnd({
        type: "tool.started",
        callId: "a",
        title: "x",
        status: "failed",
      }),
    ).toBe(true);
    expect(isCallEnd({ type: "message.completed" })).toBe(false);
  });

  it("refreshes on a call end, 11 s after the last one, and every 15 s", async () => {
    const loads: number[] = [];
    const scheduler = new RefreshScheduler(async () => {
      loads.push(Date.now());
    });
    scheduler.start();
    const t0 = Date.now();
    scheduler.callEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toEqual([t0]);
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.callEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toHaveLength(2);
    // 11 s after the last call end, not the first.
    await vi.advanceTimersByTimeAsync(CALL_END_SETTLE_MS - 1);
    const before = loads.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(loads.length).toBe(before + 1);
    expect(loads.at(-1)! - t0).toBeGreaterThanOrEqual(
      5_000 + CALL_END_SETTLE_MS,
    );
    // The backstop keeps going.
    const n = loads.length;
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 2);
    expect(loads.length).toBeGreaterThanOrEqual(n + 1);
    scheduler.stop();
    const stopped = loads.length;
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 3);
    expect(loads.length).toBe(stopped);
  });

  it("never starts a read while one is in flight", async () => {
    let release: () => void = () => undefined;
    let started = 0;
    const scheduler = new RefreshScheduler(
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          release = resolve;
        }),
    );
    scheduler.start();
    scheduler.callEnded();
    scheduler.callEnded();
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS);
    expect(started).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.callEnded();
    expect(started).toBe(2);
    scheduler.stop();
  });

  it("passes call ends and restarts on per chat", () => {
    const seen: string[] = [];
    const off = onActivityChange((chat, what) => seen.push(`${chat}:${what}`));
    const g0 = harnessGeneration("c1");
    noteActivityEvent("c1", { type: "session.started" });
    expect(harnessGeneration("c1")).toBe(g0 + 1);
    noteActivityEvent("c1", {
      type: "tool.updated",
      callId: "a",
      status: "completed",
    });
    noteActivityEvent("c2", { type: "message.completed" });
    off();
    noteActivityEvent("c1", {
      type: "tool.updated",
      callId: "a",
      status: "completed",
    });
    expect(seen).toEqual(["c1:restart", "c1:callEnd"]);
  });
});
