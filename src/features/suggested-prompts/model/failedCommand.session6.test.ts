import { describe, expect, it } from "vitest";
import { applyHarnessEvents } from "../../../integrations/harness/core/apply";
import { mapCodexNotification } from "../../../integrations/harness/providers/codex/codexProtocol";
import { bashCommandField } from "../../../integrations/harness/providers/claude/claudeProtocol";
import { newSession, type Block } from "../../sessions/model/session";
import { commandLine, suggestPrompts } from "./suggestions";

// 2.19: the failing-command chip quoted the row's label ("List
// ~/nope-missing-dir"), not the command (`ls ~/nope-missing-dir`).

const user: Block = { id: "u", role: "user", text: "go" };

function chipPrompt(blocks: Block[]): string | undefined {
  return suggestPrompts({
    blocks,
    busy: false,
    hasDraft: false,
    state: { changes: null },
  }).find((chip) => chip.id === "failed-command")?.prompt;
}

describe("failing-command chip", () => {
  it("quotes the raw command, not the row's label", () => {
    const failed: Block = {
      id: "c",
      role: "tool",
      text: "List ~/nope-missing-dir",
      tool: {
        kind: "execute",
        status: "failed",
        title: "List ~/nope-missing-dir",
        command: "ls ~/nope-missing-dir",
      },
    };
    expect(chipPrompt([user, failed])).toBe(
      "The last command failed: `ls ~/nope-missing-dir`. Find out why and fix it.",
    );
  });

  it("falls back to the label when the harness gave no command", () => {
    const failed: Block = {
      id: "c",
      role: "tool",
      text: "npm test",
      tool: { kind: "execute", status: "failed", title: "npm test" },
    };
    expect(commandLine(failed)).toBe("npm test");
  });

  it("keeps a file name with spaces and a leading dash, backticks swapped", () => {
    const failed: Block = {
      id: "c",
      role: "tool",
      text: "Read file",
      tool: {
        kind: "execute",
        status: "failed",
        title: "Read -notes.md",
        command: "cat -- '-my notes.md' `x`",
      },
    };
    expect(chipPrompt([user, failed])).toContain("`cat -- '-my notes.md' 'x'`");
  });

  it("joins a multi-line command onto one line", () => {
    const failed: Block = {
      id: "c",
      role: "tool",
      text: "Shell",
      tool: {
        kind: "execute",
        status: "error",
        command: "cd repo &&\n  make test",
      },
    };
    expect(commandLine(failed)).toBe("cd repo && make test");
  });
});

describe("the raw command is kept on the block", () => {
  it("from a Codex commandExecution item", () => {
    const item = {
      id: "cmd_1",
      type: "commandExecution",
      command: "ls ~/nope-missing-dir",
      commandActions: [{ type: "listFiles", path: "~/nope-missing-dir" }],
    };
    const started = mapCodexNotification("item/started", {
      item: { ...item, status: "inProgress" },
    }).events;
    const done = mapCodexNotification("item/completed", {
      item: { ...item, status: "failed", exitCode: 2 },
    }).events;
    expect(started[0]).toMatchObject({ command: "ls ~/nope-missing-dir" });
    let session = newSession("/tmp/no commits");
    session = applyHarnessEvents(session, [...started, ...done]);
    const block = session.blocks.find((b) => b.role === "tool")!;
    expect(block.tool?.title).toMatch(/^List /);
    expect(block.tool?.command).toBe("ls ~/nope-missing-dir");
    expect(chipPrompt([user, block])).toContain("`ls ~/nope-missing-dir`");
  });

  it("from a Codex argv command run through a wrapper shell", () => {
    const events = mapCodexNotification("item/started", {
      item: {
        id: "cmd_2",
        type: "commandExecution",
        command: ["/bin/zsh", "-lc", "ls ~/nope-missing-dir"],
        status: "inProgress",
      },
    }).events;
    expect(events[0]).toMatchObject({ command: "ls ~/nope-missing-dir" });
  });

  it("from a Claude Code Bash call's input.command", () => {
    expect(bashCommandField("Bash", { command: " ls ~/nope " })).toEqual({
      command: "ls ~/nope",
    });
    expect(bashCommandField("Read", { command: "ls" })).toEqual({});
    expect(bashCommandField("Bash", { command: 7 })).toEqual({});
    let session = newSession("/tmp");
    session = applyHarnessEvents(session, [
      {
        type: "tool.started",
        callId: "t1",
        title: "List ~/nope",
        kind: "execute",
        status: "pending",
        ...bashCommandField("Bash", { command: "ls ~/nope" }),
      },
      { type: "tool.updated", callId: "t1", status: "failed" },
    ]);
    const block = session.blocks.find((b) => b.role === "tool")!;
    expect(block.tool?.command).toBe("ls ~/nope");
    expect(block.tool?.status).toBe("failed");
  });
});
