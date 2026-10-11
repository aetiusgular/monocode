import { describe, expect, it } from "vitest";
import type { Block, HarnessId } from "../../sessions/model/session";
import {
  cleanDescription,
  finishedTurnCount,
  RECORD_SKILL_FOLDERS,
  recordSkillFile,
  recordSkillFolder,
  recordSkillMenu,
  skillNameError,
} from "./skillRecording";

const user = (id: string, extra: Partial<Block> = {}): Block => ({
  id,
  role: "user",
  text: `prompt ${id}`,
  ...extra,
});
const reply = (id: string): Block => ({ id, role: "assistant", text: "ok" });

const ONE_TURN = [user("u1"), reply("a1")];

function menu(overrides: Partial<Parameters<typeof recordSkillMenu>[0]> = {}) {
  return recordSkillMenu({
    available: true,
    remote: false,
    harness: "claude",
    blocks: ONE_TURN,
    busy: false,
    ...overrides,
  });
}

describe("finishedTurnCount", () => {
  it("counts the person's turns and leaves out the running one", () => {
    const blocks = [user("u1"), reply("a1"), user("u2")];
    expect(finishedTurnCount(blocks, false)).toBe(2);
    expect(finishedTurnCount(blocks, true)).toBe(1);
    expect(finishedTurnCount([user("u1")], true)).toBe(0);
    expect(finishedTurnCount([], false)).toBe(0);
  });

  it("does not count drafts, app-written turns or Mono reports", () => {
    const blocks = [
      user("draft", { draft: true }),
      user("internal", { internal: true }),
      user("report", {
        monoSessionCompletion: {
          sessionId: "s",
          title: "t",
          status: "completed",
        },
      }),
    ];
    expect(finishedTurnCount(blocks, false)).toBe(0);
  });
});

describe("recordSkillMenu", () => {
  it("shows on Claude Code and Codex once a turn has finished", () => {
    expect(menu()).toEqual({
      visible: true,
      disabled: false,
      hint: "Save what this chat did as a skill",
    });
    expect(menu({ harness: "codex" }).visible).toBe(true);
  });

  it("hides on every other harness", () => {
    const others: HarnessId[] = [
      "cursor",
      "opencode",
      "pi",
      "omp",
      "fx",
      "grok",
      "hermes",
      "antigravity",
    ];
    for (const harness of others) {
      expect(menu({ harness }).visible, harness).toBe(false);
    }
  });

  it("hides for remote sessions and chats the pane marks unavailable", () => {
    expect(menu({ remote: true }).visible).toBe(false);
    // Monos, Inbox asks and ephemeral chats arrive as `available: false`.
    expect(menu({ available: false }).visible).toBe(false);
  });

  it("hides before the first turn has finished", () => {
    expect(menu({ blocks: [] }).visible).toBe(false);
    expect(menu({ blocks: [user("u1")], busy: true }).visible).toBe(false);
  });

  it("stays visible but disabled while a later turn runs", () => {
    expect(menu({ blocks: [...ONE_TURN, user("u2")], busy: true })).toEqual({
      visible: true,
      disabled: true,
      hint: "Wait for this turn to finish",
    });
  });
});

describe("skillNameError", () => {
  const none = new Set<string>();

  it("accepts kebab-case names", () => {
    expect(skillNameError("fix-flaky-test", none)).toBeNull();
    expect(skillNameError("deploy2", none)).toBeNull();
    expect(skillNameError("  trimmed-name  ", none)).toBeNull();
  });

  it("refuses names that are not kebab-case", () => {
    for (const bad of [
      "Fix-Test",
      "fix_test",
      "fix test",
      "-fix",
      "fix-",
      "fix--test",
      "fix/test",
      "../escape",
    ]) {
      expect(skillNameError(bad, none), bad).toMatch(/lowercase/);
    }
  });

  it("refuses an empty or overlong name", () => {
    expect(skillNameError("   ", none)).toBe("Enter a name.");
    expect(skillNameError("a".repeat(65), none)).toBe(
      "Use at most 64 characters.",
    );
    expect(skillNameError("a".repeat(64), none)).toBeNull();
  });

  it("refuses a name that already exists", () => {
    expect(skillNameError("deploy", new Set(["deploy"]))).toBe(
      "A skill named deploy already exists.",
    );
  });
});

describe("cleanDescription", () => {
  it("keeps one line and drops an empty one", () => {
    expect(cleanDescription("  Use when\n CI fails.  ")).toBe(
      "Use when CI fails.",
    );
    expect(cleanDescription(" \n ")).toBeNull();
    expect(cleanDescription("x".repeat(2000))).toHaveLength(1024);
  });
});

describe("recordSkillFolder", () => {
  const home = "/Users/tony";

  it("uses the folders each harness reads itself", () => {
    expect(RECORD_SKILL_FOLDERS).toEqual({
      claude: { user: ".claude/skills", project: ".claude/skills" },
      codex: { user: ".agents/skills", project: ".agents/skills" },
    });
  });

  it("saves a user skill under home", () => {
    expect(
      recordSkillFolder({
        harness: "claude",
        scope: "user",
        home,
        projectCwd: "/repo",
      }),
    ).toBe("/Users/tony/.claude/skills");
    expect(
      recordSkillFolder({
        harness: "codex",
        scope: "user",
        home,
        projectCwd: "/repo",
      }),
    ).toBe("/Users/tony/.agents/skills");
  });

  it("has no user folder until home is known", () => {
    expect(
      recordSkillFolder({
        harness: "claude",
        scope: "user",
        home: null,
        projectCwd: "/repo",
      }),
    ).toBeNull();
  });

  it("saves a project skill in the folder the chat runs in", () => {
    expect(
      recordSkillFolder({
        harness: "claude",
        scope: "project",
        home,
        projectCwd: "/repo/",
      }),
    ).toBe("/repo/.claude/skills");
    expect(
      recordSkillFolder({
        harness: "codex",
        scope: "project",
        home,
        projectCwd: "/repo",
      }),
    ).toBe("/repo/.agents/skills");
  });

  it("has no project folder without a local project", () => {
    for (const projectCwd of ["~", "/", ""]) {
      const folder = recordSkillFolder({
        harness: "claude",
        scope: "project",
        home,
        projectCwd,
      });
      expect(folder, projectCwd).toBeNull();
    }
  });

  it("puts the file in a folder named after the skill", () => {
    expect(recordSkillFile("/repo/.claude/skills", "fix-flaky-test")).toBe(
      "/repo/.claude/skills/fix-flaky-test/SKILL.md",
    );
  });
});
