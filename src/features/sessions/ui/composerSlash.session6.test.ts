// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: async (command: string, args?: unknown) =>
      command === "mcp_discover" || command === "claude_mcp_list"
        ? []
        : original.invoke(command, args),
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({
    branches: { current: "main", detached: false, branches: [] },
    settled: true,
  }),
}));

import { Composer } from "./Composer";
import {
  composerSlashToken,
  returnTakesSlashPick,
} from "../model/composerSlash";
import type { Skill } from "../../skills/model/skills";

const ITEMS: Skill[] = [
  {
    kind: "builtin",
    name: "plan",
    invocation: "plan",
    description: "Plan first.",
    scope: "builtin",
    source: "monocode",
  },
  {
    kind: "builtin",
    name: "mcp",
    invocation: "mcp",
    description: "Find an MCP server.",
    scope: "builtin",
    source: "monocode",
  },
];

describe("Mac finding 2.x: the / menu rule", () => {
  it("opens at the start of the prompt and lets Return pick", () => {
    const token = composerSlashToken("/pl", 3, false, ITEMS);
    expect(token).toMatchObject({ start: 0, query: "pl", leading: true });
    expect(returnTakesSlashPick(token)).toBe(true);
    expect(composerSlashToken("  /pl", 5, false, ITEMS)?.leading).toBe(true);
  });

  it.each([
    ["ls /nope", 7],
    ["ls /nope", 8],
    ["see a/b", 7],
    ["path ~/x/", 9],
    ["path ~/x/", 7],
    ["please / now", 8],
  ])("does not open for %j at %d", (text, cursor) => {
    expect(composerSlashToken(text, cursor, false, ITEMS)).toBeNull();
  });

  it("opens mid-text only for a listed name, and Return never picks there", () => {
    const token = composerSlashToken("sad /mc", 7, false, ITEMS);
    expect(token).toMatchObject({ query: "mc", leading: false });
    expect(returnTakesSlashPick(token)).toBe(false);
  });
});

describe("Mac finding 2.x: the composer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderComposer(onSubmit: (text: string) => void) {
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          focusToken: 0,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: () => {},
          onCwdChange: () => {},
          onModelChange: () => {},
          onRuntimeModeChange: () => {},
          onSubmit,
        }),
      ),
    );
    return container.querySelector("textarea")!;
  }

  async function typeInto(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function press(textarea: HTMLTextAreaElement, shiftKey = false) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => textarea.dispatchEvent(event));
    return event;
  }

  const menu = () => container.querySelector("[data-skill-picker]");

  it("opens the menu for /pl at the start", async () => {
    const textarea = await renderComposer(vi.fn());
    await typeInto(textarea, "/pl");
    expect(menu()).not.toBeNull();
    expect(menu()?.textContent).toContain("/plan");
  });

  it.each(["ls /nope", "see a/b", "path ~/x/"])(
    "keeps the menu shut for %j and Return sends the text as typed",
    async (text) => {
      const onSubmit = vi.fn();
      const textarea = await renderComposer(onSubmit);
      await typeInto(textarea, text);
      expect(menu()).toBeNull();
      await press(textarea);
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]![0]).toBe(text);
    },
  );

  it("leaves Shift+Return to add a line after a mid-text /", async () => {
    const onSubmit = vi.fn();
    const textarea = await renderComposer(onSubmit);
    await typeInto(textarea, "ls /nope");
    const event = await press(textarea, true);
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("ls /nope");
  });

  it("sends on Return when a mid-text / matches a command, without picking it", async () => {
    const onSubmit = vi.fn();
    const textarea = await renderComposer(onSubmit);
    await typeInto(textarea, "fix the /pl");
    expect(menu()).not.toBeNull();
    await press(textarea);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toBe("fix the /pl");
  });
});
