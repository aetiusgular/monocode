// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runClaudePlugin = vi.hoisted(() => vi.fn());
vi.mock("../model/runClaudePlugin", () => ({ runClaudePlugin }));
const listDir = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/fs", () => ({ listDir }));
vi.mock("../../settings/model/sounds", () => ({ playCue: () => false }));

import {
  fakeClaudePlugin,
  pluginCalls,
  PLUGIN_LIST_FIXTURE,
} from "../model/__fixtures__/fakeClaudePlugin";
import { __resetPlugins } from "../model/plugins";
import { PluginsPage } from "./PluginsPage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  runClaudePlugin.mockReset();
  listDir.mockReset();
  listDir.mockImplementation(async (path: string) => {
    if (path.endsWith("obsidian/1.0.1")) {
      return [{ name: "skills", isDir: true, path: "", ignored: false }];
    }
    if (path.endsWith("obsidian/1.0.1/skills")) {
      return [
        { name: "bases", isDir: true, path: "", ignored: false },
        { name: "canvas", isDir: true, path: "", ignored: false },
      ];
    }
    return [];
  });
  __resetPlugins();
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
  for (let i = 0; i < 8; i++) {
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

const row = (id: string, scope?: string) =>
  container.querySelector<HTMLElement>(
    `[data-plugin-row="${id}"]${scope ? `[data-plugin-scope="${scope}"]` : ""}`,
  )!;
const toggle = (id: string) =>
  row(id).querySelector<HTMLButtonElement>('[role="switch"]');

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
  await settle();
}

describe("Plugins page", () => {
  it("lists every installed plugin with its marketplace, version, scope and contents", async () => {
    fakeClaudePlugin(runClaudePlugin);
    await render();
    const ids = Array.from(container.querySelectorAll("[data-plugin-row]")).map(
      (entry) => entry.getAttribute("data-plugin-row"),
    );
    expect(ids).toEqual([
      "obsidian@obsidian-skills",
      "paper-desktop@paper",
      "browser-use@synced",
      "stripe@claude-plugins-official",
    ]);
    const obsidian = row("obsidian@obsidian-skills").textContent;
    expect(obsidian).toContain("obsidian");
    expect(obsidian).toContain("1.0.1");
    expect(obsidian).toContain("obsidian-skills");
    expect(obsidian).toContain("User");
    expect(obsidian).toContain("2 skills");
    expect(row("paper-desktop@paper").textContent).toContain("MCP: paper");
    expect(row("browser-use@synced").textContent).toContain("claude.ai");
  });

  it("says which project a local plugin belongs to, with its state there", async () => {
    fakeClaudePlugin(runClaudePlugin);
    await render();
    const stripe = row("stripe@claude-plugins-official");
    expect(stripe.textContent).toContain("Local");
    expect(stripe.textContent).toContain("Only in resale-platform");
    expect(stripe.getAttribute("data-plugin-state")).toBe("on");
  });

  it("switches a plugin with its own scope and shows the change", async () => {
    const fake = fakeClaudePlugin(runClaudePlugin);
    await render();
    runClaudePlugin.mockClear();
    await click(toggle("obsidian@obsidian-skills"));
    expect(pluginCalls(runClaudePlugin)[0]).toBe(
      "plugin disable --scope user --json obsidian@obsidian-skills",
    );
    expect(fake.on.get("obsidian@obsidian-skills|user")).toBe(false);
    expect(
      row("obsidian@obsidian-skills").getAttribute("data-plugin-state"),
    ).toBe("off");

    runClaudePlugin.mockClear();
    await click(toggle("stripe@claude-plugins-official"));
    expect(pluginCalls(runClaudePlugin)[0]).toBe(
      "plugin disable --scope local --json stripe@claude-plugins-official @ /Users/me/Projects/resale-platform",
    );
  });

  it("switches a synced plugin and shows a refusal from the CLI on its row", async () => {
    fakeClaudePlugin(runClaudePlugin, { required: ["browser-use@synced"] });
    await render();
    await click(toggle("browser-use@synced"));
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin disable --json browser-use@synced",
    );
    const synced = row("browser-use@synced");
    expect(synced.querySelector('[role="alert"]')?.textContent).toMatch(
      /required by your organization/,
    );
    expect(synced.getAttribute("data-plugin-state")).toBe("on");
  });

  it("shows managed plugins without a switch, and why", async () => {
    fakeClaudePlugin(runClaudePlugin, {
      plugins: [
        {
          ...PLUGIN_LIST_FIXTURE[0],
          id: "policy@corp",
          scope: "managed",
        },
      ],
    });
    await render();
    expect(toggle("policy@corp")).toBeNull();
    expect(row("policy@corp").textContent).toContain(
      "Set by your organization's managed settings.",
    );
  });

  it("refreshes, and shows a list that cannot be read", async () => {
    const fake = fakeClaudePlugin(runClaudePlugin);
    await render();
    fake.fail = "Claude Code CLI not found.";
    await click(container.querySelector('[aria-label="Refresh plugins"]'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Claude Code CLI not found.",
    );
    fake.fail = undefined;
    await click(container.querySelector('[aria-label="Refresh plugins"]'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("says when nothing is installed", async () => {
    fakeClaudePlugin(runClaudePlugin, { plugins: [] });
    await render();
    expect(container.textContent).toContain("No plugins installed.");
  });

  it("asks as the chosen Claude Code account when there is more than one", async () => {
    localStorage.setItem(
      "monocode.providerAccounts.v1",
      JSON.stringify({
        claude: [{ id: "account-work", provider: "claude", label: "Work" }],
      }),
    );
    fakeClaudePlugin(runClaudePlugin);
    await render();
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Claude Code account"]',
    )!;
    expect(select).not.toBeNull();
    runClaudePlugin.mockClear();
    await act(async () => {
      select.value = "account-work";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(runClaudePlugin.mock.calls[0][1]).toMatchObject({
      accountId: "account-work",
    });
  });
});
