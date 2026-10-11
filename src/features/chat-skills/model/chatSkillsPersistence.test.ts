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
    blocks: [{ id: "b0", role: "user", text: "ship it" }],
  } as unknown as SessionRecord;
}

describe("skills switched off for a chat, across a restart", () => {
  beforeEach(() => invoke.mockReset());

  it("come back from the first user block, sanitized", async () => {
    const saved = record();
    saved.blocks[0].sessionTools = {
      disabledMcpServers: ["github"],
      disabledSkills: ["deploy", "Skill(x)", 7, "deploy", "review-pr"],
    } as never;
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? saved : null),
    );
    const session = await getSession("s1");
    expect(session?.disabledSkills).toEqual(["deploy", "review-pr"]);
    expect(session?.disabledMcpServers).toEqual(["github"]);
    expect(session?.blocks[0]).not.toHaveProperty("sessionTools");
  });

  it("round trip through a save and a load", async () => {
    const live: Session = {
      ...newSession("codex", "/repo"),
      id: "s1",
      blocks: [{ id: "u1", role: "user", text: "go" }],
      disabledSkills: ["deploy"],
    };
    const saved = JSON.parse(JSON.stringify(sanitizeSessionForPersist(live)));
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? saved : null),
    );
    expect((await getSession("s1"))?.disabledSkills).toEqual(["deploy"]);
  });

  it("are absent from a session saved without them", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? record() : null),
    );
    expect(await getSession("s1")).not.toHaveProperty("disabledSkills");
  });

  it("stay with a tab that has not sent a message yet", () => {
    const session: Session = {
      ...newSession("claude", "/tmp/a"),
      id: "blank",
      disabledSkills: ["deploy", "review-pr"],
    };
    const tab = newTab(session.id);
    const collect = (current: Session) =>
      collectWorkspaceSnapshot(
        [tab],
        [current],
        tab.id,
        current.cwd,
        new Map(),
      );
    const saved = JSON.parse(JSON.stringify(collect(session)));
    expect(saved.sessions[0].disabledSkills).toEqual(["deploy", "review-pr"]);
    saved.sessions[0].disabledSkills.push("", 7, "deploy", "A B");
    const restored = hydrateWorkspaceSnapshot(
      parseWorkspaceSnapshot(saved)!,
      new Map(),
      new Set(),
    )?.sessions[0];
    expect(restored?.disabledSkills).toEqual(["deploy", "review-pr"]);
    expect(
      collect({ ...session, disabledSkills: undefined }).sessions[0],
    ).not.toHaveProperty("disabledSkills");
  });
});
