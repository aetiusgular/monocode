import { describe, expect, it } from "vitest";
import { HARNESS_LABEL, type HarnessId } from "../../sessions/model/session";
import {
  harnessOffersPickUp,
  pickUpEmpty,
  pickUpError,
  pickUpImportsTurns,
  pickUpNote,
  pickUpRows,
} from "./pickUp";

const ALL = Object.keys(HARNESS_LABEL) as HarnessId[];

describe("harnessOffersPickUp", () => {
  it("is offered for Claude Code and Codex only, from the capability table", () => {
    expect(ALL.filter(harnessOffersPickUp).sort()).toEqual(["claude", "codex"]);
  });

  it("copies turns only where the harness can replay them", () => {
    expect(pickUpImportsTurns("codex")).toBe(true);
    expect(pickUpImportsTurns("claude")).toBe(false);
    expect(pickUpImportsTurns("cursor")).toBe(false);
  });
});

describe("pickUpRows", () => {
  it("marks rows already bound to a chat", () => {
    expect(
      pickUpRows(
        [
          { id: "a", title: "A", updatedAt: 2 },
          { id: "b", title: "B", updatedAt: 1 },
        ],
        new Map([["b", "chat-b"]]),
      ),
    ).toEqual([
      { id: "a", title: "A", updatedAt: 2 },
      { id: "b", title: "B", updatedAt: 1, boundTo: "chat-b" },
    ]);
  });
});

describe("pickUp text", () => {
  it("says what happens on each harness", () => {
    expect(pickUpNote("codex")).toMatch(/^Earlier turns are copied in as text\./);
    expect(pickUpNote("claude")).toMatch(/^Earlier turns stay with Claude Code/);
    expect(pickUpEmpty("codex")).toBe("No Codex sessions recorded in this folder.");
  });

  it("puts an error on one bounded line", () => {
    expect(pickUpError("codex", new Error("a\n  b"))).toBe(
      "Codex could not list its sessions: a b",
    );
    expect(pickUpError("claude", "x".repeat(500)).length).toBeLessThan(360);
    expect(pickUpError("codex", undefined)).toBe(
      "Codex could not list its sessions: Unknown error",
    );
  });
});
