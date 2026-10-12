import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, account, binary } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args: unknown) => [] as unknown[]),
  account: vi.fn((_provider: string, _project: string | undefined) => "default"),
  binary: vi.fn((_provider: string) => null as string | null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../providers/model/providerAccounts", () => ({
  selectedProviderAccountId: account,
}));
vi.mock("../../providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: binary,
}));

import { discoverArgs, loadMcpSettings } from "./mcpSettingsCache";

beforeEach(() => {
  invoke.mockClear();
  account.mockReset();
  account.mockImplementation(() => "default");
  binary.mockReset();
  binary.mockImplementation(() => null);
});

describe("discovery follows the session's Codex home (#7)", () => {
  it("sends the project's Codex account and the configured binary", () => {
    account.mockImplementation(() => "local-home");
    binary.mockImplementation(() => "/Users/me/codex-local-bin/codex");
    expect(discoverArgs("/repo")).toEqual({
      cwd: "/repo",
      codexAccountId: "local-home",
      codexBinary: "/Users/me/codex-local-bin/codex",
    });
    expect(account).toHaveBeenCalledWith("codex", "/repo");
  });

  it("sends only the folder with the default account and no binary set", () => {
    expect(discoverArgs("/repo")).toEqual({ cwd: "/repo" });
    account.mockImplementation(() => "");
    expect(discoverArgs("/repo")).toEqual({ cwd: "/repo" });
  });

  it("still discovers when reading the settings throws", () => {
    account.mockImplementation(() => {
      throw new Error("storage blocked");
    });
    binary.mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(discoverArgs("/repo")).toEqual({ cwd: "/repo" });
  });

  it("passes them to mcp_discover", async () => {
    account.mockImplementation(() => "local-home");
    await loadMcpSettings("/repo-7", true, { claudeHealth: false });
    expect(invoke).toHaveBeenCalledWith("mcp_discover", {
      cwd: "/repo-7",
      codexAccountId: "local-home",
    });
  });
});
