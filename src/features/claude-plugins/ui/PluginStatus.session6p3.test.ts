// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runClaudePlugin = vi.hoisted(() => vi.fn());
vi.mock("../model/runClaudePlugin", () => ({ runClaudePlugin }));
const listDir = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../../../platform/tauri/fs", () => ({ listDir }));
vi.mock("../../settings/model/sounds", () => ({ playCue: () => false }));

import { fakeClaudePlugin } from "../model/__fixtures__/fakeClaudePlugin";
import { __resetPlugins } from "../model/plugins";
import { clearPluginStatus } from "../model/pluginStatus";
import { PluginsPage } from "./PluginsPage";

// Mac 4.12: after Uninstall the old "Successfully installed" line stayed,
// and Uninstall printed nothing of its own.

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  runClaudePlugin.mockReset();
  __resetPlugins();
  clearPluginStatus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

async function render() {
  await act(async () => {
    root.render(createElement(PluginsPage, { cwd: "/repo" }));
  });
  await settle();
}

function button(text: string, within: ParentNode = container) {
  return Array.from(within.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
}

const AVAILABLE = [
  { pluginId: "hello@testmk", name: "hello", marketplaceName: "testmk" },
];

/** Uninstall and marketplace remove answer with no message at all. */
function silentFor(verbs: string[]) {
  const fake = runClaudePlugin.getMockImplementation()!;
  runClaudePlugin.mockImplementation(async (args: string[], options) => {
    const reply = await fake(args, options);
    if (verbs.some((verb) => args.join(" ").includes(verb)))
      return { stdout: "", stderr: "", success: reply.success };
    return reply;
  });
}

const lines = () => container.textContent ?? "";

describe("the plugin page's status line", () => {
  it("shows the uninstall's own line, not the install's", async () => {
    fakeClaudePlugin(runClaudePlugin, { plugins: [], available: AVAILABLE });
    silentFor(["plugin uninstall"]);
    await render();
    await click(button("Browse marketplaces"));
    await click(button("Install"));
    expect(lines()).toContain("Successfully installed plugin: hello@testmk");

    const row = container.querySelector<HTMLElement>(
      '[data-plugin-row="hello@testmk"]',
    )!;
    await click(button("Uninstall", row));
    await click(
      button("Uninstall", row.querySelector('[role="alertdialog"]')!),
    );
    expect(lines()).not.toContain("Successfully installed");
    expect(lines()).toContain("Uninstalled hello.");
    expect(
      container.querySelector('[data-plugin-row="hello@testmk"]'),
    ).toBeNull();
  });

  it("shows a marketplace action's line in place of an earlier one", async () => {
    fakeClaudePlugin(runClaudePlugin, {
      plugins: [],
      available: AVAILABLE,
      marketplaces: [{ name: "testmk", source: "github", repo: "me/testmk" }],
    });
    silentFor(["marketplace remove"]);
    await render();
    await click(button("Browse marketplaces"));
    await click(button("Install"));
    expect(lines()).toContain("Successfully installed");
    const row = container.querySelector('[data-marketplace="testmk"]')!;
    await click(button("Remove", row));
    await click(button("Remove and uninstall", row));
    expect(lines()).not.toContain("Successfully installed");
    expect(lines()).toContain("Removed marketplace testmk.");
  });

  it("shows an update's line in place of the install's", async () => {
    fakeClaudePlugin(runClaudePlugin, { plugins: [], available: AVAILABLE });
    await render();
    await click(button("Browse marketplaces"));
    await click(button("Install"));
    const row = container.querySelector<HTMLElement>(
      '[data-plugin-row="hello@testmk"]',
    )!;
    await click(button("Update", row));
    expect(lines()).not.toContain("Successfully installed");
    expect(lines()).toContain("Successfully updated plugin: hello@testmk");
  });
});
