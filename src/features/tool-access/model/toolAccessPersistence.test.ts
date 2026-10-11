import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../sessions/data/sessionStore";
import { newSession, type Session } from "../../sessions/model/session";
import { newTab } from "../../workspace/model/layout";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "../../workspace/model/workspaceSnapshot";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const { getSession, sanitizeSessionForPersist } =
  await import("../../sessions/data/sessionStore");

function record(): SessionRecord {
  return {
    id: "s1",
    harness: "claude",
    model: "claude-sonnet-5",
    cwd: "/repo",
    blocks: [
      { id: "b0", role: "user", text: "run the tests" },
      {
        id: "b1",
        role: "tool",
        text: "npm test",
        tool: { callId: "c1", title: "npm test", kind: "execute" },
        approval: {
          requestId: 3,
          decided: "allow",
          tool: { key: "Bash", label: "Bash" },
        },
      },
    ],
  } as unknown as SessionRecord;
}

describe("tool rules across a restart", () => {
  beforeEach(() => invoke.mockReset());

  it("come back from the first user block, sanitized", async () => {
    const saved = record();
    saved.blocks[0].sessionTools = {
      extraDirs: ["/work/docs"],
      toolAccess: {
        Bash: "always",
        mcp__exa__web_search: "never",
        Edit: "ask",
        "--flag": "never",
      },
    } as never;
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? saved : null),
    );
    const session = await getSession("s1");
    expect(session?.toolAccess).toEqual({
      Bash: "always",
      mcp__exa__web_search: "never",
    });
    expect(session?.extraDirs).toEqual(["/work/docs"]);
    // The carrier belongs to storage, not to the live transcript.
    expect(session?.blocks[0]).not.toHaveProperty("sessionTools");
    // The decided card still names its tool, for the chat's tool list.
    expect(session?.blocks[1].approval).toEqual({
      requestId: 3,
      decided: "allow",
      tool: { key: "Bash", label: "Bash" },
    });
  });

  it("round trip through a save and a load", async () => {
    const live: Session = {
      ...newSession("codex", "/repo"),
      id: "s1",
      blocks: [{ id: "u1", role: "user", text: "go" }],
      toolAccess: { "codex:command": "never", "codex:file-change": "always" },
    };
    const saved = JSON.parse(JSON.stringify(sanitizeSessionForPersist(live)));
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? saved : null),
    );
    expect((await getSession("s1"))?.toolAccess).toEqual(live.toolAccess);
  });

  it("are absent from a session saved without them", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? record() : null),
    );
    expect(await getSession("s1")).not.toHaveProperty("toolAccess");
  });

  it("stay with a tab that has not sent a message yet", () => {
    const session: Session = {
      ...newSession("claude", "/tmp/a"),
      id: "blank",
      toolAccess: { Bash: "always", WebFetch: "never" },
    };
    const tab = newTab(session.id);
    const saved = JSON.parse(
      JSON.stringify(
        collectWorkspaceSnapshot(
          [tab],
          [session],
          tab.id,
          session.cwd,
          new Map(),
        ),
      ),
    );
    expect(saved.sessions[0].toolAccess).toEqual(session.toolAccess);
    saved.sessions[0].toolAccess.Edit = "sometimes";
    saved.sessions[0].toolAccess["Bash(rm *)"] = "never";
    const restored = hydrateWorkspaceSnapshot(
      parseWorkspaceSnapshot(saved)!,
      new Map(),
      new Set(),
    )?.sessions[0];
    expect(restored?.toolAccess).toEqual({ Bash: "always", WebFetch: "never" });

    const plain = collectWorkspaceSnapshot(
      [tab],
      [{ ...session, toolAccess: undefined }],
      tab.id,
      session.cwd,
      new Map(),
    );
    expect(plain.sessions[0]).not.toHaveProperty("toolAccess");
  });
});
