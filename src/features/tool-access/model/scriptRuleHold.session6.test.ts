import { describe, expect, it } from "vitest";
import { parseCommandRule } from "./commandRules";
import {
  ruleHeldToProjectScripts,
  type RuleGateInvoke,
} from "./commandRuleGate";

const project =
  (files: Record<string, unknown> | Error): RuleGateInvoke =>
  async <T>() => {
    if (files instanceof Error) throw files;
    return files as T;
  };
const withScripts = project({
  packageJson: JSON.stringify({ scripts: { dev: "vite", test: "vitest" } }),
});
const rule = (text: string) => parseCommandRule(text)!;

describe("a run prefix only for the project's own scripts (R4)", () => {
  it("keeps a prefix for a script package.json has", async () => {
    expect(
      await ruleHeldToProjectScripts(
        rule("yarn run dev *"),
        "yarn run dev --port 3000",
        "/repo",
        withScripts,
      ),
    ).toEqual({ kind: "prefix", prefix: "yarn run dev" });
    expect(
      await ruleHeldToProjectScripts(
        rule("npm test *"),
        "npm test",
        "/repo",
        withScripts,
      ),
    ).toEqual({ kind: "prefix", prefix: "npm test" });
  });

  it("keeps an exact rule when the name is a dependency's program", async () => {
    for (const [suggested, command] of [
      ["yarn run node *", "yarn run node x.js"],
      ["yarn run tsx *", "yarn run tsx src/a.ts"],
      ["pnpm run exec *", "pnpm run exec ls"],
      ["pnpm lint *", "pnpm lint"],
      ["npm run constructor *", "npm run constructor"],
    ]) {
      expect(
        await ruleHeldToProjectScripts(
          rule(suggested),
          command,
          "/repo",
          withScripts,
        ),
        suggested,
      ).toEqual({ kind: "exact", command });
    }
  });

  it("keeps an exact rule when package.json is missing or unreadable", async () => {
    for (const files of [
      {},
      { packageJson: "{" },
      { skipped: ["package.json is not a file"] },
      new Error("not a folder"),
    ]) {
      expect(
        await ruleHeldToProjectScripts(
          rule("npm run dev *"),
          "npm run dev",
          "/repo",
          project(files),
        ),
      ).toEqual({ kind: "exact", command: "npm run dev" });
    }
  });

  it("leaves other rules alone without reading anything", async () => {
    const never: RuleGateInvoke = async () => {
      throw new Error("read");
    };
    for (const text of ["git log *", "cargo test *", "pytest *", "ls -la"]) {
      expect(
        await ruleHeldToProjectScripts(rule(text), text, "/repo", never),
      ).toEqual(rule(text));
    }
  });
});
