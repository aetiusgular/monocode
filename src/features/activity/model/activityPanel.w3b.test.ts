// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_REPORT,
  eventsAround,
  fetchFlags,
  fetchScreenshot,
  KEEP_MS,
  lastVisit,
  markVisited,
  reportNotes,
  sinceFor,
  type ActivityFlag,
} from "./activityPanel";
import type { ActivityEvent } from "./activityTypes";
import {
  clampFloorGb,
  DEFAULT_FLOOR_GB,
  loadFloorGb,
  NO_STATUS,
  statusLine,
} from "./collectorSettings";

beforeEach(() => localStorage.clear());

function ev(id: string, at: number): ActivityEvent {
  return {
    id,
    at,
    chatId: "c1",
    harness: "",
    source: "eslogger",
    kind: "exec",
    summary: id,
    detail: {},
  };
}

describe("the panel's model (B6)", () => {
  it("starts at your last visit, never more than 7 days back", () => {
    const now = 100 * KEEP_MS;
    expect(sinceFor("c1", now)).toBe(now - KEEP_MS);
    markVisited("c1", now - 1_000);
    expect(lastVisit("c1")).toBe(now - 1_000);
    expect(sinceFor("c1", now)).toBe(now - 1_000);
    markVisited("c2", 1);
    expect(sinceFor("c2", now)).toBe(now - KEEP_MS);
  });

  it("reads junk in storage as no visit (case 14)", () => {
    localStorage.setItem("monocode.activity.lastVisit", "{not json");
    expect(lastVisit("c1")).toBeUndefined();
    localStorage.setItem(
      "monocode.activity.lastVisit",
      JSON.stringify({ c1: "soon", c2: 5 }),
    );
    expect(lastVisit("c1")).toBeUndefined();
    expect(lastVisit("c2")).toBe(5);
    localStorage.setItem("monocode.activity.lastVisit", "[1,2]");
    expect(lastVisit("c2")).toBeUndefined();
  });

  it("keeps at most 500 chats' visits, the newest", () => {
    for (let i = 0; i < 520; i++) markVisited(`c${i}`, i);
    const stored = JSON.parse(
      localStorage.getItem("monocode.activity.lastVisit") ?? "{}",
    );
    expect(Object.keys(stored)).toHaveLength(500);
    expect(lastVisit("c0")).toBeUndefined();
    expect(lastVisit("c519")).toBe(519);
  });

  it("lists the events a flag names, oldest first", () => {
    const flag: ActivityFlag = {
      id: "f",
      chatId: "c1",
      at: 5,
      reason: "writeOutsideFolders",
      summary: "",
      eventId: "b",
      context: ["c", "b"],
    };
    expect(
      eventsAround(flag, [ev("c", 9), ev("a", 1), ev("b", 5)]).map((e) => e.id),
    ).toEqual(["b", "c"]);
  });

  it("says when the log does not verify or the collector is missing", () => {
    expect(reportNotes({ ...EMPTY_REPORT, collectorReachable: "yes" })).toEqual(
      [],
    );
    // Changed for Mac test 2.9: "not running" needs a collector that was
    // asked and did not answer, not the empty report.
    const notes = reportNotes({
      ...EMPTY_REPORT,
      collectorReachable: "no",
      chainOk: false,
      collectorChainOk: false,
      truncated: true,
      dropped: 1,
    });
    expect(notes).toHaveLength(5);
    expect(notes.join(" ")).toContain("1 record was dropped");
  });

  it("outside the app, reads return nothing rather than failing (case 9)", async () => {
    await expect(fetchFlags("c1", 0)).resolves.toEqual(EMPTY_REPORT);
    await expect(fetchScreenshot("/x.png")).resolves.toBeNull();
  });
});

describe("the collector settings (B4, B7)", () => {
  it("clamps the screenshot floor", () => {
    expect(clampFloorGb(0)).toBe(0.25);
    expect(clampFloorGb(10_000)).toBe(512);
    expect(clampFloorGb("abc")).toBe(DEFAULT_FLOOR_GB);
    expect(clampFloorGb(4)).toBe(4);
    localStorage.setItem("monocode.activity.screenshotFloorGb", "nonsense");
    expect(loadFloorGb()).toBe(DEFAULT_FLOOR_GB);
    localStorage.setItem("monocode.activity.screenshotFloorGb", "8");
    expect(loadFloorGb()).toBe(8);
  });

  it("names the collector's state in one line", () => {
    expect(statusLine(NO_STATUS)).toMatch(/only on macOS/);
    const mac = { ...NO_STATUS, supported: true };
    expect(statusLine(mac)).toMatch(/Not installed/);
    expect(
      statusLine({
        ...mac,
        installed: true,
        problem: "The collector is not running.",
      }),
    ).toBe("The collector is not running.");
    expect(
      statusLine({
        ...mac,
        installed: true,
        reachable: true,
        detail: { eslogger: "running" },
      }),
    ).toMatch(/^Running\./);
    expect(
      statusLine({
        ...mac,
        installed: true,
        reachable: true,
        detail: { eslogger: "missing" },
      }),
    ).toMatch(/eslogger is missing/);
  });
});
