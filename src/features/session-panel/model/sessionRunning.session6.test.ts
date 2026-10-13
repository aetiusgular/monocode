import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { sessionRunningRows } from "./sessionRunning";

const agent = (status: string): Block =>
  ({
    id: "a1",
    role: "tool",
    text: "Create a MonoCode automation",
    tool: { callId: "a1", kind: "agent", title: "Create a MonoCode automation", status },
  }) as Block;

describe("sessionRunningRows after the turn (Mac test 2.17)", () => {
  it("lists a transcript subagent only while the turn runs", () => {
    const blocks = [agent("in_progress")];
    expect(
      sessionRunningRows({ harness: "codex", blocks, busy: true }).map((r) => r.stop),
    ).toEqual(["turn"]);
    expect(sessionRunningRows({ harness: "codex", blocks, busy: false })).toEqual([]);
  });

  it("keeps the old reading when the caller does not say", () => {
    expect(
      sessionRunningRows({ harness: "grok", blocks: [agent("in_progress")] }),
    ).toHaveLength(1);
  });

  it("keeps harness items that outlive the turn", () => {
    const rows = sessionRunningRows({
      harness: "codex",
      blocks: [agent("in_progress")],
      polled: [
        { id: "9", kind: "shell", title: "npm run dev", status: "running", stoppable: true, source: "harness" },
      ],
      busy: false,
    });
    expect(rows.map((r) => [r.kind, r.stop])).toEqual([["shell", "harness"]]);
  });
});
