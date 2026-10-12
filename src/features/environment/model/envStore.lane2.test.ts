import { describe, expect, it } from "vitest";
import { envNameProblem, envNote } from "./envStore";

describe("#28: environment names", () => {
  it("refuses the names Rust refuses (corner case 12)", () => {
    for (const name of [
      "PATH",
      "home",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_HOME",
      "MONOCODE_APP_TOKEN",
      "DYLD_INSERT_LIBRARIES",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "1ABC",
      "A-B",
      "A B",
      "",
    ])
      expect(envNameProblem(name), name).toBeDefined();
    for (const name of ["DATABASE_URL", "_X", "gh_token2"])
      expect(envNameProblem(name), name).toBeUndefined();
    expect(envNameProblem("ANTHROPIC_API_KEY")).toContain("Providers");
  });

  it("says what reaches each harness's tools (corner case 11)", () => {
    expect(envNote("codex")).toContain("MCP servers do not");
    expect(envNote("hermes")).toContain("OPENAI_API_KEY");
    expect(envNote("cursor")).toContain("not known");
  });
});
