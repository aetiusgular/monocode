import { describe, expect, it } from "vitest";
import {
  sessionToolsInput,
  sessionToolsSummary,
  withSessionToolsPatch,
} from "../../session-tools/model/harnessInput";
import {
  HARNESSES,
  harnessSupportsSkillSwitches,
} from "../../sessions/model/session";
import { getHarness } from "../../../integrations/harness/core/registry";
import { registerBuiltinHarnesses } from "../../../integrations/harness/core/register";
import {
  MAX_DISABLED_SKILLS,
  chatDisabledSkills,
  chatSkillRows,
  chatSkillsCaveat,
  harnessDisabledSkills,
  sanitizeDisabledSkills,
  setSkillEnabled,
  turnDisabledSkills,
} from "./chatSkills";

describe("sanitizeDisabledSkills", () => {
  it("keeps valid, unique skill names", () => {
    expect(
      sanitizeDisabledSkills([
        "review-pr",
        " deploy ",
        "review-pr",
        "",
        7,
        "Has Caps",
        "trailing-",
        "a b",
        "deploy *",
        "x)",
        "a".repeat(65),
      ]),
    ).toEqual(["review-pr", "deploy"]);
  });

  it("is undefined for anything that is not a list of names", () => {
    expect(sanitizeDisabledSkills(undefined)).toBeUndefined();
    expect(sanitizeDisabledSkills("deploy")).toBeUndefined();
    expect(sanitizeDisabledSkills({ deploy: true })).toBeUndefined();
    expect(sanitizeDisabledSkills([])).toBeUndefined();
    expect(sanitizeDisabledSkills(["--flag"])).toBeUndefined();
  });

  it("stops at the cap", () => {
    const many = Array.from(
      { length: MAX_DISABLED_SKILLS + 10 },
      (_, i) => `s${i}`,
    );
    expect(sanitizeDisabledSkills(many)).toHaveLength(MAX_DISABLED_SKILLS);
  });
});

describe("setSkillEnabled", () => {
  it("switches a skill off and back on", () => {
    expect(setSkillEnabled([], "deploy", false)).toEqual(["deploy"]);
    expect(setSkillEnabled(["deploy", "review"], "deploy", true)).toEqual([
      "review",
    ]);
  });

  it("returns the same list when nothing changes", () => {
    const off = ["deploy"];
    expect(setSkillEnabled(off, "deploy", false)).toBe(off);
    expect(setSkillEnabled(off, "review", true)).toBe(off);
    expect(setSkillEnabled(off, "not a skill", false)).toBe(off);
  });

  it("takes no name past the cap", () => {
    const full = Array.from({ length: MAX_DISABLED_SKILLS }, (_, i) => `s${i}`);
    expect(setSkillEnabled(full, "deploy", false)).toBe(full);
  });
});

describe("which harnesses have the switches", () => {
  it("is every harness that leaves /name to MonoCode", () => {
    // Pi and omp run their own commands; the static list must agree with
    // what their adapters declare.
    registerBuiltinHarnesses();
    for (const harness of HARNESSES) {
      expect([harness, harnessSupportsSkillSwitches(harness)]).toEqual([
        harness,
        !getHarness(harness)?.commands,
      ]);
    }
    expect(harnessSupportsSkillSwitches("pi")).toBe(false);
    expect(harnessSupportsSkillSwitches("claude")).toBe(true);
  });

  it("applies a chat's switched-off skills only there", () => {
    expect(chatDisabledSkills("claude", ["deploy", "deploy", "x y"])).toEqual([
      "deploy",
    ]);
    expect(chatDisabledSkills("cursor", ["deploy"])).toEqual(["deploy"]);
    expect(chatDisabledSkills("pi", ["deploy"])).toEqual([]);
    expect(chatDisabledSkills("claude", undefined)).toEqual([]);
    expect(
      turnDisabledSkills({ harness: "codex", disabledSkills: ["deploy"] }),
    ).toEqual(["deploy"]);
    expect(
      turnDisabledSkills({ harness: "omp", disabledSkills: ["deploy"] }),
    ).toEqual([]);
  });
});

describe("what a harness turn receives", () => {
  it("hands the names to Claude Code only, sorted", () => {
    expect(harnessDisabledSkills("claude", ["review-pr", "deploy"])).toEqual([
      "deploy",
      "review-pr",
    ]);
    expect(harnessDisabledSkills("codex", ["deploy"])).toBeUndefined();
    expect(harnessDisabledSkills("cursor", ["deploy"])).toBeUndefined();
    expect(harnessDisabledSkills("claude", [])).toBeUndefined();
    expect(harnessDisabledSkills("claude", undefined)).toBeUndefined();
  });

  it("is part of sessionToolsInput", () => {
    const session = {
      harness: "claude" as const,
      disabledMcpServers: ["github"],
      disabledSkills: ["deploy"],
    };
    expect(sessionToolsInput(session, "/repo")).toEqual({
      disabledMcpServers: ["github"],
      disabledSkills: ["deploy"],
    });
    expect(
      sessionToolsInput({ ...session, harness: "codex" }, "/repo"),
    ).toEqual({ disabledMcpServers: ["github"] });
  });

  it("counts switched-off skills in the summary wherever the switches work", () => {
    expect(
      sessionToolsSummary(
        {
          harness: "claude",
          disabledMcpServers: ["github"],
          toolAccess: { Bash: "always" },
          disabledSkills: ["deploy"],
        },
        "/repo",
      ),
    ).toEqual({
      label: "1 off · 1 tool rule · 1 skill off",
      title: "Connectors off: github\nAlways allow: Bash\nSkills off: deploy",
    });
    expect(
      sessionToolsSummary(
        { harness: "codex", disabledSkills: ["deploy", "review-pr"] },
        "/repo",
      ),
    ).toEqual({
      label: "2 skills off",
      title: "Skills off: deploy, review-pr",
    });
    expect(
      sessionToolsSummary({ harness: "pi", disabledSkills: ["deploy"] }, "/r"),
    ).toBeNull();
  });

  it("replaces the list through a patch and clears it when empty", () => {
    const session = { id: "s1", disabledSkills: ["deploy"] };
    expect(
      withSessionToolsPatch(session, { disabledSkills: ["deploy", "review"] }),
    ).toEqual({ id: "s1", disabledSkills: ["deploy", "review"] });
    expect(
      withSessionToolsPatch(session, { disabledSkills: [] }).disabledSkills,
    ).toBeUndefined();
    // A patch for another setting leaves it alone.
    expect(
      withSessionToolsPatch(session, { toolAccess: { Bash: "never" } }),
    ).toEqual({
      id: "s1",
      disabledSkills: ["deploy"],
      toolAccess: { Bash: "never" },
    });
  });
});

describe("chatSkillRows", () => {
  const catalog = [
    { kind: "file", name: "review-pr", description: "Review a pull request" },
    { kind: "builtin", name: "create-skill", description: "Create a skill" },
    { kind: "file", name: "deploy", description: "Ship it" },
    { kind: "native", name: "orchestrate", description: "A harness command" },
    { kind: "file", name: "deploy", description: "A second file, shadowed" },
  ];

  it("lists the catalog's skills by name with their state for this chat", () => {
    expect(chatSkillRows(catalog, ["deploy"])).toEqual([
      { name: "create-skill", detail: "Create a skill", enabled: true },
      { name: "deploy", detail: "Ship it", enabled: false },
      { name: "review-pr", detail: "Review a pull request", enabled: true },
    ]);
  });

  it("keeps a switched-off skill that is gone from the catalog, to switch back on", () => {
    expect(chatSkillRows(catalog, ["old-skill"]).at(-1)).toEqual({
      name: "old-skill",
      detail: "Not found in this project",
      enabled: false,
      missing: true,
    });
    expect(chatSkillRows([], [])).toEqual([]);
  });
});

describe("chatSkillsCaveat", () => {
  it("says what the switch covers on each harness", () => {
    expect(chatSkillsCaveat("claude")).toBe(
      "Off also stops Claude Code from using the skill on its own.",
    );
    expect(chatSkillsCaveat("codex")).toBe(
      "Off covers this chat's / menu. Codex may still load the skill on its own.",
    );
  });
});
