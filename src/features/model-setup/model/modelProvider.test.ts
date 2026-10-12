import { describe, expect, it } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import {
  persistFingerprint,
  sanitizeSessionForPersist,
} from "../../sessions/data/sessionStore";
import {
  sessionToolsInput,
  withSessionToolsPatch,
} from "../../session-tools/model/harnessInput";
import { newTab } from "../../workspace/model/layout";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "../../workspace/model/workspaceSnapshot";
import { sanitizeModelProvider } from "./modelProvider";
import { providerLocality } from "./providerLocality";
import { isLocal, sessionIsLocal } from "../../server-locality/model/locality";
import { serverLocality } from "../../server-locality/model/serverLocality";

describe("provider id", () => {
  it("keeps plain ids and drops everything else", () => {
    expect(sanitizeModelProvider(" ollama ")).toBe("ollama");
    expect(sanitizeModelProvider("lm-studio_2.local")).toBe(
      "lm-studio_2.local",
    );
    expect(sanitizeModelProvider("")).toBeUndefined();
    expect(sanitizeModelProvider("http://localhost:11434")).toBeUndefined();
    expect(sanitizeModelProvider("../codex")).toBeUndefined();
    expect(sanitizeModelProvider("-c")).toBeUndefined();
    expect(sanitizeModelProvider("a b")).toBeUndefined();
    expect(sanitizeModelProvider("x".repeat(65))).toBeUndefined();
    expect(sanitizeModelProvider(7)).toBeUndefined();
  });
});

describe("locality stubs", () => {
  it("call Claude Code hosted and every other harness unknown", () => {
    expect(sessionIsLocal({ harness: "claude" })).toBe("hosted");
    expect(sessionIsLocal({ harness: "codex", modelProvider: "ollama" })).toBe(
      "unknown",
    );
    expect(serverLocality({ name: "playwright", command: "npx" })).toBe(
      "unknown",
    );
    // Lane 5 filled providerLocality: an id nobody set up stays unknown.
    expect(providerLocality("nobody-set-this-up")).toBe("unknown");
  });

  it("never count unknown as local", () => {
    expect(isLocal("unknown")).toBe(false);
    expect(isLocal("hosted")).toBe(false);
    expect(isLocal("local")).toBe(true);
  });
});

describe("provider per chat, carried with no effect", () => {
  const base = (): Session => {
    const session = newSession("codex", "/tmp/a");
    session.blocks = [{ id: "u1", role: "user", text: "Hello" }];
    return session;
  };

  it("is set and cleared by a patch", () => {
    const set = withSessionToolsPatch(base(), { modelProvider: "ollama" });
    expect(set.modelProvider).toBe("ollama");
    const bad = withSessionToolsPatch(base(), { modelProvider: "a b" });
    expect(bad.modelProvider).toBeUndefined();
    expect(
      withSessionToolsPatch(set, { modelProvider: "" }).modelProvider,
    ).toBeUndefined();
    // A patch that does not name it leaves it alone.
    expect(
      withSessionToolsPatch(set, { disabledSkills: [] }).modelProvider,
    ).toBe("ollama");
  });

  it("reaches the harness input", () => {
    const session = { ...base(), modelProvider: "ollama" };
    expect(sessionToolsInput(session, "/tmp/a").modelProvider).toBe("ollama");
    expect(sessionToolsInput(base(), "/tmp/a")).not.toHaveProperty(
      "modelProvider",
    );
  });

  it("is saved with the transcript and read back clean", () => {
    const session = { ...base(), modelProvider: "ollama" };
    const saved = sanitizeSessionForPersist(session);
    expect(saved).not.toHaveProperty("modelProvider");
    expect(saved.blocks[0].sessionTools).toEqual({ modelProvider: "ollama" });
    expect(persistFingerprint(session)).not.toBe(persistFingerprint(base()));
    const tampered = sanitizeSessionForPersist({
      ...base(),
      modelProvider: "$(rm -rf ~)",
    });
    expect(tampered.blocks[0].sessionTools).toBeUndefined();
  });

  it("survives a restart on a tab that has not sent yet (corner case 14)", () => {
    const session: Session = {
      ...newSession("codex", "/tmp/a"),
      id: "blank",
      modelProvider: "ollama",
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
    expect(saved.sessions[0].modelProvider).toBe("ollama");
    const restored = hydrateWorkspaceSnapshot(
      parseWorkspaceSnapshot(saved)!,
      new Map(),
      new Set(),
    )?.sessions[0];
    expect(restored?.modelProvider).toBe("ollama");

    saved.sessions[0].modelProvider = "not/a/provider";
    const dropped = hydrateWorkspaceSnapshot(
      parseWorkspaceSnapshot(saved)!,
      new Map(),
      new Set(),
    )?.sessions[0];
    expect(dropped?.modelProvider).toBeUndefined();
  });
});
