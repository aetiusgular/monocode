import { describe, expect, it } from "vitest";
import {
  parseGeneratedSessionTitle,
  sanitizeThreadTitle,
} from "./sessionTitle";
import {
  parseCommitMessage,
  sanitizeCommitSubject,
} from "../../source-control/model/gitText";

describe("Mac fix 4.1: labels a small model puts on a title", () => {
  it("strips Title:, title -, quotes, headings and bold", () => {
    for (const raw of [
      "Title: Purpose of calc.py",
      "title - Purpose of calc.py",
      'Title: "Purpose of calc.py"',
      "# Purpose of calc.py",
      "## Title: Purpose of calc.py",
      "**Purpose of calc.py**",
      "**Title:** Purpose of calc.py",
      "“Purpose of calc.py”",
    ]) {
      expect(sanitizeThreadTitle(raw), raw).toBe("Purpose of calc.py");
    }
  });

  it("keeps titles that only start with the word", () => {
    expect(sanitizeThreadTitle("Title-case helper for --flags")).toBe(
      "Title-case helper for --flags",
    );
    expect(sanitizeThreadTitle("Titles in my repo")).toBe("Titles in my repo");
    expect(sanitizeThreadTitle("Fix #12 in -dash file.py")).toBe(
      "Fix #12 in -dash file.py",
    );
  });

  it("cleans the bare answer and the JSON one", () => {
    expect(
      parseGeneratedSessionTitle(
        "Title: Purpose of calc.py",
        "what is calc.py for",
      )?.title,
    ).toBe("Purpose of calc.py");
    expect(
      parseGeneratedSessionTitle('{"title":"Title: Purpose of calc.py"}', "x")
        ?.title,
    ).toBe("Purpose of calc.py");
  });
});

describe("Mac fix 4.1: labels on a commit subject", () => {
  it("strips a leading Commit message:", () => {
    expect(sanitizeCommitSubject("Commit message: Add calc tests")).toBe(
      "Add calc tests",
    );
    expect(sanitizeCommitSubject("**Commit message:** Add calc tests.")).toBe(
      "Add calc tests",
    );
    expect(sanitizeCommitSubject('commit: "Add calc tests"')).toBe(
      "Add calc tests",
    );
    expect(
      parseCommitMessage(
        '{"subject":"Commit message: Add calc tests","body":""}',
      )?.subject,
    ).toBe("Add calc tests");
  });

  it("keeps a subject about commits", () => {
    expect(sanitizeCommitSubject("Commit hooks run before push")).toBe(
      "Commit hooks run before push",
    );
  });
});
