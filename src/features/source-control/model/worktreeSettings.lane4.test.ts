import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args: unknown) => ({ path: "/x" })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  notifyGitChanged: vi.fn(),
}));

import {
  DEFAULT_BRANCH_PREFIX,
  loadWorktreeSettings,
  resetWorktreeSettingsCache,
  sanitizeBranchPrefix,
  sanitizeWorktreeFolder,
  sanitizeWorktreeSettings,
  saveWorktreeSettings,
  WORKTREE_SETTINGS_KEY,
} from "./worktreeSettings";
import { createWorktree, namedWorktreeBranch } from "./worktrees";
import {
  WorktreeSettingsFields,
  worktreeLocation,
} from "../ui/WorktreeSettingsFields";

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    },
    configurable: true,
  });
}

beforeEach(() => {
  mockLocalStorage();
  resetWorktreeSettingsCache();
  invoke.mockClear();
});

describe("worktree folder", () => {
  it("keeps absolute folders and empty", () => {
    expect(sanitizeWorktreeFolder("  /Users/me/trees ")).toBe("/Users/me/trees");
    expect(sanitizeWorktreeFolder("~/worktrees")).toBe("~/worktrees");
    expect(sanitizeWorktreeFolder("C:\\trees")).toBe("C:\\trees");
    expect(sanitizeWorktreeFolder("/Users/me/my trees")).toBe("/Users/me/my trees");
    expect(sanitizeWorktreeFolder("")).toBe("");
  });

  it("drops relative folders, .. and control characters", () => {
    for (const bad of ["trees", "./trees", "/a/../b", "~/../x", "/a\nb", 42, null]) {
      expect(sanitizeWorktreeFolder(bad)).toBe("");
    }
  });
});

describe("branch prefix", () => {
  it("keeps plain prefixes and allows none", () => {
    expect(sanitizeBranchPrefix("tony/")).toBe("tony/");
    expect(sanitizeBranchPrefix("wt-")).toBe("wt-");
    expect(sanitizeBranchPrefix("")).toBe("");
  });

  it("falls back to mc/ for anything git or a shell could misread", () => {
    for (const bad of ["-x/", "/x", ".x", "a..b/", "a//b", "a b/", "$(x)/", "a.lock/", "x".repeat(41), 7]) {
      expect(sanitizeBranchPrefix(bad)).toBe(DEFAULT_BRANCH_PREFIX);
    }
  });

  it("names a worktree branch with your prefix", () => {
    expect(namedWorktreeBranch("fix-login", "mc/")).toBe("mc/fix-login");
    expect(namedWorktreeBranch("fix-login", "tony/")).toBe("tony/fix-login");
    expect(namedWorktreeBranch("tony/fix-login", "tony/")).toBe("tony/fix-login");
    expect(namedWorktreeBranch("mc/fix-login", "tony/")).toBe("tony/fix-login");
    expect(namedWorktreeBranch("fix-login", "")).toBe("fix-login");
    expect(namedWorktreeBranch("  /// ", "tony/")).toBeNull();
  });

  it("reads the saved prefix by default", () => {
    saveWorktreeSettings({ prefix: "tony/" });
    expect(namedWorktreeBranch("x")).toBe("tony/x");
  });
});

describe("storage", () => {
  it("survives a reload (case 14)", () => {
    saveWorktreeSettings({ folder: "~/trees", prefix: "wt/" });
    resetWorktreeSettingsCache();
    expect(loadWorktreeSettings()).toEqual({ folder: "~/trees", prefix: "wt/" });
  });

  it("sanitizes what it reads back", () => {
    localStorage.setItem(
      WORKTREE_SETTINGS_KEY,
      JSON.stringify({ folder: "relative", prefix: "-bad" }),
    );
    resetWorktreeSettingsCache();
    expect(loadWorktreeSettings()).toEqual({ folder: "", prefix: "mc/" });
    localStorage.setItem(WORKTREE_SETTINGS_KEY, "{broken");
    resetWorktreeSettingsCache();
    expect(loadWorktreeSettings()).toEqual({ folder: "", prefix: "mc/" });
    expect(sanitizeWorktreeSettings([1])).toEqual({ folder: "", prefix: "mc/" });
  });
});

describe("creating a worktree", () => {
  it("sends the folder you set", async () => {
    saveWorktreeSettings({ folder: "~/trees" });
    await createWorktree("/repo", "mc/abc", "HEAD", false);
    expect(invoke).toHaveBeenCalledWith("git_worktree_create", {
      cwd: "/repo",
      branch: "mc/abc",
      base: "HEAD",
      existing: false,
      folder: "~/trees",
    });
  });

  it("sends no folder by default", async () => {
    await createWorktree("/repo", "mc/abc", "HEAD", false);
    expect(invoke).toHaveBeenCalledWith("git_worktree_create", {
      cwd: "/repo",
      branch: "mc/abc",
      base: "HEAD",
      existing: false,
    });
  });
});

describe("settings fields", () => {
  it("shows where worktrees go", () => {
    expect(worktreeLocation("", "/code/app", "/code/app-worktrees")).toBe(
      "/code/app-worktrees",
    );
    expect(worktreeLocation("~/trees/", "/code/app/")).toBe("~/trees/app");
  });

  it("renders both fields and the include note", () => {
    const html = renderToStaticMarkup(createElement(WorktreeSettingsFields));
    expect(html).toContain("Worktree folder");
    expect(html).toContain("Branch prefix");
    expect(html).toContain(".worktreeinclude");
    expect(html).toContain('value="mc/"');
  });
});
