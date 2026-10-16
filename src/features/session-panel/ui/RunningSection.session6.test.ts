// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundItem } from "../../../integrations/harness/core/background";
import type { Block } from "../../sessions/model/session";

const listHarnessBackgroundTasks = vi.hoisted(() => vi.fn());
const stopHarnessBackgroundTask = vi.hoisted(() => vi.fn());
vi.mock("../../../integrations/harness/core/registry", () => ({
  listHarnessBackgroundTasks,
  stopHarnessBackgroundTask,
}));

const { RunningSection, RUNNING_BUSY_POLL_MS, RUNNING_POLL_MS } = await import(
  "./RunningSection"
);
const { resetOwnedProcessesForTest } = await import(
  "../../owned-processes/model/ownedProcesses"
);

let container: HTMLDivElement;
let root: Root;

const sleep = (patch: Partial<BackgroundItem> = {}): BackgroundItem => ({
  id: "67164",
  kind: "shell",
  title: "sleep 120",
  status: "running",
  stoppable: true,
  source: "harness",
  ...patch,
});

const codexSubagent: Block = {
  id: "agent-1",
  role: "tool",
  text: "Create a MonoCode automation for this project that runs",
  tool: {
    callId: "agent-1",
    kind: "agent",
    title: "Create a MonoCode automation for this project that runs",
    status: "in_progress",
  },
} as Block;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  listHarnessBackgroundTasks.mockReset();
  stopHarnessBackgroundTask.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetOwnedProcessesForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(props: Partial<Parameters<typeof RunningSection>[0]>) {
  await act(async () => {
    root.render(
      createElement(RunningSection, {
        sessionId: "s1",
        harness: "codex",
        blocks: [],
        ...props,
      }),
    );
  });
}

const rows = () => [...container.querySelectorAll("[data-running-row]")];

describe("Running section on Codex during a turn (Mac test 1.8)", () => {
  it("lists a long command within 5 s and stops it by Codex's process id", async () => {
    vi.useFakeTimers();
    // The app-server is still starting when the panel first asks: no list.
    listHarnessBackgroundTasks.mockResolvedValueOnce(null);
    listHarnessBackgroundTasks.mockResolvedValue([sleep()]);
    stopHarnessBackgroundTask.mockResolvedValue(true);
    await render({ busy: true });
    expect(container.querySelector("[data-panel-section]")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_BUSY_POLL_MS);
    });
    expect(RUNNING_BUSY_POLL_MS).toBeLessThanOrEqual(5_000);
    expect(container.textContent).toContain("sleep 120");
    const stop = container.querySelector<HTMLButtonElement>("[data-running-stop]");
    expect(stop).not.toBeNull();
    await act(async () => stop!.click());
    expect(stopHarnessBackgroundTask).toHaveBeenCalledWith("codex", "s1", "67164");
  });

  it("keeps asking through the turn after an answer of no list", async () => {
    vi.useFakeTimers();
    listHarnessBackgroundTasks.mockResolvedValue(null);
    await render({ busy: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_BUSY_POLL_MS * 3);
    });
    expect(listHarnessBackgroundTasks).toHaveBeenCalledTimes(4);
  });

  it("stays empty and usable on a Codex without the methods (corner case 11)", async () => {
    vi.useFakeTimers();
    listHarnessBackgroundTasks.mockResolvedValue(null);
    await render({ busy: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_BUSY_POLL_MS * 2);
    });
    expect(container.querySelector("[data-panel-section]")).toBeNull();
    // The turn ends: the poll stops after the next empty answer.
    await render({ busy: false });
    const calls = listHarnessBackgroundTasks.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS * 3);
    });
    expect(listHarnessBackgroundTasks.mock.calls.length).toBe(calls);
    expect(container.querySelector("[data-panel-section]")).toBeNull();
  });
});

describe("Rows that stop with the turn (Mac test 2.17)", () => {
  it("shows a Codex subagent while the turn runs, without a stop", async () => {
    listHarnessBackgroundTasks.mockResolvedValue([]);
    await render({ busy: true, blocks: [codexSubagent] });
    expect(rows().map((row) => row.getAttribute("data-running-row"))).toEqual([
      "subagent",
    ]);
    expect(container.textContent).toContain("Stops with the turn.");
    expect(container.querySelector("[data-running-stop]")).toBeNull();
  });

  it("clears it when the turn stops, though its row never closed", async () => {
    listHarnessBackgroundTasks.mockResolvedValue([]);
    await render({ busy: true, blocks: [codexSubagent] });
    expect(rows()).toHaveLength(1);
    // After Stop the session is no longer busy; the tool row still says
    // in_progress because Codex's closing event came after the stop.
    await render({ busy: false, blocks: [codexSubagent] });
    expect(rows()).toHaveLength(0);
    expect(container.querySelector("[data-panel-section]")).toBeNull();
  });

  it("keeps a background shell that outlives the turn", async () => {
    listHarnessBackgroundTasks.mockResolvedValue([sleep()]);
    await render({ busy: false, blocks: [codexSubagent] });
    expect(rows().map((row) => row.getAttribute("data-running-row"))).toEqual([
      "shell",
    ]);
  });
});
