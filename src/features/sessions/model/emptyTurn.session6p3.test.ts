import { describe, expect, it } from "vitest";
import type { Block, Session } from "./session";
import {
  EMPTY_TURN_NOTICE,
  stoppedAfterStepsNotice,
  withEmptyTurnNotice,
} from "./emptyTurn";

// Mac 3.7 retest: a turn that ended with only a reasoning item showed
// "Thinking…" and no notice.

const session = (blocks: Block[]) =>
  ({ id: "s", blocks }) as unknown as Session;
const user: Block = { id: "u", role: "user", text: "svg of a red circle" };

describe("a turn that ends with only reasoning", () => {
  it("gets the empty-turn notice", () => {
    const next = withEmptyTurnNotice(
      session([
        user,
        { id: "r", role: "reasoning", text: "I should draw a circle." },
      ]),
    );
    expect(next.blocks.at(-1)?.text).toBe(EMPTY_TURN_NOTICE);
    expect(next.blocks.at(-1)?.notice).toBe("error");
  });

  it("gets it with an empty assistant block beside the reasoning", () => {
    const next = withEmptyTurnNotice(
      session([
        user,
        { id: "r", role: "reasoning", text: "Thinking it over" },
        { id: "a", role: "assistant", text: "" },
      ]),
    );
    expect(next.blocks.at(-1)?.text).toBe(EMPTY_TURN_NOTICE);
  });

  it("is left alone when reasoning is followed by a reply", () => {
    const before = session([
      user,
      { id: "r", role: "reasoning", text: "Plan" },
      { id: "a", role: "assistant", text: "Here it is." },
    ]);
    expect(withEmptyTurnNotice(before)).toBe(before);
  });

  // Changed by design in the 15 Oct fix pass (Mac 3.7, retest 3): reasoning,
  // then a tool call, then nothing is a turn with no reply after its steps.
  it("gets the steps notice when reasoning is followed by a tool call and nothing", () => {
    const next = withEmptyTurnNotice(
      session([
        user,
        { id: "r", role: "reasoning", text: "Plan" },
        { id: "t", role: "tool", text: "write circle.svg" },
      ]),
    );
    expect(next.blocks.at(-1)?.text).toBe(stoppedAfterStepsNotice(1));
  });

  it("is left alone when a stop already explains the turn", () => {
    const stopped = session([
      user,
      { id: "r", role: "reasoning", text: "Plan" },
      { id: "n", role: "system", text: "Stopped", notice: "interrupt" },
    ] as Block[]);
    expect(withEmptyTurnNotice(stopped)).toBe(stopped);
  });
});
