import { describe, expect, it } from "vitest";
import type { BackgroundItem } from "../../../integrations/harness/core/background";
import type { Block } from "../../sessions/model/session";
import {
  harnessListsBackground,
  outputTail,
  plainTerminalText,
  runningElapsed,
  sessionRunningRows,
  transcriptSubagentRows,
} from "./sessionRunning";

const item = (patch: Partial<BackgroundItem> = {}): BackgroundItem => ({
  id: "t1",
  kind: "shell",
  title: "npm test",
  status: "running",
  stoppable: true,
  source: "harness",
  ...patch,
});

const agentBlock = (id: string, status: string, name?: string): Block => ({
  id,
  role: "tool",
  text: "Explore the repo",
  tool: { callId: id, kind: "agent", title: "Agent", status },
  ...(name ? { agentRun: { name } } : {}),
} as Block);

describe("transcriptSubagentRows", () => {
  it("lists subagents still at work, which stop only with the turn", () => {
    const rows = transcriptSubagentRows([
      agentBlock("a1", "in_progress", "explorer"),
      agentBlock("a2", "completed"),
      { id: "x", role: "tool", text: "ls", tool: { kind: "execute", status: "in_progress" } },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: "transcript:a1",
        kind: "subagent",
        title: "explorer",
        stop: "turn",
        stoppable: false,
        blockId: "a1",
      }),
    ]);
  });
});

describe("sessionRunningRows", () => {
  it("lists Claude's pushed items as stoppable by the harness", () => {
    const rows = sessionRunningRows({
      harness: "claude",
      pushed: [item()],
      blocks: [],
    });
    expect(rows).toEqual([
      expect.objectContaining({ id: "t1", stop: "harness", stoppable: true }),
    ]);
  });

  it("lists Codex's polled terminals as stoppable by the harness", () => {
    const rows = sessionRunningRows({
      harness: "codex",
      polled: [item({ id: "42", title: "npm run dev" })],
      blocks: [],
    });
    expect(rows[0]).toMatchObject({ id: "42", stop: "harness" });
  });

  it("never offers a stop the harness's table does not declare (corner case 11)", () => {
    // OpenCode has no background stop in the capability table.
    const rows = sessionRunningRows({
      harness: "opencode",
      pushed: [item()],
      blocks: [],
    });
    expect(rows[0]).toMatchObject({ stop: "turn", stoppable: false });
  });

  it("falls back to transcript subagents only when the harness reported none", () => {
    const blocks = [agentBlock("a1", "in_progress")];
    expect(
      sessionRunningRows({ harness: "grok", blocks }).map((row) => row.kind),
    ).toEqual(["subagent"]);
    const withHarnessAgent = sessionRunningRows({
      harness: "claude",
      pushed: [item({ id: "s1", kind: "subagent", title: "explorer" })],
      blocks,
    });
    expect(withHarnessAgent.map((row) => row.id)).toEqual(["s1"]);
  });

  it("puts MonoCode's own processes beside the harness's and keeps keys apart", () => {
    const rows = sessionRunningRows({
      harness: "claude",
      pushed: [item({ id: "same" })],
      owned: [item({ id: "same", kind: "server", source: "monocode" })],
      blocks: [],
    });
    expect(rows.map((row) => `${row.source}:${row.stop}`).sort()).toEqual([
      "harness:harness",
      "monocode:monocode",
    ]);
  });

  it("shows a row the user stopped as stopping until it goes", () => {
    const rows = sessionRunningRows({
      harness: "claude",
      pushed: [item()],
      blocks: [],
      stopping: new Set(["harness:t1"]),
    });
    expect(rows[0].status).toBe("stopping");
  });

  it("is empty when nothing runs, so the section hides", () => {
    expect(sessionRunningRows({ harness: "codex", polled: null, blocks: [] })).toEqual([]);
  });
});

describe("harnessListsBackground", () => {
  it("asks only harnesses whose table says they list", () => {
    expect(harnessListsBackground("codex")).toBe(true);
    expect(harnessListsBackground("cursor")).toBe(false);
  });
});

describe("runningElapsed", () => {
  it("reads like a clock", () => {
    expect(runningElapsed(undefined, 10)).toBe("");
    expect(runningElapsed(1_000, 13_000)).toBe("12s");
    expect(runningElapsed(0 + 1, 4 * 60_000 + 1)).toBe("4m");
    expect(runningElapsed(1, 2 * 3_600_000 + 5 * 60_000 + 1)).toBe("2h 5m");
    expect(runningElapsed(1, 3_600_000 + 1)).toBe("1h");
    expect(runningElapsed(5_000, 1_000)).toBe("");
  });
});

describe("output helpers", () => {
  it("keeps the tail of a long log", () => {
    expect(outputTail("abcdef", 3)).toEqual({ text: "def", cut: true });
    expect(outputTail("ab", 3)).toEqual({ text: "ab", cut: false });
  });

  it("strips colour and cursor codes and keeps redrawn lines' last state", () => {
    expect(
      plainTerminalText(
        "\u001b[32mready\u001b[0m on :5173\r\n10%\r50%\r100%\r\n\u001b]0;title\u0007done\r",
      ),
    ).toBe("ready on :5173\n100%\ndone");
  });
});
