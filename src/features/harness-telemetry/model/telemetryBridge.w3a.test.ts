import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  isTauri: true,
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauri.isTauri,
  invoke: (...args: unknown[]) => tauri.invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => tauri.listen(...args),
}));

import {
  MAX_CHAT_IDS,
  TELEMETRY_EVENTS_CHANNEL,
  configureHarnessTelemetry,
  harnessTelemetryStatus,
  isReceiverEvent,
  listenHarnessTelemetry,
} from "./telemetryBridge";

beforeEach(() => {
  tauri.isTauri = true;
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
});

const good = {
  id: "otel-1",
  at: 1,
  chatId: "c",
  harness: "claude",
  source: "otel",
  kind: "tool.call",
  summary: "Bash ok",
  detail: { attributes: {} },
};

describe("telemetry bridge", () => {
  it("configure sends the switches and at most 5,000 chat ids", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const ids = Array.from({ length: 6000 }, (_, i) => `c${i}`);
    expect(await configureHarnessTelemetry(true, false, ids)).toBe(true);
    const [command, args] = tauri.invoke.mock.calls[0];
    expect(command).toBe("harness_telemetry_configure");
    expect(args.enabled).toBe(true);
    expect(args.logPrompts).toBe(false);
    expect(args.chats).toHaveLength(MAX_CHAT_IDS);
  });

  it("configure never throws and never hangs (case 9)", async () => {
    tauri.invoke.mockRejectedValue(new Error("no receiver"));
    expect(await configureHarnessTelemetry(true, true, [])).toBe(false);
    vi.useFakeTimers();
    tauri.invoke.mockReturnValue(new Promise(() => {}));
    const pending = configureHarnessTelemetry(true, true, []);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toBe(false);
    vi.useRealTimers();
  });

  it("outside the app nothing is called", async () => {
    tauri.isTauri = false;
    expect(await configureHarnessTelemetry(true, false, ["c"])).toBe(false);
    expect(await harnessTelemetryStatus()).toBeNull();
    expect(listenHarnessTelemetry(() => {})).toBeTypeOf("function");
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(tauri.listen).not.toHaveBeenCalled();
  });

  it("only well-formed OTel events pass from the receiver", () => {
    expect(isReceiverEvent(good)).toBe(true);
    expect(isReceiverEvent({ ...good, source: "adapter" })).toBe(false);
    expect(isReceiverEvent({ ...good, detail: [] })).toBe(false);
    expect(isReceiverEvent({ ...good, at: "1" })).toBe(false);
    expect(isReceiverEvent(null)).toBe(false);
  });

  it("listen filters each batch and stops on request", async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    tauri.listen.mockImplementation((channel: string, h: typeof handler) => {
      expect(channel).toBe(TELEMETRY_EVENTS_CHANNEL);
      handler = h;
      return Promise.resolve(unlisten);
    });
    const seen: unknown[][] = [];
    const stop = listenHarnessTelemetry((events) => seen.push(events));
    handler?.({ payload: [good, { bad: true }] });
    handler?.({ payload: "not a list" });
    expect(seen).toEqual([[good]]);
    stop();
    handler?.({ payload: [good] });
    expect(seen).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });
});
