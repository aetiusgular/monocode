import { describe, expect, it } from "vitest";
import type { Block, Session } from "./session";
import {
  EMPTY_TURN_NOTICE,
  stoppedAfterStepsNotice,
  withEmptyTurnNotice,
} from "./emptyTurn";

// Mac finding 3.7, retest 3 (15 Oct, 5733804): qwen3:8b read hello.py, then
// ended the turn with only a reasoning item (`last_agent_message: None`).
// The chat showed "Read hello.py" and nothing else: no reply, no notice.

const session = (blocks: Block[]) =>
  ({ id: "s", blocks }) as unknown as Session;
const user: Block = { id: "u", role: "user", text: "make the small edit" };
const read: Block = {
  id: "t1",
  role: "tool",
  text: "Read hello.py",
  tool: { callId: "c1", title: "Read hello.py", kind: "read", status: "completed" },
};
const reasoning: Block = { id: "r", role: "reasoning", text: "I should edit it." };

function lastText(s: Session): string | undefined {
  return s.blocks.at(-1)?.text;
}

describe("a turn that stops after its steps without a reply (3.7)", () => {
  it("the Mac's sequence: a read, then reasoning, then finished", () => {
    const next = withEmptyTurnNotice(session([user, read, reasoning]));
    expect(lastText(next)).toBe(
      "The agent ran 1 step, then stopped without a reply. Ask it to continue, or try another model.",
    );
    expect(next.blocks.at(-1)?.notice).toBe("error");
    expect(next.blocks.at(-1)?.role).toBe("system");
    expect(next.blocks).toHaveLength(4);
  });

  it("text, then a tool, then nothing", () => {
    const next = withEmptyTurnNotice(
      session([user, { id: "a", role: "assistant", text: "Let me look." }, read]),
    );
    expect(lastText(next)).toBe(stoppedAfterStepsNotice(1));
  });

  it("counts every tool and approval step in the turn", () => {
    const next = withEmptyTurnNotice(
      session([
        user,
        read,
        { id: "a", role: "assistant", text: "Now the test." },
        { id: "t2", role: "tool", text: "Run pytest" },
        { id: "p", role: "approval", text: "Edit hello.py" },
        { id: "st", role: "system", text: "Working" },
        reasoning,
      ]),
    );
    expect(lastText(next)).toBe(
      "The agent ran 3 steps, then stopped without a reply. Ask it to continue, or try another model.",
    );
  });

  it("status lines and task-list updates after the last tool are not a reply", () => {
    const next = withEmptyTurnNotice(
      session([
        user,
        read,
        { id: "st", role: "system", text: "Status update" },
        { id: "tl", role: "tasks", text: "", taskList: undefined },
      ]),
    );
    expect(lastText(next)).toBe(stoppedAfterStepsNotice(1));
  });

  it("an empty assistant block after the tool is not a reply", () => {
    const next = withEmptyTurnNotice(
      session([user, read, { id: "a", role: "assistant", text: "  " }]),
    );
    expect(lastText(next)).toBe(stoppedAfterStepsNotice(1));
  });

  it("adds it once", () => {
    const once = withEmptyTurnNotice(session([user, read, reasoning]));
    expect(withEmptyTurnNotice(once)).toBe(once);
  });
});

describe("turns that get nothing", () => {
  it("tools, then a reply", () => {
    const before = session([
      user,
      read,
      reasoning,
      { id: "a", role: "assistant", text: "Done: hello.py now says hello." },
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  it("tools, then an image", () => {
    const before = session([
      user,
      read,
      { id: "i", role: "image", text: "" },
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  it("a stopped turn", () => {
    const before = session([
      user,
      read,
      reasoning,
      { id: "n", role: "system", text: "Stopped", notice: "interrupt" },
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  it("a failed turn", () => {
    const before = session([
      user,
      read,
      { id: "e", role: "system", text: "Codex exited", notice: "error" },
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  it("a plan-mode turn ending in a plan", () => {
    const before = session([
      { ...user, intent: "plan" },
      read,
      reasoning,
      { id: "pl", role: "plan", text: "1. Edit hello.py" } as Block,
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  it("a turn ending in a handoff", () => {
    const before = session([
      user,
      read,
      { id: "h", role: "handoff", text: "Handoff" } as Block,
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  it("text, then a task-list update", () => {
    const before = session([
      user,
      { id: "a", role: "assistant", text: "Here is the plan." },
      { id: "tl", role: "tasks", text: "" },
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  it("an earlier turn that stopped after a tool is left as it was", () => {
    const before = session([
      user,
      read,
      { ...user, id: "u2", text: "go on" },
      { id: "a", role: "assistant", text: "Done." },
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  it("the first case still wins when nothing came after the prompt", () => {
    const next = withEmptyTurnNotice(session([user, reasoning]));
    expect(lastText(next)).toBe(EMPTY_TURN_NOTICE);
  });
});
