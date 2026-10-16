import { afterEach, describe, expect, it, vi } from "vitest";
import {
  harnessListsSessions,
  listHarnessSessions,
  readHarnessSessionTurns,
  registerHarness,
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

describe("session list wrappers", () => {
  it("refuse to list and import nothing on a harness without them (corner case 11)", async () => {
    registerHarness(adapter({}));
    expect(harnessListsSessions("grok")).toBe(false);
    await expect(listHarnessSessions("grok", { cwd: "/r" })).rejects.toThrow(
      "grok cannot list its sessions",
    );
    await expect(
      readHarnessSessionTurns("grok", { cwd: "/r", providerSessionId: "s" }),
    ).resolves.toBeNull();
    // A harness that is not installed at all.
    expect(harnessListsSessions("omp")).toBe(false);
    await expect(listHarnessSessions("omp", { cwd: "/r" })).rejects.toThrow();
  });

  it("pass through to the adapter, errors included", async () => {
    const listSessions = vi.fn(async () => [{ id: "a", title: "A", updatedAt: 1 }]);
    const readSessionTurns = vi.fn(async () => {
      throw new Error("thread not loaded");
    });
    registerHarness(adapter({ listSessions, readSessionTurns }));
    expect(harnessListsSessions("grok")).toBe(true);
    await expect(
      listHarnessSessions("grok", { cwd: "/r", providerAccountId: "x" }),
    ).resolves.toHaveLength(1);
    expect(listSessions).toHaveBeenCalledWith({ cwd: "/r", providerAccountId: "x" });
    await expect(
      readHarnessSessionTurns("grok", { cwd: "/r", providerSessionId: "s" }),
    ).rejects.toThrow("thread not loaded");
  });
});
