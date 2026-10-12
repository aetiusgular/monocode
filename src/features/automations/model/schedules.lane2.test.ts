import { describe, expect, it } from "vitest";
import {
  automationScheduleLabel,
  createAutomationTrigger,
  defaultOnceAt,
  draftFromAutomation,
  intervalLabel,
  joinLocalMoment,
  newAutomationDraft,
  nextAutomationRunAt,
  nextTriggersRunAt,
  overdueTriggerOccurrences,
  splitLocalMoment,
  type Automation,
} from "./automations";

const at = (value: string) => new Date(value).getTime();
const YEAR = 365 * 24 * 60 * 60 * 1000;

describe("one-time schedule (#39)", () => {
  it("fires at its moment, and has no next run after it", () => {
    const moment = at("2026-10-14T09:00:00");
    const once = createAutomationTrigger("time", "once", { at: moment });
    expect(once.scheduleKind).toBe("once");
    expect(nextAutomationRunAt(once, at("2026-10-13T12:00:00"))).toBe(moment);
    expect(nextAutomationRunAt(once, moment)).toBe(Infinity);
    expect(nextAutomationRunAt(once, moment + 1)).toBe(Infinity);
  });

  it("gets a placeholder a year out once spent, so the store's next-run check holds", () => {
    const moment = at("2026-10-14T09:00:00");
    const once = createAutomationTrigger("time", "once", { at: moment });
    expect(nextTriggersRunAt([once], moment)).toBe(moment + YEAR);
  });

  it("does not hide a recurring trigger beside it", () => {
    const moment = at("2026-10-14T09:00:00");
    const once = createAutomationTrigger("time", "once", { at: moment });
    const daily = createAutomationTrigger("time", "daily", { time: "10:00" });
    expect(nextTriggersRunAt([once, daily], moment)).toBe(
      at("2026-10-14T10:00:00"),
    );
    expect(nextTriggersRunAt([once, daily], at("2026-10-14T08:00:00"))).toBe(
      moment,
    );
  });

  it("is claimed once, never twice, after the app was closed past it", () => {
    const moment = at("2026-10-14T09:00:00");
    const once = createAutomationTrigger("time", "once", { at: moment });
    const due = overdueTriggerOccurrences([once], moment, moment + 3_600_000);
    expect(due).toEqual([{ scheduledFor: moment, nextRunAt: moment + YEAR }]);
  });

  it("defaults to tomorrow at 09:00 and labels itself", () => {
    const now = at("2026-10-12T22:15:00");
    const trigger = createAutomationTrigger("time", "once", {});
    expect(trigger.at).toBeGreaterThan(Date.now());
    expect(defaultOnceAt(now)).toBe(at("2026-10-13T09:00:00"));
    expect(
      automationScheduleLabel({ ...trigger, at: at("2026-10-14T09:00:00") }),
    ).toMatch(/^Once, 14 Oct, 09:00$/);
  });
});

describe("interval schedule (#39)", () => {
  it("runs every N minutes from the minute it was last due", () => {
    const every = createAutomationTrigger("time", "interval", {
      intervalMinutes: 30,
    });
    const from = at("2026-10-12T10:07:42");
    expect(nextAutomationRunAt(every, from)).toBe(at("2026-10-12T10:37:00"));
  });

  it("defaults to an hour and clamps to 5 minutes and 30 days", () => {
    const every = createAutomationTrigger("time", "interval");
    expect(every.intervalMinutes).toBe(60);
    const from = at("2026-10-12T10:00:00");
    expect(nextAutomationRunAt({ ...every, intervalMinutes: 1 }, from)).toBe(
      from + 5 * 60_000,
    );
    expect(
      nextAutomationRunAt({ ...every, intervalMinutes: 10 ** 9 }, from),
    ).toBe(from + 43_200 * 60_000);
  });

  it("catches up a bounded number of runs after a long sleep", () => {
    const every = createAutomationTrigger("time", "interval", {
      intervalMinutes: 5,
    });
    const first = at("2026-10-12T00:00:00");
    const due = overdueTriggerOccurrences([every], first, first + 2 * YEAR);
    expect(due.length).toBe(100);
    expect(due[1]!.scheduledFor - due[0]!.scheduledFor).toBe(5 * 60_000);
  });

  it("labels minutes, hours and days", () => {
    expect(intervalLabel(5)).toBe("5 minutes");
    expect(intervalLabel(60)).toBe("hour");
    expect(intervalLabel(180)).toBe("3 hours");
    expect(intervalLabel(1440)).toBe("day");
    expect(intervalLabel(90)).toBe("90 minutes");
    expect(
      automationScheduleLabel(
        createAutomationTrigger("time", "interval", { intervalMinutes: 120 }),
      ),
    ).toBe("Every 2 hours");
  });
});

describe("local moments for the date field", () => {
  it("round-trips a date and a clock", () => {
    const moment = joinLocalMoment("2026-10-14", "09:30");
    expect(moment).toBe(at("2026-10-14T09:30:00"));
    expect(splitLocalMoment(moment!)).toEqual({
      date: "2026-10-14",
      time: "09:30",
    });
  });

  it("refuses dates that do not exist and malformed input", () => {
    expect(joinLocalMoment("2026-02-31", "09:00")).toBeNull();
    expect(joinLocalMoment("2026-13-01", "09:00")).toBeNull();
    expect(joinLocalMoment("2026-10-14", "24:00")).toBeNull();
    expect(joinLocalMoment("", "09:00")).toBeNull();
    expect(joinLocalMoment("14/10/2026", "9:00")).toBeNull();
  });
});

describe("keep awake", () => {
  it("is off for a new draft and for an automation saved before it existed", () => {
    expect(newAutomationDraft("/p", "codex", "m").keepAwake).toBe(false);
    const old = {
      ...newAutomationDraft("/p", "codex", "m"),
      id: "a",
      nextRunAt: 1,
      createdAt: 1,
      updatedAt: 1,
    } as Automation;
    delete (old as Partial<Automation>).keepAwake;
    expect(draftFromAutomation(old).keepAwake).toBe(false);
    expect(draftFromAutomation({ ...old, keepAwake: true }).keepAwake).toBe(
      true,
    );
  });
});
