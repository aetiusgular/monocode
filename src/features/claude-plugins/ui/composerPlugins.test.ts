// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runClaudePlugin = vi.hoisted(() => vi.fn());
vi.mock("../model/runClaudePlugin", () => ({ runClaudePlugin }));
const listSkills = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: unknown) =>
      command === "list_skills"
        ? listSkills(args)
        : original.invoke(command, args),
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({ branches: undefined, settled: true }),
}));
vi.mock("../../settings/model/sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settings/model/sounds")>()),
  playCue: () => false,
}));

import type { HarnessId } from "../../sessions/model/session";
import { Composer } from "../../sessions/ui/Composer";
import {
  fakeClaudePlugin,
  pluginCalls,
  PLUGIN_LIST_FIXTURE,
} from "../model/__fixtures__/fakeClaudePlugin";
import { __resetChatPluginLists } from "../model/chatPluginList";
import { OPEN_PLUGINS_SETTINGS_EVENT } from "../model/chatPlugins";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  listSkills.mockReset();
  listSkills.mockResolvedValue([]);
  runClaudePlugin.mockReset();
  __resetChatPluginLists();
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

type Options = {
  harness?: HarnessId;
  remoteSession?: boolean;
  busy?: boolean;
  compact?: boolean;
  cwd?: string;
  providerAccountId?: string;
  disabledPlugins?: string[];
  onDisabledPluginsChange?: (ids: string[]) => void;
};

async function renderComposer(options: Options) {
  const cwd = options.cwd ?? "/Users/me/Projects/resale-platform";
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: true,
        harness: options.harness ?? "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        cwd,
        executionCwd: cwd,
        sessionId: "s1",
        hideProjectPicker: true,
        hideBranchPicker: true,
        remoteSession: options.remoteSession,
        busy: options.busy,
        compact: options.compact,
        providerAccountId: options.providerAccountId,
        disabledPlugins: options.disabledPlugins,
        onDisabledPluginsChange: options.onDisabledPluginsChange,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: () => {},
      }),
    ),
  );
  await act(async () => {});
}

async function plusMenuEntry() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Add files or choose a mode"]',
      )!
      .click(),
  );
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-composer-plus] button"),
  ).find((button) => button.textContent?.includes("Plugins"));
}

const popover = () =>
  document.querySelector<HTMLElement>('[role="dialog"][aria-label="Plugins"]');

async function openPlugins() {
  const entry = await plusMenuEntry();
  await act(async () => entry!.click());
  for (let i = 0; i < 4; i++) await act(async () => {});
  return popover()!;
}

function rows(surface: HTMLElement) {
  return Array.from(surface.querySelectorAll("li")).map((row) => {
    const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
    return {
      id: row.getAttribute("data-chat-plugin"),
      on: toggle.getAttribute("aria-checked") === "true",
    };
  });
}

describe("Plugins in the composer plus menu", () => {
  it("is offered for Claude Code chats only", async () => {
    fakeClaudePlugin(runClaudePlugin);
    await renderComposer({ onDisabledPluginsChange: vi.fn() });
    expect((await plusMenuEntry())?.textContent).toContain(
      "Turn Claude Code plugins off for this chat",
    );
    for (const harness of ["codex", "cursor", "opencode", "pi"] as const) {
      await renderComposer({ harness, onDisabledPluginsChange: vi.fn() });
      expect(await plusMenuEntry()).toBeUndefined();
    }
  });

  it("is not offered for a host session or without a change handler", async () => {
    await renderComposer({
      remoteSession: true,
      onDisabledPluginsChange: vi.fn(),
    });
    expect(await plusMenuEntry()).toBeUndefined();
    await renderComposer({});
    expect(await plusMenuEntry()).toBeUndefined();
  });

  it("shows how many plugins are off on the menu entry", async () => {
    await renderComposer({
      disabledPlugins: ["paper-desktop@paper", "obsidian@obsidian-skills"],
      onDisabledPluginsChange: vi.fn(),
    });
    expect((await plusMenuEntry())?.textContent).toContain("2 off");
  });
});

describe("Plugins popover", () => {
  it("lists the plugins that load in the chat's folder, as the chat's account", async () => {
    fakeClaudePlugin(runClaudePlugin);
    await renderComposer({
      providerAccountId: "account-work",
      disabledPlugins: ["paper-desktop@paper"],
      onDisabledPluginsChange: vi.fn(),
    });
    const surface = await openPlugins();
    expect(pluginCalls(runClaudePlugin)).toEqual([
      "plugin list --json @ /Users/me/Projects/resale-platform",
    ]);
    expect(runClaudePlugin.mock.calls[0][1]).toMatchObject({
      accountId: "account-work",
    });
    expect(rows(surface)).toEqual([
      { id: "browser-use@synced", on: true },
      { id: "obsidian@obsidian-skills", on: true },
      { id: "paper-desktop@paper", on: false },
      { id: "stripe@claude-plugins-official", on: true },
    ]);
    expect(surface.textContent).toContain("Off for this chat only.");
  });

  it("leaves out a plugin that is off in the folder's settings", async () => {
    fakeClaudePlugin(runClaudePlugin);
    await renderComposer({
      cwd: "/Users/me/other",
      onDisabledPluginsChange: vi.fn(),
    });
    const ids = rows(await openPlugins()).map((row) => row.id);
    expect(ids).not.toContain("stripe@claude-plugins-official");
  });

  it("switches a plugin off and back on for this chat without running the CLI", async () => {
    fakeClaudePlugin(runClaudePlugin);
    const onChange = vi.fn();
    await renderComposer({ onDisabledPluginsChange: onChange });
    const surface = await openPlugins();
    runClaudePlugin.mockClear();
    await act(async () =>
      surface
        .querySelector<HTMLButtonElement>(
          '[role="switch"][aria-label="obsidian"]',
        )!
        .click(),
    );
    expect(onChange).toHaveBeenLastCalledWith(["obsidian@obsidian-skills"]);
    expect(runClaudePlugin).not.toHaveBeenCalled();

    await renderComposer({
      disabledPlugins: ["obsidian@obsidian-skills"],
      onDisabledPluginsChange: onChange,
    });
    await act(async () =>
      popover()!
        .querySelector<HTMLButtonElement>(
          '[role="switch"][aria-label="obsidian"]',
        )!
        .click(),
    );
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps a switched-off plugin that no longer loads, to switch back on", async () => {
    fakeClaudePlugin(runClaudePlugin, { plugins: [PLUGIN_LIST_FIXTURE[0]] });
    await renderComposer({
      disabledPlugins: ["gone@market"],
      onDisabledPluginsChange: vi.fn(),
    });
    const surface = await openPlugins();
    expect(rows(surface)).toEqual([
      { id: "obsidian@obsidian-skills", on: true },
      { id: "gone@market", on: false },
    ]);
    expect(surface.textContent).toContain("Not loading here any more");
  });

  it("says Claude Code follows from the next turn when changed mid-turn", async () => {
    fakeClaudePlugin(runClaudePlugin);
    const note = "Claude Code follows from the next turn.";
    await renderComposer({ busy: true, onDisabledPluginsChange: vi.fn() });
    expect((await openPlugins()).textContent).not.toContain(note);
    await renderComposer({
      busy: true,
      disabledPlugins: ["paper-desktop@paper"],
      onDisabledPluginsChange: vi.fn(),
    });
    expect(popover()!.textContent).toContain(note);
  });

  it("shows a list that cannot be read", async () => {
    fakeClaudePlugin(runClaudePlugin, { fail: "Claude Code CLI not found." });
    await renderComposer({ onDisabledPluginsChange: vi.fn() });
    const surface = await openPlugins();
    expect(surface.querySelector('[role="alert"]')?.textContent).toContain(
      "Claude Code CLI not found.",
    );
  });

  it("opens Settings on the Plugins page from Manage plugins", async () => {
    fakeClaudePlugin(runClaudePlugin);
    const opened = vi.fn();
    window.addEventListener(OPEN_PLUGINS_SETTINGS_EVENT, opened);
    await renderComposer({ onDisabledPluginsChange: vi.fn() });
    const surface = await openPlugins();
    const manage = Array.from(surface.querySelectorAll("button")).find(
      (button) => button.textContent === "Manage plugins",
    )!;
    await act(async () => manage.click());
    expect(opened).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
    window.removeEventListener(OPEN_PLUGINS_SETTINGS_EVENT, opened);
  });

  it("closes on Escape and on a click outside", async () => {
    fakeClaudePlugin(runClaudePlugin);
    await renderComposer({ onDisabledPluginsChange: vi.fn() });
    await openPlugins();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(popover()).toBeNull();
    await openPlugins();
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(popover()).toBeNull();
  });
});

describe("switched-off plugins in a compact composer", () => {
  it("adds the count to the summary", async () => {
    await renderComposer({
      compact: true,
      disabledPlugins: ["paper-desktop@paper"],
      onDisabledPluginsChange: vi.fn(),
    });
    const summary = container.querySelector<HTMLElement>(
      "[data-session-tools-summary]",
    );
    expect(summary?.textContent).toBe("1 plugin off");
    expect(summary?.title).toBe("Plugins off: paper-desktop@paper");
  });
});
