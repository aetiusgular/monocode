import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../features/settings/model/outboundCalls";
import { PiUsage } from "./PiUsage";

// Mac 5.9: Pi keeps its own figures in the component, so the footer must
// read the switch itself.

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  });
  resetOutboundCallsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

describe("Pi usage with the switch off", () => {
  it("shows usage off", () => {
    setOutboundCallAllowed("usage", false);
    const markup = renderToStaticMarkup(
      createElement(PiUsage, { model: "pi:anthropic/claude-sonnet-4", now: 0 }),
    );
    expect(markup).toContain("usage off");
  });
});
