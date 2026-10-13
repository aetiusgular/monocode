import { beforeEach, describe, expect, it, vi } from "vitest";

// Mac 11.2: after the Notion sign-in through Docker finished, MonoCode did
// not come to the front by itself.

const calls = vi.hoisted(() => ({
  order: [] as string[],
  focused: true,
  tauri: true,
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => calls.tauri }));
vi.mock("@tauri-apps/api/window", () => ({
  UserAttentionType: { Critical: 1, Informational: 2 },
  getCurrentWindow: () => ({
    unminimize: async () => void calls.order.push("unminimize"),
    show: async () => void calls.order.push("show"),
    setFocus: async () => void calls.order.push("setFocus"),
    isFocused: async () => calls.focused,
    requestUserAttention: async (type: number) =>
      void calls.order.push(`attention:${type}`),
  }),
}));

const { bringAppToFront } = await import("./appWindow");

beforeEach(() => {
  calls.order = [];
  calls.focused = true;
  calls.tauri = true;
});

describe("bringAppToFront", () => {
  it("unminimizes, shows and then focuses the window", async () => {
    await bringAppToFront();
    expect(calls.order).toEqual(["unminimize", "show", "setFocus"]);
  });

  it("asks for attention once when macOS keeps focus elsewhere", async () => {
    calls.focused = false;
    await bringAppToFront();
    expect(calls.order).toEqual([
      "unminimize",
      "show",
      "setFocus",
      "attention:2",
    ]);
  });

  it("does nothing outside the app", async () => {
    calls.tauri = false;
    await bringAppToFront();
    expect(calls.order).toEqual([]);
  });
});
