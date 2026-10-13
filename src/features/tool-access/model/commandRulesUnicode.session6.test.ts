import { describe, expect, it } from "vitest";
import {
  commandMatchesRule,
  deriveCommandRule,
  parseCommandRule,
  shellWords,
} from "./commandRules";

// Unicode spaces that JavaScript's trim() drops and bash and zsh pass on as
// word characters (security review S1, 13 Oct).
const UNICODE_SPACES = [
  0xa0, 0x1680, 0x2000, 0x2007, 0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
].map((code) => String.fromCodePoint(code));

describe("Unicode spaces in Bash command rules", () => {
  const branchRule = parseCommandRule("git branch *");
  const exactRule = parseCommandRule("python3 x.py");

  it("keeps the rules this test relies on", () => {
    expect(branchRule).toEqual({ kind: "prefix", prefix: "git branch" });
    expect(exactRule).toEqual({ kind: "exact", command: "python3 x.py" });
  });

  for (const space of UNICODE_SPACES) {
    const code = space.codePointAt(0)!.toString(16);

    it(`git branch with a trailing U+${code} does not match a git branch rule`, () => {
      expect(commandMatchesRule(`git branch ${space}`, branchRule!)).toBe(
        false,
      );
      expect(commandMatchesRule(`git branch${space}`, branchRule!)).toBe(false);
    });

    it(`an exact rule does not match with an added U+${code} argument`, () => {
      expect(commandMatchesRule(`python3 x.py ${space}`, exactRule!)).toBe(
        false,
      );
      expect(commandMatchesRule(`python3 x.py${space}`, exactRule!)).toBe(
        false,
      );
    });

    it(`no rule is kept or derived from text with U+${code}`, () => {
      expect(parseCommandRule(`python3 x.py${space}`)).toBeNull();
      expect(parseCommandRule(`git log${space} *`)).toBeNull();
      expect(deriveCommandRule(`git log ${space}`)).toBeNull();
      expect(shellWords(`git log ${space}`)).toBeNull();
    });
  }

  it("still trims ASCII spaces", () => {
    expect(commandMatchesRule("  python3 x.py  ", exactRule!)).toBe(true);
    expect(commandMatchesRule("git branch --list  ", branchRule!)).toBe(true);
  });

  it("still accepts other non-ASCII text inside quotes", () => {
    expect(shellWords("git log -- 'café.txt'")).toEqual([
      "git",
      "log",
      "--",
      "café.txt",
    ]);
  });
});
