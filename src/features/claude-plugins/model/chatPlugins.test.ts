import { describe, expect, it } from "vitest";
import { PLUGIN_LIST_FIXTURE } from "./__fixtures__/fakeClaudePlugin";
import {
  chatDisabledPlugins,
  chatPluginRows,
  claudePluginOverrides,
  harnessDisabledPlugins,
  harnessSupportsPluginSwitches,
  MAX_DISABLED_PLUGINS,
  sanitizeDisabledPlugins,
  setPluginOnForChat,
} from "./chatPlugins";
import { parsePluginList } from "./pluginCli";

describe("per-chat plugin switches", () => {
  it("are Claude Code only", () => {
    expect(harnessSupportsPluginSwitches("claude")).toBe(true);
    expect(harnessSupportsPluginSwitches("codex")).toBe(false);
    expect(chatDisabledPlugins("codex", ["a@b"])).toEqual([]);
    expect(harnessDisabledPlugins("codex", ["a@b"])).toBeUndefined();
    expect(harnessDisabledPlugins("claude", ["z@b", "a@b"])).toEqual([
      "a@b",
      "z@b",
    ]);
    expect(harnessDisabledPlugins("claude", [])).toBeUndefined();
  });

  it("keep only valid, unique ids from a saved session, within a bound", () => {
    expect(
      sanitizeDisabledPlugins([
        "obsidian@obsidian-skills",
        " paper-desktop@paper ",
        "obsidian@obsidian-skills",
        "stripe",
        '"x":true,"y@z',
        4,
        "-a@b",
      ]),
    ).toEqual(["obsidian@obsidian-skills", "paper-desktop@paper"]);
    expect(sanitizeDisabledPlugins([])).toBeUndefined();
    expect(sanitizeDisabledPlugins("a@b")).toBeUndefined();
    const many = Array.from({ length: 80 }, (_, i) => `p${i}@m`);
    expect(sanitizeDisabledPlugins(many)).toHaveLength(MAX_DISABLED_PLUGINS);
  });

  it("switch one plugin at a time", () => {
    const off = setPluginOnForChat([], "a@b", false);
    expect(off).toEqual(["a@b"]);
    expect(setPluginOnForChat(off, "a@b", false)).toBe(off);
    expect(setPluginOnForChat(off, "a@b", true)).toEqual([]);
    const none: string[] = [];
    expect(setPluginOnForChat(none, "a@b", true)).toBe(none);
    expect(setPluginOnForChat(none, "not an id", false)).toBe(none);
  });

  it("become false entries under enabledPlugins for --settings", () => {
    expect(claudePluginOverrides(["z@m", "a@m", "bad"])).toEqual({
      "a@m": false,
      "z@m": false,
    });
    expect(JSON.stringify(claudePluginOverrides(["z@m", "a@m"]))).toBe(
      '{"a@m":false,"z@m":false}',
    );
    expect(claudePluginOverrides([])).toBeUndefined();
    expect(claudePluginOverrides(undefined)).toBeUndefined();
  });
});

describe("the chat's plugin list", () => {
  it("lists what loads in the chat's folder once each, then ids that no longer load", () => {
    const plugins = parsePluginList(
      JSON.stringify([
        ...PLUGIN_LIST_FIXTURE,
        // The same plugin at a second scope gets no second row.
        { ...PLUGIN_LIST_FIXTURE[0], scope: "local", projectPath: "/repo" },
      ]),
    );
    const rows = chatPluginRows(plugins, ["paper-desktop@paper", "gone@m"]);
    expect(rows.map((row) => [row.id, row.on, row.detail])).toEqual([
      ["browser-use@synced", true, "claude.ai"],
      ["obsidian@obsidian-skills", true, "obsidian-skills"],
      ["paper-desktop@paper", false, "paper · MCP: paper"],
      ["gone@m", false, "Not loading here any more"],
    ]);
    // Stripe is off in this folder's settings, so it does not load here.
    expect(rows.some((row) => row.id.startsWith("stripe"))).toBe(false);
    expect(rows[3].missing).toBe(true);
  });

  it("shows a plugin managed settings install as locked on", () => {
    const plugins = parsePluginList(
      JSON.stringify([
        { ...PLUGIN_LIST_FIXTURE[0], id: "policy@corp", scope: "managed" },
        // The same id also installed by the user: managed still wins.
        { ...PLUGIN_LIST_FIXTURE[0], id: "policy@corp", scope: "user" },
      ]),
    );
    expect(chatPluginRows(plugins, [])).toEqual([
      {
        id: "policy@corp",
        name: "policy",
        marketplace: "corp",
        detail: "Set by your organization",
        on: true,
        locked: true,
      },
    ]);
  });
});
