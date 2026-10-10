import { describe, expect, it } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { resolveModel } from "../../sessions/model/models";
import { sessionFacts } from "./sessionFacts";

function facts(patch: Partial<Session> = {}): Record<string, string> {
  const session = { ...newSession("codex", "/home/tony/app"), ...patch };
  return Object.fromEntries(
    sessionFacts(session).map((fact) => [fact.label, fact.value]),
  );
}

describe("sessionFacts", () => {
  it("names the provider, model, permissions and working copy", () => {
    const session = newSession("codex", "/home/tony/app");
    expect(facts(session)).toEqual({
      Provider: "Codex",
      Model: resolveModel("codex", session.model).name,
      Permissions: "Supervised",
      "Working copy": "~/app",
    });
  });

  it("shows the worktree the session runs in rather than its project", () => {
    const listed = sessionFacts({
      ...newSession("claude", "/home/tony/app"),
      worktreeCwd: "/home/tony/worktrees/app-fix",
      runtimeMode: "full-access",
    });
    const workingCopy = listed.find((fact) => fact.label === "Working copy");
    expect(workingCopy).toEqual({
      label: "Working copy",
      value: "~/worktrees/app-fix",
      title: "/home/tony/worktrees/app-fix",
    });
    expect(listed.find((fact) => fact.label === "Permissions")?.value).toBe(
      "Full access",
    );
  });

  it("adds the branch when the session knows it", () => {
    expect(facts().Branch).toBeUndefined();
    expect(facts({ branch: "feature/panel" }).Branch).toBe("feature/panel");
  });

  it("adds context use once the provider has reported it", () => {
    expect(facts().Context).toBeUndefined();
    expect(facts({ context: { used: 176_000, window: 256_000 } }).Context).toBe(
      "69% · 176K / 256K tokens",
    );
    expect(facts({ context: { used: 42_500 } }).Context).toBe("43K tokens");
  });
});
