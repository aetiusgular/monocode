import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_USE_KEY,
  chatSwitch,
  resetChatSwitchCache,
  sanitizeSwitches,
  setChatSwitch,
} from "./chatSwitch";

function fakeWindow(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const events: string[] = [];
  return {
    items,
    events,
    window: {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
      },
      dispatchEvent: (event: Event) => {
        events.push(event.type);
        return true;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
}

describe("computer use switch per chat", () => {
  beforeEach(() => resetChatSwitchCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetChatSwitchCache();
  });

  it("is off for a chat never switched, and for no chat", () => {
    vi.stubGlobal("window", fakeWindow().window);
    expect(chatSwitch("c1")).toEqual({ on: false });
    expect(chatSwitch(undefined)).toEqual({ on: false });
  });

  it("keeps a switch across a reload (corner case 14)", () => {
    const fake = fakeWindow();
    vi.stubGlobal("window", fake.window);
    setChatSwitch("c1", { on: true, withoutVision: true });
    expect(fake.events).toContain("monocode:computer-use-switch");
    resetChatSwitchCache();
    expect(chatSwitch("c1")).toEqual({ on: true, withoutVision: true });
    setChatSwitch("c1", { on: false });
    resetChatSwitchCache();
    expect(chatSwitch("c1")).toEqual({ on: false });
    expect(JSON.parse(fake.items.get(COMPUTER_USE_KEY)!)).toEqual({});
  });

  it("reads only well-formed entries", () => {
    expect(
      sanitizeSwitches({
        good: { on: true },
        vision: { on: true, withoutVision: true },
        off: { on: false },
        truthy: { on: "yes" },
        extra: { on: true, apps: ["com.apple.Terminal"] },
        "": { on: true },
        [`${"x".repeat(201)}`]: { on: true },
      }),
    ).toEqual({
      good: { on: true },
      vision: { on: true, withoutVision: true },
      extra: { on: true },
    });
    expect(sanitizeSwitches(null)).toEqual({});
    expect(sanitizeSwitches([{ on: true }])).toEqual({});
  });

  it("survives broken storage", () => {
    vi.stubGlobal("window", {
      ...fakeWindow().window,
      localStorage: {
        getItem: () => "{not json",
        setItem: () => {
          throw new Error("full");
        },
      },
    });
    expect(chatSwitch("c1")).toEqual({ on: false });
    expect(() => setChatSwitch("c1", { on: true })).not.toThrow();
    expect(chatSwitch("c1")).toEqual({ on: true });
  });

  it("works with no window at all", () => {
    expect(chatSwitch("c1")).toEqual({ on: false });
    expect(() => setChatSwitch("c1", { on: true })).not.toThrow();
  });
});
