import { describe, expect, it, vi } from "vitest";

// Wave 3 integration: a Tauri API that is missing or throws (a test mock,
// a browser preview) must never reject into the Settings page or the host
// (corner case 9). Found in the full suite: SettingsView's mock has no
// isTauri, and two unhandled rejections failed the run.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("no app");
  }),
  isTauri: () => {
    throw new Error("isTauri missing");
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  configureHarnessTelemetry,
  harnessTelemetryStatus,
  listenHarnessTelemetry,
} from "./telemetryBridge";

describe("the telemetry bridge without the app", () => {
  it("status resolves to null", async () => {
    await expect(harnessTelemetryStatus()).resolves.toBeNull();
  });

  it("configure resolves to false", async () => {
    await expect(configureHarnessTelemetry(true, false, ["c1"])).resolves.toBe(false);
  });

  it("listen returns a stop function and never throws", () => {
    const stop = listenHarnessTelemetry(() => {});
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
