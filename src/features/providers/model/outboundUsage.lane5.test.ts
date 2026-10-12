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
const inspectHarnessBinary = vi.hoisted(() =>
  vi.fn(async () => ({ path: "/bin/devin", version: "devin 3000.6.7" })),
);
vi.mock("../../../integrations/harness/core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/bin/codex" }),
  inspectHarnessBinary,
  spawnChild: async () => undefined,
  watchChild: () => undefined,
  unwatchChild: () => undefined,
  killChild: async () => undefined,
}));

import {
  OUTBOUND_CALL_OFF_MESSAGE,
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";
import {
  fetchClaudeRateLimits,
  fetchDevinRateLimits,
  fetchOpencodeGoRateLimits,
} from "./rateLimitsFetch";
import { fetchPiUsage } from "./piUsage";
import { fetchLatestHarnessVersion } from "./harnessUpdates";
import {
  clearCachedRateLimits,
  getCachedRateLimits,
  loadRateLimits,
} from "./rateLimitsCache";
import { setOutboundCall } from "../../privacy-view/model/outboundSwitch";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  resetOutboundCallsCache();
  invoke.mockReset();
  inspectHarnessBinary.mockClear();
  clearCachedRateLimits();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

const commands = () => invoke.mock.calls.map(([command]) => command);

describe("usage figures switch", () => {
  it("off: Claude, OpenCode Go, Devin and Pi make no call and settle as unavailable", async () => {
    setOutboundCallAllowed("usage", false);
    const results = await Promise.all([
      fetchClaudeRateLimits(),
      fetchOpencodeGoRateLimits(),
      fetchDevinRateLimits(),
      fetchPiUsage("anthropic"),
      fetchPiUsage("openai-codex"),
    ]);
    expect(invoke).not.toHaveBeenCalled();
    expect(inspectHarnessBinary).not.toHaveBeenCalled();
    for (const result of results) {
      expect(result.status).toBe("unavailable");
      expect(result.error).toBe(OUTBOUND_CALL_OFF_MESSAGE);
    }
  });

  it("on: each usage command is called", async () => {
    invoke.mockResolvedValue({ status: "unavailable", error: "not signed in" });
    await fetchClaudeRateLimits();
    await fetchOpencodeGoRateLimits();
    await fetchDevinRateLimits();
    await fetchPiUsage("anthropic");
    expect(commands()).toEqual([
      "fetch_claude_usage",
      "fetch_opencode_go_usage",
      "fetch_devin_usage",
      "fetch_pi_usage",
    ]);
  });

  it("off leaves no pending state in the cache, and on again reloads it", async () => {
    setOutboundCallAllowed("usage", false);
    await loadRateLimits("claude", "default");
    await loadRateLimits("devin", "default");
    expect(getCachedRateLimits("claude").status).toBe("unavailable");
    expect(getCachedRateLimits("devin").status).toBe("unavailable");
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue({
      status: "unavailable",
      error: "Claude not signed in",
    });
    setOutboundCall("usage", true);
    await vi.waitFor(() =>
      expect(commands()).toEqual(
        expect.arrayContaining(["fetch_claude_usage", "fetch_devin_usage"]),
      ),
    );
    await vi.waitFor(() =>
      expect(getCachedRateLimits("claude").error).toBe("Claude not signed in"),
    );
  });
});

describe("version check switch", () => {
  it("off: rejects without a registry call; on: asks the registry", async () => {
    setOutboundCallAllowed("version-check", false);
    await expect(fetchLatestHarnessVersion("claude")).rejects.toThrow(
      OUTBOUND_CALL_OFF_MESSAGE,
    );
    expect(invoke).not.toHaveBeenCalled();
    setOutboundCallAllowed("version-check", true);
    invoke.mockResolvedValue("2.0.0");
    await expect(fetchLatestHarnessVersion("claude")).resolves.toBe("2.0.0");
    expect(commands()).toEqual(["harness_latest_version"]);
  });
});
