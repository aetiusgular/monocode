import { describe, expect, it } from "vitest";
import { marksNotAnIssue, parseFindingLines } from "./findings";

describe("Mac fix 4.9: findings the model marks as not an issue", () => {
  it("drops the thinking-aloud line from the Mac run", () => {
    const output = [
      "README.md:14: The heading follows a list without a blank line before it? No, that's fine. Checking…",
      "src/calc.py:7: Division by zero when `b` is 0; guard it or raise ValueError.",
    ].join("\n");
    expect(parseFindingLines(output)).toEqual([
      {
        path: "src/calc.py",
        line: 7,
        comment:
          "Division by zero when `b` is 0; guard it or raise ValueError.",
      },
    ]);
  });

  it("drops plain verdicts that there is nothing to fix", () => {
    for (const comment of [
      "No issue here.",
      "Looks correct.",
      "Checked the loop bounds. That's fine.",
      "Is the import unused? Not a problem.",
      "The early return skips cleanup? No, it's correct. Moving on...",
    ]) {
      expect(marksNotAnIssue(comment), comment).toBe(true);
    }
  });

  it("never drops a real finding", () => {
    for (const comment of [
      "Off-by-one: the loop skips the last item.",
      "That's fine for an empty list but fails for one item.",
      "Looks correct, however `total` is never reset between calls.",
      "No, that's fine. Actually the file name with a leading dash is passed to rm without --.",
      "No error handling when the folder is not a git repository.",
      "Not thread safe: two calls can write the same temp file.",
      "This looks fine on macOS but breaks on paths with spaces.",
      "Is `-rf` meant to delete the home folder? This runs on $HOME.",
    ]) {
      expect(marksNotAnIssue(comment), comment).toBe(false);
    }
    expect(
      parseFindingLines(
        "- `my file.py:3`: No error handling when the folder is not a git repository.",
      ),
    ).toHaveLength(1);
  });

  it("still needs the file:line prefix and a claim", () => {
    expect(parseFindingLines("Hmm, let me check the README first.")).toEqual(
      [],
    );
    expect(parseFindingLines("README.md:3:   ")).toEqual([]);
  });
});
