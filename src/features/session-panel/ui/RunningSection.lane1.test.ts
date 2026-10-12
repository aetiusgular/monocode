// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listHarnessBackgroundTasks_l1 = vi.hoisted(() => vi.fn());
const stopHarnessBackgroundTask_l1 = vi.hoisted(() => vi.fn());
vi.mock("../../../integrations/harness/core/registry", () => ({
  listHarnessBackgroundTasks_l1,
  stopHarnessBackgroundTask_l1,
}));

const { RunningSection, RUNNING_POLL_MS } = await import("./RunningSection");
const {
  resetOwnedProcessesForTest,
  setOwnedProcessPtyForTest,
  startOwnedProcess,
} = await import("../../owned-processes/model/ownedProcesses");

import type { BackgroundItem } from "../../../integrations/harness/core/background";

let container: HTMLDivElement;
let root: Root;
const ptyData = new Map<string, (bytes: Uint8Array) => void>();

const item = (patch: Partial<BackgroundItem> = {}): BackgroundItem => ({
  id: "t1",
  kind: "shell",
  title: "npm test",
  status: "running",
  stoppable: true,
  source: "harness",
  ...patch,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  listHarnessBackgroundTasks_l1.mockReset();
  stopHarnessBackgroundTask_l1.mockReset();
  ptyData.clear();
  setOwnedProcessPtyForTest({
    spawn: async () => undefined,
    kill: async () => undefined,
    subscribe: (id, data) => {
      ptyData.set(id, data);
      return () => ptyData.delete(id);
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetOwnedProcessesForTest();
  setOwnedProcessPtyForTest(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(props: Partial<Parameters<typeof RunningSection>[0]>) {
  await act(async () => {
    root.render(
      createElement(RunningSection, {
        sessionId: "s1",
        harness: "claude",
        blocks: [],
        ...props,
      }),
    );
  });
}

describe("RunningSection", () => {
  it("renders nothing when nothing runs", async () => {
    await render({});
    expect(container.querySelector("[data-panel-section]")).toBeNull();
  });

  it("lists a harness item with a stop button and stops it by id", async () => {
    stopHarnessBackgroundTask_l1.mockResolvedValue(true);
    await render({ pushed: [item()] });
    expect(container.textContent).toContain("npm test");
    expect(container.querySelector("[data-running-count]")?.textContent).toBe("1");
    const stop = container.querySelector<HTMLButtonElement>("[data-running-stop]");
    await act(async () => stop!.click());
    expect(stopHarnessBackgroundTask_l1).toHaveBeenCalledWith("claude", "s1", "t1");
    expect(
      container.querySelector("[data-running-row]")?.getAttribute("data-running-status"),
    ).toBe("stopping");
  });

  it("says so when a stop finds nothing to stop", async () => {
    stopHarnessBackgroundTask_l1.mockResolvedValue(false);
    await render({ pushed: [item()] });
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-running-stop]")!.click(),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "already stopped",
    );
    expect(
      container.querySelector("[data-running-row]")?.getAttribute("data-running-status"),
    ).toBe("running");
  });

  it("offers no stop for a harness without one (corner case 11)", async () => {
    await render({ harness: "opencode", pushed: [item()] });
    expect(container.querySelector("[data-running-stop]")).toBeNull();
    expect(container.textContent).toContain("Stops with the turn.");
  });

  it("polls Codex while shown and stops asking when it has no list", async () => {
    vi.useFakeTimers();
    listHarnessBackgroundTasks_l1.mockResolvedValueOnce([item({ id: "42" })]);
    listHarnessBackgroundTasks_l1.mockResolvedValueOnce(null);
    await render({ harness: "codex" });
    expect(container.textContent).toContain("npm test");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS);
    });
    expect(listHarnessBackgroundTasks_l1).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS * 3);
    });
    expect(listHarnessBackgroundTasks_l1).toHaveBeenCalledTimes(2);
  });

  it("does not poll while the panel is behind another tab", async () => {
    await render({ harness: "codex", active: false });
    expect(listHarnessBackgroundTasks_l1).not.toHaveBeenCalled();
  });

  it("shows a MonoCode process with its output and no terminal codes", async () => {
    const process = await startOwnedProcess({
      sessionId: "s1",
      cwd: "/repo",
      title: "Dev server",
      kind: "server",
      command: { program: "npm", args: ["run", "dev"] },
      confirmedByUser: true,
    });
    ptyData.get(process.id)?.(
      new TextEncoder().encode("\u001b[32mready\u001b[0m on :5173\n"),
    );
    await render({ harness: "grok" });
    expect(container.textContent).toContain("Dev server");
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show output"]',
    );
    await act(async () => toggle!.click());
    expect(container.querySelector("[data-running-output]")?.textContent).toBe(
      "ready on :5173\n",
    );
  });
});
