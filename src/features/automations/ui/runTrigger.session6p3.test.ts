import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import {
  createAutomationTrigger,
  firingTriggerId,
  formatAutomationRunAt,
  newAutomationDraft,
  type AutomationRun,
} from "../model/automations";
import { RunRow } from "./AutomationsView";

// Mac 2.13 retest: the 12 Oct row read "Once, 13 Oct, 18:30", the schedule
// as it is now, not the one that fired.

const oldAt = new Date(2026, 9, 12, 9, 0).getTime();
const newAt = new Date(2026, 9, 13, 18, 30).getTime();

function draftScheduledAt(at: number) {
  const draft = newAutomationDraft("/repo", "claude", "claude:sonnet");
  return {
    ...draft,
    triggers: [createAutomationTrigger("time", "once", { id: "t", at })],
  };
}

const run = (extra: Partial<AutomationRun> = {}): AutomationRun => ({
  id: "run-1",
  automationId: "a",
  trigger: "scheduled",
  scheduledFor: oldAt,
  createdAt: oldAt,
  status: "succeeded",
  ...extra,
});

const render = (row: AutomationRun) =>
  renderToStaticMarkup(
    createElement(RunRow, {
      run: row,
      draft: draftScheduledAt(newAt),
      onOpenSession: () => undefined,
    }),
  );

describe("Run history Trigger column", () => {
  it("shows the schedule stored on the run, not the current one", () => {
    const markup = render(
      run({
        sourceTrigger: createAutomationTrigger("time", "once", {
          id: "t",
          at: oldAt,
        }),
      }),
    );
    expect(markup).toContain(`Once, ${formatAutomationRunAt(oldAt)}`);
    expect(markup).not.toContain(formatAutomationRunAt(newAt));
  });

  it("shows no schedule for an old row that stored none", () => {
    const markup = render(run());
    expect(markup).toContain("Scheduled");
    expect(markup).not.toContain(formatAutomationRunAt(newAt));
    expect(markup).not.toContain("Once,");
  });
});

describe("which trigger fired", () => {
  it("names the one trigger whose schedule lands on the moment", () => {
    const once = createAutomationTrigger("time", "once", {
      id: "once",
      at: newAt,
    });
    const daily = createAutomationTrigger("time", "daily", {
      id: "daily",
      time: "09:00",
    });
    expect(firingTriggerId([once, daily], newAt)).toBe("once");
    expect(firingTriggerId([once, daily], oldAt)).toBe("daily");
    expect(firingTriggerId([once, daily], oldAt + 60_000)).toBeNull();
  });
});
