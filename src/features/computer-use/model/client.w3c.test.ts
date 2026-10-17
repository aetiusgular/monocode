import { describe, expect, it } from "vitest";
import {
  chatGrants,
  chatRunning,
  pendingFor,
  resetComputerUseClient,
  sanitizeApp,
  sanitizeGrants,
  sanitizeStatus,
  sanitizeStop,
  setComputerUseStateForTest,
} from "./client";

describe("what the app answers is checked before use", () => {
  it("takes well-formed grants only", () => {
    expect(
      sanitizeGrants([
        { chatId: "c1", bundleId: "com.apple.calculator", grantedAt: 1, approvalId: "a", appName: "Calculator" },
        { chatId: "c1", bundleId: "x.y", grantedAt: "soon", approvalId: "b" },
        { bundleId: "x.y", grantedAt: 1, approvalId: "c" },
        null,
      ]),
    ).toEqual([
      { chatId: "c1", bundleId: "com.apple.calculator", grantedAt: 1, approvalId: "a", appName: "Calculator" },
    ]);
    expect(sanitizeGrants("nope")).toEqual([]);
  });

  it("reads the status, dropping malformed cards and unknown states", () => {
    const status = sanitizeStatus({
      helper: "exploded",
      runningChats: ["c1", 4],
      pending: [
        { requestId: "r1", chatId: "c1", app: "Calculator", reason: "sums", askedAt: 5, resolved: { bundleId: "com.apple.calculator", warning: "terminal" } },
        { requestId: "r2", chatId: "c1", askedAt: 5 },
      ],
    });
    expect(status.helper).toBe("unsupported");
    expect(status.runningChats).toEqual(["c1"]);
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0].resolved).toEqual({ bundleId: "com.apple.calculator", warning: "terminal" });
  });

  it("drops an unknown warning and an oversized name", () => {
    expect(sanitizeApp({ bundleId: "a.b", warning: "nuclear", name: "x".repeat(300) })).toEqual({ bundleId: "a.b" });
    expect(sanitizeApp({})).toBeNull();
  });

  it("reads a stop report", () => {
    expect(sanitizeStop({ stopped: true, ended: 2, releasedButtons: ["left", 3], warning: "w" })).toEqual({
      stopped: true,
      ended: 2,
      releasedButtons: ["left"],
      warning: "w",
    });
    expect(sanitizeStop(null)).toEqual({ stopped: false, ended: 0, releasedButtons: [] });
  });

  it("answers per chat from what was read", () => {
    resetComputerUseClient();
    setComputerUseStateForTest({
      status: { helper: "running", runningChats: ["c1"], pending: [{ requestId: "r", chatId: "c2", app: "x", reason: "", askedAt: 1 }] },
      grants: { c1: [{ chatId: "c1", bundleId: "a.b", grantedAt: 1, approvalId: "a" }] },
    });
    expect(chatRunning("c1")).toBe(true);
    expect(chatRunning("c2")).toBe(false);
    expect(chatGrants("c1")).toHaveLength(1);
    expect(chatGrants(undefined)).toEqual([]);
    expect(pendingFor("c2")).toHaveLength(1);
    expect(pendingFor("c1")).toEqual([]);
    resetComputerUseClient();
  });
});
