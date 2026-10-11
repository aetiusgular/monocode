import { beforeEach, describe, expect, it, vi } from "vitest";

const runClaudePlugin = vi.hoisted(() => vi.fn());
vi.mock("./runClaudePlugin", () => ({ runClaudePlugin }));
const listDir = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/fs", () => ({ listDir }));

import { fakeClaudePlugin, pluginCalls } from "./__fixtures__/fakeClaudePlugin";
import {
  __resetPlugins,
  contentsSummary,
  listInstalledPlugins,
  readPluginContents,
  readPluginsState,
  refreshPlugins,
  setPluginEnabled,
} from "./plugins";
import { pluginRowKey } from "./pluginCli";

beforeEach(() => {
  runClaudePlugin.mockReset();
  listDir.mockReset();
  __resetPlugins();
});

describe("listing an account's plugins", () => {
  it("lists from the home folder, then asks each project for its own", async () => {
    fakeClaudePlugin(runClaudePlugin);
    const plugins = await listInstalledPlugins("account-2");
    expect(pluginCalls(runClaudePlugin)).toEqual([
      "plugin list --json",
      "plugin list --json @ /Users/me/Projects/resale-platform",
    ]);
    expect(runClaudePlugin.mock.calls[0][1]).toEqual({
      accountId: "account-2",
    });
    // On in its own project, though the home folder's list says off.
    expect(
      plugins.find((plugin) => plugin.id === "stripe@claude-plugins-official")
        ?.enabled,
    ).toBe(true);
  });

  it("keeps the first answer for a project that cannot be listed", async () => {
    const fake = fakeClaudePlugin(runClaudePlugin);
    const real = runClaudePlugin.getMockImplementation()!;
    runClaudePlugin.mockImplementation(
      async (args: string[], call: { cwd?: string }) => {
        if (call?.cwd) throw new Error("Project folder does not exist");
        return real(args, call);
      },
    );
    const plugins = await listInstalledPlugins(undefined);
    expect(plugins).toHaveLength(fake.plugins.length);
    expect(plugins.find((plugin) => plugin.scope === "local")?.enabled).toBe(
      false,
    );
  });
});

describe("switching from the Plugins page", () => {
  it("runs the change at the plugin's scope and in its project, then lists again", async () => {
    const fake = fakeClaudePlugin(runClaudePlugin);
    await refreshPlugins();
    const stripe = (await listInstalledPlugins(undefined)).find(
      (plugin) => plugin.scope === "local",
    )!;
    runClaudePlugin.mockClear();
    await setPluginEnabled(stripe, false);
    expect(pluginCalls(runClaudePlugin)[0]).toBe(
      "plugin disable --scope local --json stripe@claude-plugins-official @ /Users/me/Projects/resale-platform",
    );
    expect(fake.on.get("stripe@claude-plugins-official|local")).toBe(false);
    expect(pluginCalls(runClaudePlugin).slice(1)).toContain(
      "plugin list --json",
    );
  });

  it("keeps the CLI's refusal on the row and puts the switch back", async () => {
    fakeClaudePlugin(runClaudePlugin, { required: ["browser-use@synced"] });
    await refreshPlugins();
    const synced = readPluginsState(undefined).plugins!.find(
      (plugin) => plugin.scope === "synced",
    )!;
    await setPluginEnabled(synced, false);
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin disable --json browser-use@synced",
    );
    const state = readPluginsState(undefined);
    expect(state.rowErrors[pluginRowKey(synced)]).toMatch(
      /required by your organization/,
    );
    expect(state.pending).toEqual([]);
    expect(
      state.plugins!.find((plugin) => plugin.scope === "synced")?.enabled,
    ).toBe(true);
  });

  it("shows a list that cannot be read as the page's error", async () => {
    fakeClaudePlugin(runClaudePlugin, {
      fail: "Claude Code CLI not found.",
    });
    await refreshPlugins("account-2");
    expect(readPluginsState("account-2")).toMatchObject({
      loading: false,
      plugins: null,
      error: "Claude Code CLI not found.",
    });
    // Accounts are kept apart.
    expect(readPluginsState(undefined).error).toBeNull();
  });

  it("counts an already-done change as done", async () => {
    fakeClaudePlugin(runClaudePlugin);
    const obsidian = (await listInstalledPlugins(undefined)).find(
      (plugin) => plugin.id === "obsidian@obsidian-skills",
    )!;
    // Already on.
    await setPluginEnabled(obsidian, true);
    expect(pluginCalls(runClaudePlugin)).toContain(
      "plugin enable --scope user --json obsidian@obsidian-skills",
    );
    expect(pluginRowKey(obsidian)).toBe("obsidian@obsidian-skills|user|");
  });
});

describe("what a plugin brings", () => {
  it("counts skills, commands and agents in the default folders, and hooks", async () => {
    const tree: Record<string, { name: string; isDir: boolean }[]> = {
      "/p": [
        { name: "skills", isDir: true },
        { name: "commands", isDir: true },
        { name: "agents", isDir: true },
        { name: "hooks", isDir: true },
        { name: "README.md", isDir: false },
      ],
      "/p/skills": [
        { name: "one", isDir: true },
        { name: "two", isDir: true },
      ],
      "/p/commands": [
        { name: "deploy.md", isDir: false },
        { name: "notes.txt", isDir: false },
      ],
      "/p/agents": [],
    };
    listDir.mockImplementation(async (path: string) => {
      if (!tree[path]) throw new Error("missing");
      return tree[path];
    });
    const found = await readPluginContents("/p");
    expect(found).toEqual({ skills: 2, commands: 1, agents: 0, hooks: true });
    const plugin = (await listInstalledPluginsFrom()).find(
      (entry) => entry.id === "paper-desktop@paper",
    )!;
    expect(contentsSummary(plugin, found)).toBe(
      "MCP: paper · 2 skills · 1 command · hooks",
    );
    expect(await readPluginContents("/missing")).toBeNull();
    expect(await readPluginContents("")).toBeNull();
  });
});

async function listInstalledPluginsFrom() {
  fakeClaudePlugin(runClaudePlugin);
  return listInstalledPlugins(undefined);
}
