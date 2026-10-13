import { describe, expect, it } from "vitest";
import type { Block, Session } from "./session";
import { EMPTY_TURN_NOTICE, withEmptyTurnNotice } from "./emptyTurn";

const session = (blocks: Block[]) => ({ id: "s", blocks }) as unknown as Session;
const user: Block = { id: "u", role: "user", text: "svg of a red circle" };

describe("an empty finished turn says so (Mac finding 3.7)", () => {
  it("adds a notice when nothing came after the prompt", () => {
    const next = withEmptyTurnNotice(session([user]));
    expect(next.blocks.at(-1)?.text).toBe(EMPTY_TURN_NOTICE);
    expect(next.blocks.at(-1)?.notice).toBe("error");
  });

  it("counts an empty assistant block and a status line as nothing", () => {
    const next = withEmptyTurnNotice(
      session([
        user,
        { id: "a", role: "assistant", text: "  " },
        { id: "st", role: "system", text: "Working" },
      ]),
    );
    expect(next.blocks.at(-1)?.text).toBe(EMPTY_TURN_NOTICE);
  });

  it("leaves a turn with a reply, a tool call or reasoning alone", () => {
    for (const block of [
      { id: "a", role: "assistant", text: "ok" },
      { id: "t", role: "tool", text: "" },
      { id: "r", role: "reasoning", text: "thinking" },
    ] as Block[]) {
      const before = session([user, block]);
      expect(withEmptyTurnNotice(before)).toBe(before);
    }
  });

  it("adds it once, and only for the last turn", () => {
    const once = withEmptyTurnNotice(session([user]));
    expect(withEmptyTurnNotice(once)).toBe(once);
    const earlier = session([user, { id: "a", role: "assistant", text: "" }, { ...user, id: "u2" }, { id: "b", role: "assistant", text: "hi" }]);
    expect(withEmptyTurnNotice(earlier)).toBe(earlier);
  });

  it("adds nothing when an error already explains the turn", () => {
    const failed = session([user, { id: "e", role: "system", text: "Codex exited", notice: "error" }]);
    expect(withEmptyTurnNotice(failed)).toBe(failed);
  });

  it("does nothing on a chat with no prompt", () => {
    const empty = session([]);
    expect(withEmptyTurnNotice(empty)).toBe(empty);
  });
});
