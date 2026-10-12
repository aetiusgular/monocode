import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { monoCodeToolCall, monoCodeWorkSummary } from "./monocodeToolCall";

function shell(text: string): Block {
  return { id: text, role: "tool", text, tool: { kind: "shell" } };
}

// The 32 actions of the Rust CLI's APP_ACTIONS at the base commit.
const APP_ACTIONS = [
  "models.list",
  "sessions.list",
  "sessions.read",
  "sessions.send",
  "sessions.draft",
  "sessions.start",
  "sessions.stop",
  "sessions.archive",
  "sessions.delete",
  "worktrees.list",
  "worktrees.create",
  "folders.list",
  "folders.move",
  "notes.list",
  "notes.read",
  "notes.write",
  "artifacts.list",
  "artifacts.read",
  "artifacts.write",
  "soul.read",
  "soul.update",
  "memory.read",
  "memory.search",
  "memory.add",
  "memory.replace",
  "memory.remove",
  "habits.list",
  "habits.add",
  "habits.update",
  "habits.run",
  "habits.remove",
  "chat.card",
];

describe("F7: every app action has a transcript label", () => {
  it("labels all 32 actions", () => {
    for (const action of APP_ACTIONS) {
      const call = monoCodeToolCall(
        shell(`monocode app ${action} --json '{}'`),
      );
      expect(call?.action, action).toBe(action);
      expect(call?.label.length, action).toBeGreaterThan(0);
    }
  });

  it("names a group of memory calls for the app, not the shell", () => {
    const steps = [
      shell('monocode app memory.search --json \'{"query":"release"}\''),
      shell('monocode app memory.add --json \'{"fact":"x"}\''),
    ];
    expect(monoCodeWorkSummary(steps, false)).toBe("Used MonoCode");
  });

  it("recognizes help for one action", () => {
    expect(
      monoCodeToolCall(shell("monocode app help sessions.start"))?.label,
    ).toBe("View help for sessions.start");
    expect(monoCodeToolCall(shell("monocode app help memory"))?.label).toBe(
      "View help for memory",
    );
    // Anything that is not a plain action or group stays a shell row.
    expect(monoCodeToolCall(shell("monocode app help ../x"))).toBeUndefined();
    expect(
      monoCodeToolCall(shell("monocode app help memory extra")),
    ).toBeUndefined();
    expect(monoCodeToolCall(shell("monocode app --help"))?.label).toBe(
      "View CLI commands",
    );
  });
});
