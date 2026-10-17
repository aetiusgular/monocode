// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  configure: vi.fn(async () => true),
  onEvents: null as null | ((events: unknown[]) => void),
  stopped: 0,
}));
vi.mock("../model/telemetryBridge", () => ({
  configureHarnessTelemetry: (...args: unknown[]) => bridge.configure(...(args as [])),
  listenHarnessTelemetry: (cb: (events: unknown[]) => void) => {
    bridge.onEvents = cb;
    return () => (bridge.stopped += 1);
  },
}));
const written = vi.hoisted(() => [] as { kind: string; chatId: string; harness: string }[]);
vi.mock("../../activity/model/activityStore", () => ({
  recordActivity: (e: { kind: string; chatId: string; harness: string }) => written.push(e),
  recordApproval: () => {},
}));

import { HarnessTelemetryHost } from "./HarnessTelemetryHost";
import { tapHarnessEvent, telemetryFeed } from "../model/telemetryTap";
import { __resetHarnessTelemetryCache, setHarnessTelemetry } from "../model/telemetrySettings";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  __resetHarnessTelemetryCache();
  bridge.configure.mockClear();
  written.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

it("tells the receiver the chats and switches, feeds its batches and its timer", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const sessions = [
    { id: "c1", harness: "claude" as const },
    { id: "c2", harness: "codex" as const },
  ];
  act(() => root.render(createElement(HarnessTelemetryHost, { sessions })));
  expect(host.innerHTML).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(bridge.configure).toHaveBeenLastCalledWith(true, false, ["c1", "c2"]);

  act(() => setHarnessTelemetry({ logPrompts: true }));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(bridge.configure).toHaveBeenLastCalledWith(true, true, ["c1", "c2"]);

  // The tap knows each chat's harness from the session list.
  tapHarnessEvent("c2", { type: "turn.started", providerTurnId: "p" });
  expect(written.at(-1)).toMatchObject({ kind: "turn.start", chatId: "c2", harness: "codex" });

  // A receiver batch goes through the feed.
  bridge.onEvents?.([{ id: "o", at: 1, chatId: "c1", harness: "claude", source: "otel", kind: "model.request", summary: "m", detail: {} }]);
  expect(written.at(-1)).toMatchObject({ kind: "model.request", chatId: "c1" });

  // The timer writes held calls.
  tapHarnessEvent("c1", { type: "tool.started", callId: "t", title: "ls", kind: "execute" });
  const before = written.length;
  await act(async () => vi.advanceTimersByTimeAsync(130_000));
  expect(written.length).toBe(before + 1);

  act(() => root.unmount());
  expect(bridge.stopped).toBe(1);
  expect(telemetryFeed.heldCount()).toBe(0);
});

it("events of other types are skipped by the tap", () => {
  tapHarnessEvent("c9", { type: "message.delta", text: "x" });
  tapHarnessEvent("c9", { type: "status", text: "x" });
  telemetryFeed.flushAll();
  expect(written).toHaveLength(0);
});
