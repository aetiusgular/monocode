import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { failedTurnSessions, lastTurnError } from "./sessionDone";

const user = (id: string): Block => ({ id, role: "user", text: "Run the tests" });
const error = (text: string): Block => ({
  id: `e-${text}`,
  role: "system",
  text,
  notice: "error",
});

describe("lastTurnError (Mac test 2.16)", () => {
  it("finds the error the last turn ended with", () => {
    expect(
      lastTurnError([user("u1"), error("fatal: Needed a single revision")]),
    ).toBe("fatal: Needed a single revision");
  });

  it("ignores an error from an earlier turn", () => {
    expect(
      lastTurnError([
        user("u1"),
        error("old"),
        user("u2"),
        { id: "a", role: "assistant", text: "ok" },
      ]),
    ).toBeUndefined();
  });

  it("ignores a stop and a plain status line", () => {
    expect(
      lastTurnError([
        user("u1"),
        { id: "s", role: "system", text: "Stopped", notice: "interrupt" },
        { id: "t", role: "system", text: "note" },
      ]),
    ).toBeUndefined();
  });

  it("looks past an internal prompt to the user's", () => {
    expect(
      lastTurnError([
        user("u1"),
        error("boom"),
        { id: "i", role: "user", text: "internal", internal: true } as Block,
      ]),
    ).toBe("boom");
  });
});

describe("failedTurnSessions", () => {
  it("lists idle chats whose last turn failed, never busy ones", () => {
    const failed = failedTurnSessions([
      { id: "a", busy: false, blocks: [user("u"), error("fatal: Needed a single revision")] },
      { id: "b", busy: true, blocks: [user("u"), error("x")] },
      { id: "c", busy: false, blocks: [user("u"), { id: "r", role: "assistant", text: "done" }] },
    ]);
    expect([...failed]).toEqual([["a", "fatal: Needed a single revision"]]);
  });
});
