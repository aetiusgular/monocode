import { describe, expect, it } from "vitest";
import type { ClaudePlugin } from "./pluginCli";
import {
  canManage,
  checkMarketplaceSource,
  isMarketplaceName,
  marketplaceAddArgs,
  marketplaceRemoveArgs,
  marketplaceUpdateArgs,
  parseAvailablePlugins,
  parseManageResult,
  parseMarketplaceList,
  pluginInstallCall,
  pluginUninstallCall,
  pluginUpdateCall,
} from "./pluginManage";

const HASH = "4dfac0a00339d273c4d73168fd2ac0bddbcb6b706484954fdbfdc21457660b6f";

const plugin = (over: Partial<ClaudePlugin> = {}): ClaudePlugin => ({
  id: "hello@testmk",
  name: "hello",
  marketplace: "testmk",
  version: "1.0.0",
  scope: "user",
  enabled: true,
  installPath: "/x",
  mcpServers: [],
  errors: [],
  ...over,
});

// Outputs copied from Claude Code 2.1.292 run against a local test
// marketplace in a throwaway home on 12 Oct 2026.
const REFUSED_STDOUT = `"cmdp" is installed by running a command from marketplace "cmk" on this machine:
  echo /tmp/tmp.UtkIoAzUeK/plug
  (mode "copy": its output directory is copied into the plugin cache)
Not an interactive terminal, so the command was only displayed, not accepted.
{"command":"install","outcome":"failed","plugin":"cmdp@cmk","scope":"user","message":"cmdp@cmk is installed by running a command on this machine (\`echo /tmp/x\`) that has not been reviewed yet, so it was not run.","failureCode":"command_source_refused","shownCommand":{"kind":"command_source","pluginId":"cmdp@cmk","command":"echo /tmp/tmp.UtkIoAzUeK/plug","mode":"copy","catalogRevision":"sha256:e2be","sha256":"${HASH}"}}
`;

describe("install, update and uninstall calls", () => {
  it("installs at the user scope with no folder", () => {
    expect(pluginInstallCall("hello@testmk", "user", "/repo")).toEqual({
      args: ["plugin", "install", "--scope", "user", "--json", "hello@testmk"],
    });
  });

  it("installs at a project scope only with its folder", () => {
    expect(pluginInstallCall("hello@testmk", "local", "/repo")).toEqual({
      args: ["plugin", "install", "--scope", "local", "--json", "hello@testmk"],
      cwd: "/repo",
    });
    expect(pluginInstallCall("hello@testmk", "project", undefined)).toBeNull();
  });

  it("passes an accepted command's hash and nothing like --yes", () => {
    const call = pluginInstallCall("cmdp@cmk", "user", undefined, HASH)!;
    expect(call.args).toEqual([
      "plugin",
      "install",
      "--scope",
      "user",
      "--json",
      "--accept-command",
      HASH,
      "cmdp@cmk",
    ]);
    expect(call.args).not.toContain("-y");
    expect(call.args).not.toContain("--yes");
    for (const bad of ["", "abc", HASH.toUpperCase(), `${HASH}0`, "--yes"]) {
      expect(pluginInstallCall("cmdp@cmk", "user", undefined, bad)).toBeNull();
    }
  });

  it("refuses ids that are not plugin ids, synced plugins and leading dashes", () => {
    for (const id of ["stripe", "--all@x", "a b@c", "x@synced", "a@b;rm"]) {
      expect(pluginInstallCall(id, "user", undefined)).toBeNull();
    }
  });

  it("updates and uninstalls at the installation's own scope", () => {
    expect(pluginUpdateCall(plugin())?.args).toEqual([
      "plugin",
      "update",
      "--scope",
      "user",
      "--json",
      "hello@testmk",
    ]);
    const local = plugin({ scope: "local", projectPath: "/Users/me/my repo" });
    expect(pluginUninstallCall(local, false)).toEqual({
      args: [
        "plugin",
        "uninstall",
        "--scope",
        "local",
        "--json",
        "--keep-data",
        "hello@testmk",
      ],
      cwd: "/Users/me/my repo",
    });
    expect(pluginUninstallCall(local, true)?.args).not.toContain("--keep-data");
  });

  it("does not offer update or uninstall where MonoCode cannot manage it", () => {
    for (const scope of ["synced", "managed", "session"] as const) {
      expect(canManage(plugin({ scope }))).toBe(false);
      expect(pluginUpdateCall(plugin({ scope }))).toBeNull();
      expect(pluginUninstallCall(plugin({ scope }), false)).toBeNull();
    }
    expect(canManage(plugin({ scope: "local" }))).toBe(false);
    expect(canManage(plugin({ scope: "local", projectPath: "/r" }))).toBe(true);
  });
});

describe("marketplace sources", () => {
  it("takes a GitHub repo, an https URL or an absolute path", () => {
    expect(
      checkMarketplaceSource("anthropics/claude-plugins-official"),
    ).toEqual({ ok: true, kind: "github" });
    expect(checkMarketplaceSource("https://example.com/m.json")).toEqual({
      ok: true,
      kind: "url",
    });
    expect(checkMarketplaceSource("/Users/me/marketplace")).toEqual({
      ok: true,
      kind: "path",
    });
    expect(checkMarketplaceSource("  owner/repo  ").ok).toBe(true);
  });

  it("refuses everything else, with a reason", () => {
    for (const bad of [
      "",
      "-x/y",
      "--claudeai",
      "owner",
      "a/b/c",
      "./mk",
      "../repo",
      "/tmp/../etc",
      "my marketplace/repo",
      "/tmp/a\nb",
      "http://example.com/m.json",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo",
      "file:///etc/passwd",
      "https://user:pw@example.com/m.json",
      "https://token@example.com/m.json",
      "owner/..",
      `a/${"b".repeat(2048)}`,
    ]) {
      const check = checkMarketplaceSource(bad);
      expect(check.ok, bad).toBe(false);
      if (!check.ok) expect(check.reason).toBeTruthy();
      expect(marketplaceAddArgs(bad)).toBeNull();
    }
  });

  it("adds to the user settings only", () => {
    expect(marketplaceAddArgs("owner/repo")).toEqual([
      "plugin",
      "marketplace",
      "add",
      "--scope",
      "user",
      "--json",
      "owner/repo",
    ]);
  });

  it("updates and removes by a plain name", () => {
    expect(marketplaceUpdateArgs("testmk")).toEqual([
      "plugin",
      "marketplace",
      "update",
      "--json",
      "testmk",
    ]);
    expect(marketplaceRemoveArgs("testmk")).toEqual([
      "plugin",
      "marketplace",
      "remove",
      "--json",
      "testmk",
    ]);
    for (const bad of ["", "-x", "--scope", "a/b", "a b"]) {
      expect(isMarketplaceName(bad)).toBe(false);
      expect(marketplaceUpdateArgs(bad)).toBeNull();
      expect(marketplaceRemoveArgs(bad)).toBeNull();
    }
  });
});

describe("results", () => {
  it("reads an ok result line", () => {
    expect(
      parseManageResult({
        stdout:
          '{"command":"install","outcome":"ok","plugin":"hello@testmk","pluginId":"hello@testmk","scope":"user","message":"Successfully installed plugin: hello@testmk (scope: user)"}\n',
        stderr: "",
        success: true,
      }),
    ).toEqual({
      ok: true,
      message: "Successfully installed plugin: hello@testmk (scope: user)",
    });
  });

  it("finds the result after the text that shows a command, and keeps the command", () => {
    const result = parseManageResult({
      stdout: REFUSED_STDOUT,
      stderr: "",
      success: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe("command_source_refused");
    expect(result.shownCommand).toEqual({
      kind: "command_source",
      pluginId: "cmdp@cmk",
      command: "echo /tmp/tmp.UtkIoAzUeK/plug",
      mode: "copy",
      sha256: HASH,
    });
  });

  it("drops a shown command whose hash is malformed", () => {
    const result = parseManageResult({
      stdout: REFUSED_STDOUT.replace(HASH, "zz"),
      stderr: "",
      success: false,
    });
    expect(result.ok === false && result.shownCommand).toBeFalsy();
  });

  it("falls back to stderr when there is no result line", () => {
    expect(
      parseManageResult({
        stdout: "",
        stderr: "error: unknown option '--x'",
        success: false,
      }),
    ).toEqual({ ok: false, message: "error: unknown option '--x'" });
  });

  it("reads the marketplace list", () => {
    expect(
      parseMarketplaceList(
        JSON.stringify([
          {
            name: "testmk",
            source: "directory",
            path: "/tmp/mk",
            installLocation: "/tmp/mk",
          },
          { name: "official", source: "github", repo: "anthropics/x" },
          { source: "github" },
        ]),
      ),
    ).toEqual([
      { name: "testmk", source: "directory", origin: "/tmp/mk" },
      { name: "official", source: "github", origin: "anthropics/x" },
    ]);
    expect(parseMarketplaceList("")).toEqual([]);
    expect(() => parseMarketplaceList("{}")).toThrow();
  });

  it("reads available plugins, skipping bad ids and repeats", () => {
    const list = parseAvailablePlugins(
      JSON.stringify({
        installed: [],
        available: [
          {
            pluginId: "frontend-design@anthropic-plugin-directory",
            name: "frontend-design",
            description: "Frontend design skill",
            marketplaceName: "anthropic-plugin-directory",
          },
          { pluginId: "frontend-design@anthropic-plugin-directory" },
          { pluginId: "--all@x" },
          { name: "no-id" },
        ],
      }),
    );
    expect(list).toEqual([
      {
        id: "frontend-design@anthropic-plugin-directory",
        name: "frontend-design",
        marketplace: "anthropic-plugin-directory",
        description: "Frontend design skill",
      },
    ]);
    expect(parseAvailablePlugins("not json")).toEqual([]);
  });
});
