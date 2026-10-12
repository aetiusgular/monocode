import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { listClaudeSessions } from "./claudeSessions";
import { claudeAdapter } from "./claudeAdapter";

beforeEach(() => invoke.mockReset());

describe("listClaudeSessions", () => {
  it("asks the app for the folder's transcripts as the chat's account", async () => {
    invoke.mockResolvedValue([
      { id: "s1", title: "fix it", updatedAt: 5, detail: "recorded by Claude Code 2.1.292" },
    ]);
    const rows = await listClaudeSessions({ cwd: "/repo", providerAccountId: "work" });
    expect(invoke).toHaveBeenCalledWith("claude_sessions_list", {
      cwd: "/repo",
      accountId: "work",
    });
    expect(rows).toEqual([
      { id: "s1", title: "fix it", updatedAt: 5, detail: "recorded by Claude Code 2.1.292" },
    ]);
  });

  it("sends no account for the default one", async () => {
    invoke.mockResolvedValue([]);
    await listClaudeSessions({ cwd: "/repo", providerAccountId: "default" });
    await listClaudeSessions({ cwd: "/repo" });
    expect(invoke.mock.calls.map((call) => call[1].accountId)).toEqual([null, null]);
  });

  it("checks what comes back", async () => {
    invoke.mockResolvedValue([
      { id: "--resume", title: "flag" },
      { id: "ok", title: "a\u0007b", updatedAt: 1 },
      "junk",
    ]);
    expect(await listClaudeSessions({ cwd: "/repo" })).toEqual([
      { id: "ok", title: "ab", updatedAt: 1 },
    ]);
  });

  it("passes a refusal on", async () => {
    // Other modules may call invoke on their own; only this command fails.
    invoke.mockImplementation(async (command: string) => {
      if (command === "claude_sessions_list")
        throw "The folder must be an absolute path";
      return undefined;
    });
    await expect(listClaudeSessions({ cwd: "repo" })).rejects.toThrow(
      "The folder must be an absolute path",
    );
  });
});

describe("Claude adapter", () => {
  it("lists sessions and imports no turns", () => {
    expect(claudeAdapter.listSessions).toBe(listClaudeSessions);
    expect(claudeAdapter.readSessionTurns).toBeUndefined();
  });
});
