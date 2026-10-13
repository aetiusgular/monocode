import { describe, expect, it } from "vitest";
import { applyHarnessEvents } from "../../../integrations/harness/core/apply";
import { mapCodexNotification } from "../../../integrations/harness/providers/codex/codexProtocol";
import { newSession, type Block } from "../../sessions/model/session";
import { suggestPrompts } from "./suggestions";

// Mac 1.11 / 11.T2.1: only a command that ran and exited non-zero raises
// "Fix the failing command". The Claude Code cases are in
// claudeRefusedCalls.session6.test.ts.

const user: Block = { id: "u", role: "user", text: "go" };
const ids = (blocks: Block[]) =>
  suggestPrompts({
    blocks,
    busy: false,
    hasDraft: false,
    state: { changes: null },
  }).map((chip) => chip.id);

function codexCommand(status: string, exitCode?: number): Block {
  const item = {
    id: "cmd_1",
    type: "commandExecution",
    command: ["/Users/tony/.codex-home/bin/sh", "-lc", "rm -- '-x file'"],
  };
  const events = [
    ...mapCodexNotification("item/started", {
      item: { ...item, status: "inProgress" },
    }).events,
    ...mapCodexNotification("item/completed", {
      item: { ...item, status, ...(exitCode != null ? { exitCode } : {}) },
    }).events,
  ];
  const session = applyHarnessEvents(newSession("/Users/tony"), events);
  return session.blocks.find((block) => block.role === "tool")!;
}

describe("the failing-command chip", () => {
  it("is not raised for a Codex command a Never rule declined", () => {
    const block = codexCommand("declined");
    expect(block.tool?.status).toBe("cancelled");
    expect(ids([user, block])).not.toContain("failed-command");
  });

  it("is raised for a Codex command that ran and exited non-zero", () => {
    const block = codexCommand("failed", 1);
    expect(block.tool?.status).toBe("failed");
    expect(ids([user, block])).toContain("failed-command");
  });

  it("is not raised for a call declined on its card", () => {
    const block: Block = {
      id: "c",
      role: "tool",
      text: "Run npm test",
      tool: { kind: "execute", status: "failed", command: "npm test" },
      approval: { requestId: 3, decided: "deny" },
    };
    expect(ids([user, block])).not.toContain("failed-command");
  });

  it("is not raised for a stopped call", () => {
    const block: Block = {
      id: "c",
      role: "tool",
      text: "seq 1 3000",
      tool: { kind: "execute", status: "cancelled", background: true },
    };
    expect(ids([user, block])).not.toContain("failed-command");
  });
});
