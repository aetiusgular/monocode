import { describe, expect, it } from "vitest";
import {
  commandMatchesRule,
  deriveCommandRule,
  parseCommandRule,
  shellWords,
} from "./commandRules";

const gitLog = parseCommandRule("git log *")!;

describe("shell words under zsh (R1)", () => {
  it("refuses words zsh can turn into a command", () => {
    for (const command of [
      "git log *(e:id:)",
      "git log a(e:id:)",
      "git log =id",
      "git log ''=id",
      "git log a(b)",
      "git log ^foo",
      "git log foo~",
      "git log ~",
      "git log {a,b}",
      "git log $'x'",
      "git log a#b",
      "git log !!",
      "git log foo!",
      'git log "a!b"',
      'git log "a\\b"',
      "git log 'a''b'",
    ]) {
      expect(shellWords(command), command).toBeNull();
      expect(commandMatchesRule(command, gitLog), command).toBe(false);
      expect(deriveCommandRule(command), command).toEqual({
        kind: "exact",
        command,
      });
    }
  });

  it("keeps plain words, quotes and escapes", () => {
    expect(shellWords("git log --format=%h,%an src/a.ts")).toEqual([
      "git",
      "log",
      "--format=%h,%an",
      "src/a.ts",
    ]);
    expect(shellWords("git log -- 'my (notes)!.txt' \"x y\" a\\(b")).toEqual([
      "git",
      "log",
      "--",
      "my (notes)!.txt",
      "x y",
      "a(b",
    ]);
    expect(shellWords("git log a=b \\=id")).toEqual([
      "git",
      "log",
      "a=b",
      "=id",
    ]);
    expect(commandMatchesRule("git log -5 --oneline", gitLog)).toBe(true);
    expect(commandMatchesRule("git log -- 'file (1).txt'", gitLog)).toBe(true);
    expect(commandMatchesRule("git log user@host:x", gitLog)).toBe(true);
  });
});
