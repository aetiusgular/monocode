import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Mac 4.14: View, Reload in one window reloaded every window. Rust sent it to
// the focused window, but the page listened for it from any target.

const listened = vi.hoisted(() => ({
  global: [] as string[],
  window: [] as string[],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string) => {
    listened.global.push(event);
    return () => undefined;
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "moved-2",
    listen: vi.fn(async (event: string) => {
      listened.window.push(event);
      return () => undefined;
    }),
  }),
}));

import { listenMenu, WINDOW_MENU_EVENTS } from "./menuEvents";

describe("menu events for one window", () => {
  it("listens for Reload in this window only", async () => {
    await listenMenu("reload", () => undefined);
    expect(listened.window).toContain("reload");
    expect(listened.global).not.toContain("reload");
  });

  it("keeps app-wide items on the global listener", async () => {
    await listenMenu("open_settings", () => undefined);
    expect(listened.global).toContain("open_settings");
    expect(listened.window).not.toContain("open_settings");
  });

  it("covers every item menu.rs sends to the focused window", () => {
    const menu = readFileSync(
      new URL("../../../src-tauri/src/menu.rs", import.meta.url),
      "utf8",
    );
    const arm = /((?:\|?\s*"[a-z_]+"\s*)+)=>\s*emit_to_focused\(app, id\)/.exec(
      menu,
    );
    expect(arm).not.toBeNull();
    const ids = [...arm![1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(ids).toContain("reload");
    expect([...WINDOW_MENU_EVENTS].sort()).toEqual([...ids].sort());
  });
});
