// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelAutomationRun,
  newAutomationDraft,
  type AutomationRun,
} from "../model/automations";
import { RunRow } from "./AutomationsView";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const run = (status: AutomationRun["status"]): AutomationRun => ({
  id: "run-1",
  automationId: "automation-1",
  trigger: "scheduled",
  scheduledFor: 1_000,
  createdAt: 1_000,
  status,
});

function renderRow(row: AutomationRun, onCancel?: (id: string) => void) {
  act(() =>
    root.render(
      createElement(
        "ul",
        null,
        createElement(RunRow, {
          run: row,
          draft: newAutomationDraft("/repo", "claude", "claude:sonnet"),
          onOpenSession: () => undefined,
          onCancel,
        }),
      ),
    ),
  );
  return container.querySelector<HTMLButtonElement>(
    "[data-automation-run-cancel]",
  );
}

describe("Cancel on a pending run in Run history (R7)", () => {
  it("shows Cancel on a pending run and sends its id", () => {
    const onCancel = vi.fn();
    const button = renderRow(run("pending"), onCancel);
    expect(button?.textContent).toBe("Cancel");
    act(() => button!.click());
    expect(onCancel).toHaveBeenCalledWith("run-1");
  });

  it("shows no Cancel once a run started or ended", () => {
    for (const status of [
      "running",
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
    ] as const) {
      expect(renderRow(run(status), vi.fn()), status).toBeNull();
    }
  });

  it("asks Rust to cancel that one run", async () => {
    invoke.mockResolvedValue(true);
    expect(await cancelAutomationRun("run-1")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("automation_run_cancel", {
      runId: "run-1",
    });
    invoke.mockResolvedValue(false);
    expect(await cancelAutomationRun("run-2")).toBe(false);
  });
});
