// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyAutomationsChanged } from "../model/automations";
import { AutomationsView } from "./AutomationsView";

// Mac 2.16 retest: the refusal banner ("This repository has no commits
// yet…") stayed on the page after Cancel.

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

const REFUSAL =
  "This repository has no commits yet, so a fresh worktree cannot be made from it.";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  notifyAutomationsChanged();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "automations_upsert") throw new Error(REFUSAL);
    if (command === "automations_list") return [];
    return null;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(cwd: string) {
  await act(async () =>
    root.render(
      createElement(AutomationsView, {
        cwd,
        recents: [],
        onClose: vi.fn(),
        onLaunch: vi.fn(),
        onOpenSession: vi.fn(),
      }),
    ),
  );
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().startsWith(text),
  );
  if (!found) throw new Error(`No button ${text}`);
  return found as HTMLButtonElement;
}

async function refuseASave() {
  await render("/Users/tony/no-commits");
  await act(async () => button("Start from scratch").click());
  const form = container.querySelector("form");
  if (!form) throw new Error("No form");
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(container.textContent).toContain(REFUSAL);
}

describe("the refusal banner", () => {
  it("goes away on Cancel", async () => {
    await refuseASave();
    await act(async () => button("Cancel").click());
    expect(container.textContent).not.toContain(REFUSAL);
  });

  it("goes away when the project changes", async () => {
    await refuseASave();
    await render("/Users/tony/other");
    expect(container.textContent).not.toContain(REFUSAL);
  });

  it("goes away when New automation opens the picker", async () => {
    await refuseASave();
    await act(async () =>
      (
        container.querySelector(
          '[aria-label="New automation"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(container.textContent).not.toContain(REFUSAL);
  });
});
