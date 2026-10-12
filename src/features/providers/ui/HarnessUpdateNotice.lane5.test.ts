// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HarnessUpdateNotice } from "./HarnessUpdateNotice";
import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";

const invoke = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    if (command === "harness_update_check_claim") return true;
    if (command === "harness_latest_version") return "2.1.285";
    throw new Error(`unexpected ${command}`);
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../../integrations/harness/core/availability", () => ({
  probeHarnessAvailability: vi.fn(async () => undefined),
  isHarnessAvailable: (id: string) => id === "claude",
}));
vi.mock("../../../integrations/harness/core/child", () => ({
  inspectHarnessBinary: vi.fn(async () => ({
    path: "/bin/claude",
    version: "2.1.284 (Claude Code)",
  })),
  updateHarnessCli: vi.fn(async () => undefined),
}));
vi.mock("../../sessions/model/models", () => ({
  isPickerProviderVisible: () => true,
}));
vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("../../sessions/ui/HarnessIcon", () => ({ HarnessIcon: () => null }));

const commands = () => invoke.mock.calls.map(([command]) => command);
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
  resetOutboundCallsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

it("off: no claim and no registry lookup, no notice; on again: checks", async () => {
  setOutboundCallAllowed("version-check", false);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(HarnessUpdateNotice)));
  await flush();
  expect(invoke).not.toHaveBeenCalled();
  expect(
    document.body.querySelector('[aria-label="Harness updates"]'),
  ).toBeNull();

  await act(async () => setOutboundCallAllowed("version-check", true));
  await flush();
  expect(commands()).toEqual([
    "harness_update_check_claim",
    "harness_latest_version",
  ]);
  expect(
    document.body.querySelector('[aria-label="Harness updates"]')?.textContent,
  ).toContain("2.1.284 → 2.1.285");
  act(() => root.unmount());
});
