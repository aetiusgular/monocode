import { describe, expect, it } from "vitest";
import { prContentFromRange } from "./prFallback";

const range = (commitSummary: string) => ({
  base: "main",
  head: "s7r2-pr1",
  commitSummary,
  diffSummary: " README.md | 2 +-\n 1 file changed",
  diffPatch: "",
});

describe("prContentFromRange", () => {
  it("keeps a subject whose first word is made of hex letters (Mac test 4.4)", () => {
    expect(
      prContentFromRange(range("Add a retest line to the README")).title,
    ).toBe("Add a retest line to the README");
    for (const subject of [
      "Fade out the toast",
      "a fix",
      "Deface 12 icons",
      "Bad link in docs",
    ]) {
      expect(prContentFromRange(range(subject)).title).toBe(subject);
    }
  });

  it("titles from the newest subject and lists every commit in the body", () => {
    const content = prContentFromRange(range("Add tests\nFix the parser"));
    expect(content.title).toBe("Add tests");
    expect(content.body).toContain("## Commits\n\nAdd tests\nFix the parser");
    expect(content.body).toContain("## Changes");
    expect(content.head).toBe("s7r2-pr1");
    expect(content.base).toBe("main");
  });

  it("falls back to the branch when there is no subject", () => {
    expect(prContentFromRange(range("  ")).title).toBe("Changes on s7r2-pr1");
  });
});
