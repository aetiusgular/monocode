import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock("../../../integrations/harness/core/registry", () => ({
  getHarness: (id: string) =>
    id === "pi" ? { commands: { discover: async () => [] } } : undefined,
}));
vi.mock("../../../platform/tauri/fs", () => ({
  createPath: vi.fn(),
  homeDir: vi.fn(),
  listSkills: mocks.listSkills,
  readTextFile: mocks.readTextFile,
  writeTextFile: vi.fn(),
}));
vi.mock("../../files/model/fileMentions", () => ({
  applyFileMentionsToTurn: async (text: string) => text,
}));
vi.mock("../../notes", () => ({
  applyNotesToTurn: async (text: string) => text,
}));

import type { DiscoveredSkill } from "../../../platform/tauri/fs";
import { preparePrompt } from "../../sessions/model/promptPreparation";
import { applySkillsToTurn, invalidateSkills } from "../../skills/model/skills";
import { turnDisabledSkills } from "./chatSkills";

const skill = (name: string): DiscoveredSkill => ({
  name,
  description: `${name} description`,
  path: `/repo/.claude/skills/${name}/SKILL.md`,
  scope: "project",
  source: "claude",
});

beforeEach(() => {
  invalidateSkills();
  mocks.listSkills.mockReset();
  mocks.listSkills.mockResolvedValue([skill("deploy"), skill("review-pr")]);
  mocks.readTextFile.mockReset();
  mocks.readTextFile.mockImplementation(
    async (path: string) => `Body of ${path}`,
  );
});

describe("a skill switched off for one chat", () => {
  const context = { harness: "claude" as const, cwd: "/repo", sessionId: "s1" };

  it("is expanded as usual while it is on", async () => {
    const prompt = await applySkillsToTurn("/deploy to staging", context);
    expect(prompt).toContain("## /deploy");
    expect(prompt).toContain("Body of /repo/.claude/skills/deploy/SKILL.md");
    expect(prompt.endsWith("/deploy to staging")).toBe(true);
  });

  it("is not expanded: its /name stays plain text", async () => {
    await expect(
      applySkillsToTurn("/deploy to staging", {
        ...context,
        disabledSkills: ["deploy"],
      }),
    ).resolves.toBe("/deploy to staging");
    expect(mocks.readTextFile).not.toHaveBeenCalled();
  });

  it("leaves the other skills in the same message working", async () => {
    const prompt = await applySkillsToTurn(
      "/deploy to staging, then /review-pr",
      { ...context, disabledSkills: ["deploy"] },
    );
    expect(prompt).toContain("## /review-pr");
    expect(prompt).not.toContain("## /deploy");
    expect(mocks.readTextFile).toHaveBeenCalledTimes(1);
  });

  it("is still expanded in another chat on the same project", async () => {
    await applySkillsToTurn("/deploy", {
      ...context,
      disabledSkills: ["deploy"],
    });
    const other = await applySkillsToTurn("/deploy", {
      ...context,
      sessionId: "s2",
    });
    expect(other).toContain("## /deploy");
  });

  it("is honored by the prompt a turn is sent with", async () => {
    const session = { harness: "claude" as const, disabledSkills: ["deploy"] };
    await expect(
      preparePrompt("/deploy to staging", {
        ...context,
        disabledSkills: turnDisabledSkills(session),
      }),
    ).resolves.toBe("/deploy to staging");
    await expect(
      preparePrompt("/deploy to staging", {
        ...context,
        disabledSkills: turnDisabledSkills({ harness: "claude" }),
      }),
    ).resolves.toContain("## /deploy");
  });
});
