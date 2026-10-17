// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HARNESS_TELEMETRY_KEY,
  __resetHarnessTelemetryCache,
  defaultHarnessTelemetry,
  harnessTelemetryKey,
  loadHarnessTelemetry,
  sanitizeHarnessTelemetry,
  setHarnessTelemetry,
} from "./telemetrySettings";
import { claudeSettingsKey } from "../../../integrations/harness/providers/claude/claudeProtocol";

beforeEach(() => {
  localStorage.clear();
  __resetHarnessTelemetryCache();
});

describe("telemetry settings", () => {
  it("defaults: on, prompt text off", () => {
    expect(defaultHarnessTelemetry()).toEqual({ enabled: true, logPrompts: false });
    expect(loadHarnessTelemetry()).toEqual({ enabled: true, logPrompts: false });
    expect(harnessTelemetryKey()).toBe("");
  });

  it("stored values are sanitised", () => {
    expect(sanitizeHarnessTelemetry({ enabled: "yes", logPrompts: 1 })).toEqual(defaultHarnessTelemetry());
    expect(sanitizeHarnessTelemetry([true])).toEqual(defaultHarnessTelemetry());
    localStorage.setItem(HARNESS_TELEMETRY_KEY, "{not json");
    expect(loadHarnessTelemetry()).toEqual(defaultHarnessTelemetry());
  });

  it("a change is stored, read back and changes the restart key", () => {
    let changed = 0;
    window.addEventListener("monocode:harnesstelemetrychange", () => (changed += 1));
    setHarnessTelemetry({ logPrompts: true });
    expect(changed).toBe(1);
    expect(loadHarnessTelemetry()).toEqual({ enabled: true, logPrompts: true });
    const on = harnessTelemetryKey();
    expect(JSON.parse(on)).toEqual({ enabled: true, logPrompts: true });
    setHarnessTelemetry({ enabled: false });
    expect(harnessTelemetryKey()).not.toBe(on);
    __resetHarnessTelemetryCache();
    expect(loadHarnessTelemetry()).toEqual({ enabled: false, logPrompts: true });
  });

  it("a change restarts Claude Code: the settings key carries it", () => {
    const base = { model: "m", runtimeMode: "approval-required" } as Parameters<typeof claudeSettingsKey>[0];
    const without = claudeSettingsKey(base);
    expect(claudeSettingsKey({ ...base, telemetry: "" })).toBe(without);
    const a = claudeSettingsKey({ ...base, telemetry: '{"enabled":true,"logPrompts":false}' });
    const b = claudeSettingsKey({ ...base, telemetry: '{"enabled":true,"logPrompts":true}' });
    expect(a).not.toBe(without);
    expect(a).not.toBe(b);
  });

  it("claude.ts and codex.ts read the same storage key", () => {
    const root = path.resolve(__dirname, "../../../integrations/harness/providers");
    for (const file of ["claude/claude.ts", "codex/codex.ts"]) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source).toContain(`localStorage.getItem("${HARNESS_TELEMETRY_KEY}")`);
    }
  });
});
