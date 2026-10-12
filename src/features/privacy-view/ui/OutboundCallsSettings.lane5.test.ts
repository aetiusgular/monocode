// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const loadRateLimits = vi.hoisted(() => vi.fn(async () => undefined));
const all = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../../providers/model/rateLimitsCache", () => ({
  loadRateLimits,
  getAllRateLimits: () => all.value,
}));

import { OutboundCallsSettings } from "./OutboundCallsSettings";
import {
  OUTBOUND_CALL_OFF_MESSAGE,
  OUTBOUND_CALLS,
  outboundCallAllowed,
  resetOutboundCallsCache,
} from "../../settings/model/outboundCalls";

const Group = ({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) =>
  createElement("section", null, createElement("h2", null, title), children);
const Row = ({
  id,
  label,
  description,
  children,
}: {
  id?: string;
  label: ReactNode;
  description?: string;
  children?: ReactNode;
}) =>
  createElement(
    "div",
    { "data-setting-id": id },
    createElement("b", null, label),
    createElement("p", null, description),
    children,
  );
const Toggle = ({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) =>
  createElement("button", {
    role: "switch",
    "aria-label": label,
    "aria-checked": on,
    onClick: () => onChange(!on),
  });
const parts = { Group, Row, Toggle };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
  resetOutboundCallsCache();
  loadRateLimits.mockClear();
  all.value = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

it("renders every call with its label, hosts and an on switch", () => {
  const html = renderToStaticMarkup(
    createElement(OutboundCallsSettings, parts),
  );
  expect(html).toContain("Outbound calls");
  for (const call of OUTBOUND_CALLS) {
    expect(html).toContain(call.label);
    for (const host of call.hosts) expect(html).toContain(host);
    expect(html).toContain(`data-setting-id="outbound-${call.id}"`);
  }
  expect(html.match(/aria-checked="true"/g)).toHaveLength(
    OUTBOUND_CALLS.length,
  );
  expect(html).not.toContain("—");
});

it("a switch turns its call off and on, and usage on reloads blocked meters", async () => {
  all.value = {
    "claude:default": {
      status: "unavailable",
      error: OUTBOUND_CALL_OFF_MESSAGE,
    },
    "codex:work": { status: "ok", error: null },
    "devin:default": { status: "unavailable", error: "Devin not signed in" },
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(OutboundCallsSettings, parts)),
  );
  const usage = container.querySelector<HTMLButtonElement>(
    '[aria-label="Usage figures"]',
  )!;
  await act(async () => usage.click());
  expect(outboundCallAllowed("usage")).toBe(false);
  expect(usage.getAttribute("aria-checked")).toBe("false");
  expect(loadRateLimits).not.toHaveBeenCalled();

  await act(async () => usage.click());
  expect(outboundCallAllowed("usage")).toBe(true);
  expect(loadRateLimits).toHaveBeenCalledTimes(1);
  expect(loadRateLimits).toHaveBeenCalledWith("claude", "default", true);
  act(() => root.unmount());
});
