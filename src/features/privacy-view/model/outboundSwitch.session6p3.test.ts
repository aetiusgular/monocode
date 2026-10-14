import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("../../../platform/tauri/fs", () => ({
  homeDir: async () => "/home/test",
}));
vi.mock("../../../integrations/harness/core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/bin/codex" }),
  inspectHarnessBinary: vi.fn(async () => ({ path: "/bin/devin" })),
  spawnChild: async () => undefined,
  watchChild: () => undefined,
  unwatchChild: () => undefined,
  killChild: async () => undefined,
}));

import {
  OUTBOUND_CALL_OFF_MESSAGE,
  resetOutboundCallsCache,
} from "../../settings/model/outboundCalls";
import {
  clearCachedRateLimits,
  getCachedRateLimits,
  loadRateLimits,
  setCachedRateLimits,
} from "../../providers/model/rateLimitsCache";
import type { ProviderRateLimits } from "../../providers/model/rateLimits";
import { setOutboundCall } from "./outboundSwitch";

// Mac 5.9 retest: with Usage figures off, the Claude Code footer kept
// "32% now · 48% 6d 3h" and "Updated 58m ago" until refresh was pressed.

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const figures = (provider: "claude" | "codex"): ProviderRateLimits =>
  ({
    provider,
    session: { usedPercent: 32, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 48, windowMinutes: 10080, resetsAt: null },
    monthly: null,
    resetCredits: null,
    updatedAt: Date.now() - 58 * 60_000,
    error: null,
    status: "ok",
  }) as unknown as ProviderRateLimits;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", new EventTarget());
  resetOutboundCallsCache();
  invoke.mockReset();
  clearCachedRateLimits();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

describe("turning Usage figures off", () => {
  it("clears shown Claude figures at once, for every account", () => {
    setCachedRateLimits("claude", "default", figures("claude"));
    setCachedRateLimits("claude", "work", figures("claude"));
    setOutboundCall("usage", false);
    for (const account of ["default", "work"]) {
      const limits = getCachedRateLimits("claude", account);
      expect(limits.status).toBe("unavailable");
      expect(limits.error).toBe(OUTBOUND_CALL_OFF_MESSAGE);
      expect(limits.session).toBeNull();
      expect(limits.weekly).toBeNull();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves Codex alone, which the switch does not cover", () => {
    const codex = figures("codex");
    setCachedRateLimits("codex", "default", codex);
    setOutboundCall("usage", false);
    expect(getCachedRateLimits("codex")).toBe(codex);
  });

  it("drops figures from a request still running when the switch went off", async () => {
    let finish: (value: unknown) => void = () => undefined;
    invoke.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const run = loadRateLimits("opencode", "default", true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    setOutboundCall("usage", false);
    finish({ status: "ok", usage: { rolling: { usedPercent: 10 } } });
    const result = await run;
    expect(result.error).toBe(OUTBOUND_CALL_OFF_MESSAGE);
    expect(getCachedRateLimits("opencode").error).toBe(
      OUTBOUND_CALL_OFF_MESSAGE,
    );
  });
});
