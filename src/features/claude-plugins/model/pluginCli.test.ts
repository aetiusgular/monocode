import { describe, expect, it } from "vitest";
import { PLUGIN_LIST_FIXTURE } from "./__fixtures__/fakeClaudePlugin";
import {
  folderName,
  isPluginId,
  parsePluginList,
  parseToggleResult,
  pluginControl,
  pluginToggleCall,
  type ClaudePlugin,
} from "./pluginCli";

const listed = () => parsePluginList(JSON.stringify(PLUGIN_LIST_FIXTURE));
const byId = (id: string) => listed().find((plugin) => plugin.id === id)!;

describe("claude plugin list --json", () => {
  it("reads each installation from the array Claude Code prints", () => {
    expect(listed().map((plugin) => [plugin.id, plugin.scope])).toEqual([
      ["obsidian@obsidian-skills", "user"],
      ["paper-desktop@paper", "user"],
      ["stripe@claude-plugins-official", "local"],
      ["browser-use@synced", "synced"],
    ]);
    expect(byId("paper-desktop@paper")).toMatchObject({
      name: "paper-desktop",
      marketplace: "paper",
      version: "0.2.1",
      enabled: true,
      mcpServers: ["paper"],
      errors: [],
    });
    expect(byId("stripe@claude-plugins-official")).toMatchObject({
      enabled: false,
      projectPath: "/Users/me/Projects/resale-platform",
    });
    expect(byId("browser-use@synced")).toMatchObject({
      name: "browser-use",
      marketplace: "synced",
      version: "unknown",
    });
  });

  it("takes the --available form and text printed ahead of the JSON", () => {
    const installed = PLUGIN_LIST_FIXTURE.slice(0, 1);
    expect(
      parsePluginList(JSON.stringify({ installed, available: [] })),
    ).toHaveLength(1);
    expect(
      parsePluginList(`Update available\n${JSON.stringify(installed)}`),
    ).toHaveLength(1);
    expect(parsePluginList("")).toEqual([]);
    expect(() => parsePluginList("No plugins installed.")).toThrow();
    expect(() => parsePluginList('{"plugins": []}')).toThrow();
  });

  it("drops entries without an id or with an unknown scope, and keeps errors", () => {
    const plugins = parsePluginList(
      JSON.stringify([
        { scope: "user", enabled: true },
        { id: "x@y", scope: "galaxy", enabled: true },
        {
          id: "broken@m",
          scope: "user",
          enabled: true,
          errors: ["Plugin not cached", 4],
        },
      ]),
    );
    expect(plugins.map((plugin) => plugin.id)).toEqual(["broken@m"]);
    expect(plugins[0].errors).toEqual(["Plugin not cached"]);
  });
});

describe("plugin ids", () => {
  it("accepts name@marketplace only", () => {
    expect(isPluginId("obsidian@obsidian-skills")).toBe(true);
    expect(isPluginId("a.b_c-1@X.y")).toBe(true);
    expect(isPluginId("stripe")).toBe(false);
    expect(isPluginId("a@b@c")).toBe(false);
    expect(isPluginId("-x@y")).toBe(false);
    expect(isPluginId("a b@c")).toBe(false);
    expect(isPluginId(`${"a".repeat(200)}@b`)).toBe(false);
  });
});

describe("switching a plugin", () => {
  it("runs enable or disable at the plugin's own scope", () => {
    expect(pluginToggleCall(byId("obsidian@obsidian-skills"), false)).toEqual({
      args: [
        "plugin",
        "disable",
        "--scope",
        "user",
        "--json",
        "obsidian@obsidian-skills",
      ],
    });
    expect(
      pluginToggleCall(byId("stripe@claude-plugins-official"), true),
    ).toEqual({
      args: [
        "plugin",
        "enable",
        "--scope",
        "local",
        "--json",
        "stripe@claude-plugins-official",
      ],
      cwd: "/Users/me/Projects/resale-platform",
    });
  });

  it("passes a synced plugin without a scope, as the docs show", () => {
    expect(pluginToggleCall(byId("browser-use@synced"), false)).toEqual({
      args: ["plugin", "disable", "--json", "browser-use@synced"],
    });
  });

  it("leaves managed plugins and project plugins without a folder read-only", () => {
    const base = byId("obsidian@obsidian-skills");
    const managed: ClaudePlugin = { ...base, scope: "managed" };
    expect(pluginControl(managed)).toEqual({
      kind: "read-only",
      reason: "Set by your organization's managed settings.",
    });
    expect(pluginToggleCall(managed, false)).toBeNull();
    const project: ClaudePlugin = { ...base, scope: "project" };
    expect(pluginControl(project).kind).toBe("read-only");
    expect(pluginToggleCall({ ...base, id: "odd id" }, false)).toBeNull();
  });
});

describe("the --json result of enable and disable", () => {
  const out = (value: unknown, success: boolean, stderr = "") => ({
    stdout: `Running command...\n${JSON.stringify(value)}\n`,
    stderr,
    success,
  });

  it("is done on ok, and when the plugin was already that way", () => {
    expect(parseToggleResult(out({ outcome: "ok" }, true))).toEqual({
      ok: true,
    });
    expect(
      parseToggleResult(
        out(
          {
            outcome: "failed",
            message: 'Plugin "x" is already disabled',
            failureCode: "already_in_goal_state",
            alreadyInGoalState: true,
          },
          false,
        ),
      ),
    ).toEqual({ ok: true });
  });

  it("carries Claude Code's message on failure", () => {
    expect(
      parseToggleResult(
        out(
          {
            outcome: "failed",
            message:
              'Plugin "browser-use@synced" is required by your organization',
          },
          false,
        ),
      ),
    ).toEqual({
      ok: false,
      message: 'Plugin "browser-use@synced" is required by your organization',
    });
    // A usage error prints only to stderr.
    expect(
      parseToggleResult({
        stdout: "",
        stderr: "error: option '--scope <scope>' argument 'x' is invalid",
        success: false,
      }),
    ).toEqual({
      ok: false,
      message: "error: option '--scope <scope>' argument 'x' is invalid",
    });
  });
});

it("names a project by its folder", () => {
  expect(folderName("/Users/me/Projects/resale-platform")).toBe(
    "resale-platform",
  );
  expect(folderName("C:\\work\\app\\")).toBe("app");
});
