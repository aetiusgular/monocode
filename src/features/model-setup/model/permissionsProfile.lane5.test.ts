import { describe, expect, it } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { sanitizeSessionForPersist } from "../../sessions/data/sessionStore";
import {
  sessionToolsInput,
  sessionToolsSummary,
  withSessionToolsPatch,
} from "../../session-tools/model/harnessInput";
import { newTab } from "../../workspace/model/layout";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "../../workspace/model/workspaceSnapshot";
import { sanitizePermissionsProfile } from "./permissionsProfile";

const base = (): Session => {
  const session = newSession("codex", "/tmp/a");
  session.blocks = [{ id: "u1", role: "user", text: "Hello" }];
  return session;
};

describe("permissions profile per chat", () => {
  it("keeps plain ids and drops everything else", () => {
    expect(sanitizePermissionsProfile(" net-npm ")).toBe("net-npm");
    expect(sanitizePermissionsProfile("a b")).toBeUndefined();
    expect(sanitizePermissionsProfile("--sandbox")).toBeUndefined();
    expect(sanitizePermissionsProfile("x".repeat(65))).toBeUndefined();
    expect(sanitizePermissionsProfile(null)).toBeUndefined();
  });

  it("is set and cleared by a patch", () => {
    const set = withSessionToolsPatch(base(), {
      permissionsProfile: "net-npm",
    });
    expect(set.permissionsProfile).toBe("net-npm");
    expect(
      withSessionToolsPatch(base(), { permissionsProfile: "$(x)" })
        .permissionsProfile,
    ).toBeUndefined();
    expect(
      withSessionToolsPatch(set, { permissionsProfile: "" }).permissionsProfile,
    ).toBeUndefined();
    expect(
      withSessionToolsPatch(set, { modelProvider: "ollama" })
        .permissionsProfile,
    ).toBe("net-npm");
  });

  it("reaches the harness input and the summary", () => {
    const session = { ...base(), permissionsProfile: "net-npm" };
    expect(sessionToolsInput(session, "/tmp/a").permissionsProfile).toBe(
      "net-npm",
    );
    expect(sessionToolsInput(base(), "/tmp/a")).not.toHaveProperty(
      "permissionsProfile",
    );
    expect(sessionToolsSummary(session, "/tmp/a")?.title).toContain(
      "Permissions profile: net-npm",
    );
  });

  it("is saved with the transcript and read back clean", () => {
    const saved = sanitizeSessionForPersist({
      ...base(),
      permissionsProfile: "net-npm",
    });
    expect(saved.blocks[0].sessionTools).toEqual({
      permissionsProfile: "net-npm",
    });
    const tampered = sanitizeSessionForPersist({
      ...base(),
      permissionsProfile: "../../etc",
    });
    expect(tampered.blocks[0].sessionTools).toBeUndefined();
  });

  it("survives a workspace snapshot round trip; a bad stored value is dropped", () => {
    const session: Session = {
      ...newSession("codex", "/tmp/a"),
      id: "blank",
      permissionsProfile: "net-npm",
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
    expect(saved.sessions[0].permissionsProfile).toBe("net-npm");
    const restored = hydrateWorkspaceSnapshot(
      parseWorkspaceSnapshot(saved)!,
      new Map(),
      new Set(),
    )?.sessions[0];
    expect(restored?.permissionsProfile).toBe("net-npm");

    saved.sessions[0].permissionsProfile = "not/a/profile";
    const dropped = hydrateWorkspaceSnapshot(
      parseWorkspaceSnapshot(saved)!,
      new Map(),
      new Set(),
    )?.sessions[0];
    expect(dropped?.permissionsProfile).toBeUndefined();
  });
});
