// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));

import {
  TELEMETRY_GROUP_DESCRIPTION,
  TelemetrySettings,
  telemetryStatusLine,
} from "./TelemetrySettings";
import {
  __resetHarnessTelemetryCache,
  loadHarnessTelemetry,
} from "../model/telemetrySettings";

const Group = ({ title, description, children }: { title: ReactNode; description?: string; children: ReactNode }) =>
  createElement("section", null, createElement("h2", null, title), createElement("p", null, description), children);
const Row = ({ id, label, description, children }: { id?: string; label: ReactNode; description?: string; children?: ReactNode }) =>
  createElement("div", { "data-setting-id": id }, createElement("span", null, label), createElement("small", null, description), children);
const Toggle = ({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) =>
  createElement("button", { "aria-label": label, "aria-pressed": on, onClick: () => onChange(!on) });

beforeEach(() => {
  localStorage.clear();
  __resetHarnessTelemetryCache();
});

it("renders the two switches and the receiver line", () => {
  const html = renderToStaticMarkup(createElement(TelemetrySettings, { Group, Row, Toggle }));
  expect(html).toContain("Harness telemetry");
  expect(html).toContain("Record harness telemetry");
  expect(html).toContain("Include prompt text");
  expect(html).toContain('data-setting-id="telemetry-enabled"');
  expect(html).toContain('data-setting-id="telemetry-prompts"');
  expect(html).toContain("Nothing is sent anywhere else");
  expect(TELEMETRY_GROUP_DESCRIPTION).toContain("this Mac");
});

it("the switches change the stored settings", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(TelemetrySettings, { Group, Row, Toggle })));
  const prompts = host.querySelector('[aria-label="Include prompt text"]') as HTMLButtonElement;
  expect(prompts.getAttribute("aria-pressed")).toBe("false");
  act(() => prompts.click());
  expect(loadHarnessTelemetry().logPrompts).toBe(true);
  const record = host.querySelector('[aria-label="Record harness telemetry"]') as HTMLButtonElement;
  act(() => record.click());
  expect(loadHarnessTelemetry().enabled).toBe(false);
  // Off: the prompt switch shows off whatever is stored.
  expect((host.querySelector('[aria-label="Include prompt text"]') as HTMLElement).getAttribute("aria-pressed")).toBe("false");
  act(() => root.unmount());
});

it("status line", () => {
  expect(telemetryStatusLine(null)).toBe("Not available in this build.");
  expect(telemetryStatusLine({ listening: false, requests: 0, events: 0, refusedToken: 0, refusedOther: 0, droppedRecords: 0 })).toContain("Not started yet");
  expect(telemetryStatusLine({ listening: true, requests: 3, events: 12, refusedToken: 1, refusedOther: 1, droppedRecords: 0 })).toBe("Receiving: 12 events from 3 requests, 2 refused.");
});
