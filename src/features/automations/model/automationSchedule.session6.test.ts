// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mac test 2.13: a run claimed at startup sat Pending until View > Reload,
// because a scheduler pass replaced mid-way dropped what it had claimed.

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import {
  PENDING_PICKUP_MS,
  beginAutomationRun,
  createAutomationTrigger,
  evaluateAutomationSchedule,
  newAutomationDraft,
  type Automation,
  type AutomationRun,
  type DueAutomationRun,
} from "./automations";

const NOW = new Date("2026-10-12T19:31:14").getTime();
const ONCE_AT = new Date("2026-10-12T19:30:00").getTime();

function automation(overrides: Partial<Automation> = {}): Automation {
  const draft = newAutomationDraft("/Users/tony/missed once test", NOW);
  return {
    ...draft,
    id: "missed-once",
    name: "missed once test",
    triggers: [createAutomationTrigger("time")],
    enabled: true,
    nextRunAt: NOW + 3_600_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Automation;
}

function run(
  id: string,
  overrides: Partial<AutomationRun> = {},
): AutomationRun {
  return {
    id,
    automationId: "missed-once",
    trigger: "scheduled",
    scheduledFor: ONCE_AT,
    createdAt: NOW,
    status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("evaluateAutomationSchedule", () => {
  it("picks up a run left Pending by a dropped launch", async () => {
    const left: DueAutomationRun = {
      automation: automation({ enabled: false }),
      run: run("left-pending", { createdAt: NOW - 60_000 }),
    };
    invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "automations_list") return [];
      if (command === "automation_runs_pending") {
        expect(args).toEqual({ createdBefore: NOW - PENDING_PICKUP_MS });
        return [left];
      }
      throw new Error(`unexpected ${command}`);
    });
    const launched: string[] = [];
    await evaluateAutomationSchedule((item) => launched.push(item.run.id), NOW);
    expect(launched).toEqual(["left-pending"]);
  });

  it("launches a run it just claimed once, even when the sweep also lists it", async () => {
    const due = automation({ nextRunAt: ONCE_AT });
    due.triggers = [
      { ...createAutomationTrigger("time"), scheduleKind: "once", at: ONCE_AT },
    ];
    const claimed: DueAutomationRun = {
      automation: { ...due, enabled: false },
      run: run("claimed"),
    };
    invoke.mockImplementation(async (command: string) => {
      if (command === "automations_list") return [due];
      if (command === "automations_claim_due") return claimed;
      if (command === "automation_runs_pending") return [claimed];
      throw new Error(`unexpected ${command}`);
    });
    const launched: string[] = [];
    await evaluateAutomationSchedule((item) => launched.push(item.run.id), NOW);
    expect(launched).toEqual(["claimed"]);
  });
});

describe("beginAutomationRun", () => {
  it("returns null when the store refuses to start the run", async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(beginAutomationRun("run-1", NOW)).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("automation_run_begin", {
      runId: "run-1",
      now: NOW,
    });
  });
});
