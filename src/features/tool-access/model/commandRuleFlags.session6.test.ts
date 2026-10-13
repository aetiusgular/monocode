import { describe, expect, it } from "vitest";
import {
  commandMatchesRule,
  deriveCommandRule,
  shellWords,
  type CommandRule,
} from "./commandRules";
import { allowForChatPlan } from "../ui/AllowForChatButton";

/**
 * Security fix F1: a prefix rule kept by "Allow for this chat" let later
 * commands add flags that run a program, write a file or load config.
 */

const prefix = (p: string): CommandRule => ({ kind: "prefix", prefix: p });

describe("a prefix rule refuses flags that run, write or load config (F1)", () => {
  it("git grep: the pager flag never passes", () => {
    const rule = deriveCommandRule("git grep foo");
    expect(rule).toEqual(prefix("git grep"));
    for (const command of [
      "git grep --open-files-in-pager='touch /tmp/PWNED; true' hello",
      "git grep --open-files-in-pager='touch /tmp/PWNED' hello",
      "git grep -O'sh -c id' foo",
      "git grep -O foo",
      "git grep --open foo",
      "git grep foo --textconv",
    ]) {
      expect(commandMatchesRule(command, rule!), command).toBe(false);
    }
    // Plain searches still pass.
    for (const command of [
      "git grep foo",
      "git grep -n -i foo",
      "git grep -c foo",
      "git grep -e 'a b' -- src",
      'git grep "my pattern" -- "notes file.txt"',
    ]) {
      expect(commandMatchesRule(command, rule!), command).toBe(true);
    }
  });

  it("git log, git diff and git show refuse --output and external diff", () => {
    expect(
      commandMatchesRule(
        "git log --output=/home/u/.bashrc",
        deriveCommandRule("git log --oneline")!,
      ),
    ).toBe(false);
    expect(
      commandMatchesRule("git log --output /home/u/.bashrc", prefix("git log")),
    ).toBe(false);
    expect(commandMatchesRule("git diff --ext-diff", prefix("git diff"))).toBe(
      false,
    );
    expect(commandMatchesRule("git show --textconv", prefix("git show"))).toBe(
      false,
    );
    expect(commandMatchesRule("git log -5 --oneline", prefix("git log"))).toBe(
      true,
    );
    expect(commandMatchesRule("git diff --cached", prefix("git diff"))).toBe(
      true,
    );
  });

  it("cargo refuses --config and -Z", () => {
    const rule = deriveCommandRule("cargo test");
    expect(rule).toEqual(prefix("cargo test"));
    expect(
      commandMatchesRule(
        `cargo test --config 'target."cfg(all())".runner="/bin/sh"'`,
        rule!,
      ),
    ).toBe(false);
    expect(commandMatchesRule("cargo test -Zbuild-std", rule!)).toBe(false);
    expect(commandMatchesRule("cargo test --release parse", rule!)).toBe(true);
    expect(
      commandMatchesRule("cargo fmt -- --check", prefix("cargo fmt")),
    ).toBe(false);
    expect(commandMatchesRule("cargo fmt --check", prefix("cargo fmt"))).toBe(
      true,
    );
  });

  it("npm test refuses --script-shell and flags after --", () => {
    const rule = prefix("npm test");
    expect(commandMatchesRule("npm test --script-shell=/tmp/x", rule)).toBe(
      false,
    );
    expect(commandMatchesRule("npm test --prefix /tmp/x", rule)).toBe(false);
    expect(
      commandMatchesRule("npm test --node-options=--require=/tmp/x", rule),
    ).toBe(false);
    expect(commandMatchesRule("npm test -- --watch", rule)).toBe(false);
    expect(commandMatchesRule("npm test -- src/a.test.ts", rule)).toBe(true);
    expect(commandMatchesRule("npm test", rule)).toBe(true);
  });

  it("an npx prefix never passes a later command", () => {
    expect(
      commandMatchesRule("npx vitest --package=evil", prefix("npx vitest")),
    ).toBe(false);
    expect(commandMatchesRule("npx vitest run", prefix("npx vitest"))).toBe(
      false,
    );
    expect(deriveCommandRule("npx vitest run")).toEqual({
      kind: "exact",
      command: "npx vitest run",
    });
  });

  it("never derives a prefix for git subcommands that write config or run hooks", () => {
    for (const command of [
      "git config --list",
      "git submodule status",
      "git filter-branch --help",
      "git hook run pre-commit",
      "git lg",
      "git commit -m x",
      "git push",
      "git checkout main",
    ]) {
      expect(deriveCommandRule(command), command).toEqual({
        kind: "exact",
        command,
      });
    }
    expect(
      commandMatchesRule(
        "git config --global core.fsmonitor 'sh -c id'",
        prefix("git config"),
      ),
    ).toBe(false);
  });

  it("git branch lists only", () => {
    const rule = deriveCommandRule("git branch");
    expect(rule).toEqual(prefix("git branch"));
    expect(commandMatchesRule("git branch -a", rule!)).toBe(true);
    expect(commandMatchesRule("git branch --list 'feat*'", rule!)).toBe(true);
    expect(commandMatchesRule("git branch newname", rule!)).toBe(false);
    expect(commandMatchesRule("git branch -D main", rule!)).toBe(false);
    expect(commandMatchesRule("git branch -m a b", rule!)).toBe(false);
  });

  it("refuses words the shell could turn into flags", () => {
    const rule = prefix("git diff");
    // `$X` or a glob could expand to `--output=...`.
    expect(commandMatchesRule("git diff $X", rule)).toBe(false);
    expect(commandMatchesRule('git diff "$X"', rule)).toBe(false);
    expect(commandMatchesRule("git diff *", rule)).toBe(false);
    expect(commandMatchesRule("git diff {--output=x,y}", rule)).toBe(false);
    expect(commandMatchesRule("git diff 'a b", rule)).toBe(false);
    // A quoted flag is still a flag.
    expect(commandMatchesRule("git diff '--ext-diff'", rule)).toBe(false);
    expect(commandMatchesRule('git diff "--output=x"', rule)).toBe(false);
    expect(commandMatchesRule("git diff \\--output=x", rule)).toBe(false);
    // File names with spaces are fine; a leading dash after `--` asks.
    expect(commandMatchesRule('git diff -- "my notes.txt"', rule)).toBe(true);
    expect(commandMatchesRule("git diff -- '-notes.txt'", rule)).toBe(false);
    expect(shellWords(`a 'b c' "d\\"e" f\\ g`)).toEqual([
      "a",
      "b c",
      'd"e',
      "f g",
    ]);
  });

  it("pytest refuses plugins and config", () => {
    const rule = deriveCommandRule("python3 -m pytest -q tests");
    expect(rule).toEqual(prefix("python3 -m pytest"));
    expect(commandMatchesRule("python3 -m pytest -p evil", rule!)).toBe(false);
    expect(commandMatchesRule("python3 -m pytest -c /tmp/x.ini", rule!)).toBe(
      false,
    );
    expect(commandMatchesRule("python3 -m pytest -x tests/a.py", rule!)).toBe(
      true,
    );
  });

  it("the button names the rule itself", () => {
    const plan = allowForChatPlan({
      requestId: 1,
      tool: { key: "Bash", label: "Bash" },
      chatRule: { key: "Bash(git grep *)", label: "Bash: git grep commands" },
    });
    expect(plan?.prefix).toBe("git grep");
    const exact = allowForChatPlan({
      requestId: 1,
      tool: { key: "Bash", label: "Bash" },
      chatRule: { key: "Bash(seq 1 3)", label: "Bash: the command seq 1 3" },
    });
    expect(exact?.prefix).toBeUndefined();
    expect(exact?.exact).toBe(true);
  });
});
