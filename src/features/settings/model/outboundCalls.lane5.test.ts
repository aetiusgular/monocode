// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OUTBOUND_CALLS,
  OUTBOUND_CALLS_CHANGE_EVENT,
  OUTBOUND_CALLS_KEY,
  defaultOutboundCalls,
  loadOutboundCalls,
  outboundCallAllowed,
  resetOutboundCallsCache,
  sanitizeOutboundCalls,
  setOutboundCallAllowed,
  subscribeOutboundCalls,
  type OutboundCallId,
} from "./outboundCalls";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  resetOutboundCallsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOutboundCallsCache();
});

describe("outbound call switches", () => {
  it("lists the five calls with hosts and a description", () => {
    expect(OUTBOUND_CALLS.map((call) => call.id)).toEqual([
      "link-previews",
      "usage",
      "version-check",
      "star-check",
      // Mac finding 5.9.
      "github-lookups",
    ]);
    for (const call of OUTBOUND_CALLS) {
      expect(call.label).toBeTruthy();
      expect(call.hosts.length).toBeGreaterThan(0);
      expect(call.description).toBeTruthy();
      expect(call.description).not.toContain("—");
    }
    const usage = OUTBOUND_CALLS.find((call) => call.id === "usage")!;
    expect(usage.hosts).toEqual(
      expect.arrayContaining([
        "api.anthropic.com",
        "opencode.ai",
        "chatgpt.com",
        "server.codeium.com",
      ]),
    );
    expect(
      OUTBOUND_CALLS.find((call) => call.id === "version-check")!.hosts,
    ).toContain("registry.npmjs.org");
  });

  it("defaults every switch on", () => {
    for (const call of OUTBOUND_CALLS) {
      expect(outboundCallAllowed(call.id)).toBe(true);
    }
    expect(loadOutboundCalls()).toEqual(defaultOutboundCalls());
  });

  it("stores a switch and reads it back after a reload", () => {
    setOutboundCallAllowed("usage", false);
    expect(outboundCallAllowed("usage")).toBe(false);
    expect(JSON.parse(storage.data.get(OUTBOUND_CALLS_KEY)!)).toMatchObject({
      usage: false,
    });
    resetOutboundCallsCache();
    expect(outboundCallAllowed("usage")).toBe(false);
    expect(outboundCallAllowed("link-previews")).toBe(true);
    setOutboundCallAllowed("usage", true);
    resetOutboundCallsCache();
    expect(outboundCallAllowed("usage")).toBe(true);
  });

  it("falls back to defaults for stored garbage", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      "42",
      '"off"',
      JSON.stringify({ usage: "false", "star-check": 0, extra: false }),
      JSON.stringify({ __proto__: { usage: false } }),
    ]) {
      storage.data.set(OUTBOUND_CALLS_KEY, raw);
      resetOutboundCallsCache();
      expect(loadOutboundCalls(), raw).toEqual(defaultOutboundCalls());
    }
    storage.data.set(
      OUTBOUND_CALLS_KEY,
      JSON.stringify({ "star-check": false, bogus: true }),
    );
    resetOutboundCallsCache();
    expect(loadOutboundCalls()).toEqual({
      ...defaultOutboundCalls(),
      "star-check": false,
    });
    expect(Object.keys(loadOutboundCalls())).not.toContain("bogus");
  });

  it("sanitizes without trusting the input shape", () => {
    expect(sanitizeOutboundCalls(undefined)).toEqual(defaultOutboundCalls());
    expect(sanitizeOutboundCalls([false])).toEqual(defaultOutboundCalls());
  });

  it("falls back to defaults when storage throws, and still switches in memory", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    resetOutboundCallsCache();
    expect(loadOutboundCalls()).toEqual(defaultOutboundCalls());
    expect(() => setOutboundCallAllowed("link-previews", false)).not.toThrow();
    expect(outboundCallAllowed("link-previews")).toBe(false);
  });

  it("refuses an unknown id and ignores a non-boolean value", () => {
    expect(outboundCallAllowed("telemetry" as OutboundCallId)).toBe(false);
    setOutboundCallAllowed("usage", "no" as unknown as boolean);
    expect(outboundCallAllowed("usage")).toBe(true);
  });

  it("tells subscribers about a change here and in another window", () => {
    const onChange = vi.fn();
    const stop = subscribeOutboundCalls(onChange);
    setOutboundCallAllowed("star-check", false);
    expect(onChange).toHaveBeenCalledTimes(1);

    storage.data.set(
      OUTBOUND_CALLS_KEY,
      JSON.stringify({ "star-check": true }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: OUTBOUND_CALLS_KEY }),
    );
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(outboundCallAllowed("star-check")).toBe(true);

    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new CustomEvent(OUTBOUND_CALLS_CHANGE_EVENT));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
