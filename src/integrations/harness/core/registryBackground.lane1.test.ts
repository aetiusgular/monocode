import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listHarnessBackgroundTasks,
  registerHarness,
  stopHarnessBackgroundTask,
  type HarnessAdapter,
} from "./registry";

function adapter(patch: Partial<HarnessAdapter>): HarnessAdapter {
  return {
    id: "grok",
    live: true,
    sendTurn: async () => undefined,
    cancelTurn: async () => undefined,
    respondApproval: async () => undefined,
    stopSession: async () => undefined,
    ...patch,
  } as HarnessAdapter;
}

afterEach(() => {
  registerHarness(adapter({}));
});

describe("background wrappers", () => {
  it("answer no list and no stop for a harness without them (corner case 11)", async () => {
    registerHarness(adapter({}));
    await expect(listHarnessBackgroundTasks("grok", "s1")).resolves.toBeNull();
    await expect(stopHarnessBackgroundTask("grok", "s1", "t1")).resolves.toBe(
      false,
    );
    // A harness that is not installed at all.
    await expect(listHarnessBackgroundTasks("omp", "s1")).resolves.toBeNull();
    await expect(stopHarnessBackgroundTask("omp", "s1", "t1")).resolves.toBe(
      false,
    );
  });

  it("pass through to the adapter", async () => {
    const stopBackgroundTask = vi.fn(async () => true);
    const listBackgroundTasks = vi.fn(async () => []);
    registerHarness(adapter({ stopBackgroundTask, listBackgroundTasks }));
    await expect(stopHarnessBackgroundTask("grok", "s1", "t1")).resolves.toBe(
      true,
    );
    expect(stopBackgroundTask).toHaveBeenCalledWith("s1", "t1");
    await expect(listHarnessBackgroundTasks("grok", "s1")).resolves.toEqual(
      [],
    );
  });

  it("turn a failed list into no list rather than an error", async () => {
    registerHarness(
      adapter({
        listBackgroundTasks: async () => {
          throw new Error("experimental method refused");
        },
      }),
    );
    await expect(listHarnessBackgroundTasks("grok", "s1")).resolves.toBeNull();
  });
});
