import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  OUTBOUND_CALL_OFF_MESSAGE,
  resetOutboundCallsCache,
  setOutboundCallAllowed,
} from "../../settings/model/outboundCalls";
import { fetchLinkPreviewMetadata } from "./linkPreview";

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
  resetOutboundCallsCache();
  invoke.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

it("off: no fetch_link_preview call; on again: fetches normally", async () => {
  setOutboundCallAllowed("link-previews", false);
  await expect(
    fetchLinkPreviewMetadata("https://example.com/off"),
  ).rejects.toThrow(OUTBOUND_CALL_OFF_MESSAGE);
  expect(invoke).not.toHaveBeenCalled();

  setOutboundCallAllowed("link-previews", true);
  invoke.mockResolvedValue({ title: "Example", faviconDataUrl: null });
  await expect(
    fetchLinkPreviewMetadata("https://example.com/off"),
  ).resolves.toEqual({ title: "Example", faviconDataUrl: null });
  expect(invoke).toHaveBeenCalledWith("fetch_link_preview", {
    url: "https://example.com/off",
  });
});
