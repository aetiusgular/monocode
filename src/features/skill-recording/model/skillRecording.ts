import { joinPath } from "../../../shared/lib/paths";
import { isLocalProject } from "../../projects/model/recents";
import type { Block, HarnessId } from "../../sessions/model/session";
import { isValidSkillName } from "../../skills/model/skills";

/** The harnesses a recorded skill is written for. */
export type RecordSkillHarness = "claude" | "codex";

export type RecordSkillScope = "user" | "project";

/**
 * Where each harness reads skills, relative to home (`user`) or to the
 * project (`project`). MonoCode's own catalog (`list_skills` in
 * `src-tauri/src/skills.rs`) scans all four, so a skill saved here shows in
 * the `/` menu on either harness.
 *
 * Claude Code reads `.claude/skills` itself. Codex reads `.agents/skills`
 * itself, which is also the folder MonoCode's "New skill" and `/create-skill`
 * use. Saving in the harness's own folder lets the agent find the skill on
 * its own too, not only through MonoCode's `/name` expansion.
 */
export const RECORD_SKILL_FOLDERS: Record<
  RecordSkillHarness,
  Record<RecordSkillScope, string>
> = {
  claude: { user: ".claude/skills", project: ".claude/skills" },
  codex: { user: ".agents/skills", project: ".agents/skills" },
};

/** A skill description is read from one frontmatter line. */
export const MAX_SKILL_DESCRIPTION = 1024;

export function isRecordSkillHarness(
  harness: HarnessId,
): harness is RecordSkillHarness {
  return harness === "claude" || harness === "codex";
}

/** A user turn the person sent, as opposed to one the app wrote. */
export function isPersonTurn(block: Block): boolean {
  return (
    block.role === "user" &&
    !block.draft &&
    !block.internal &&
    !block.monoSessionCompletion
  );
}

/** User turns that have run to the end. The running one does not count. */
export function finishedTurnCount(
  blocks: readonly Block[],
  busy: boolean,
): number {
  let turns = 0;
  for (const block of blocks) if (isPersonTurn(block)) turns += 1;
  return Math.max(0, busy ? turns - 1 : turns);
}

export type RecordSkillMenu =
  { visible: false } | { visible: true; disabled: boolean; hint: string };

/**
 * Whether the plus menu offers "Record a skill". `available` is false for
 * remote sessions, Monos, Inbox asks and ephemeral chats, which the session
 * pane already works out for the other per-chat entries.
 */
export function recordSkillMenu(input: {
  available: boolean;
  remote: boolean;
  harness: HarnessId;
  blocks: readonly Block[];
  busy: boolean;
}): RecordSkillMenu {
  if (!input.available || input.remote) return { visible: false };
  if (!isRecordSkillHarness(input.harness)) return { visible: false };
  if (finishedTurnCount(input.blocks, input.busy) < 1) {
    return { visible: false };
  }
  return input.busy
    ? { visible: true, disabled: true, hint: "Wait for this turn to finish" }
    : {
        visible: true,
        disabled: false,
        hint: "Save what this chat did as a skill",
      };
}

/**
 * Why a name cannot be used, or null when it can. `taken` holds names that
 * already exist: the chat's skill catalog and the folders in the target.
 */
export function skillNameError(
  raw: string,
  taken: ReadonlySet<string>,
): string | null {
  const name = raw.trim();
  if (!name) return "Enter a name.";
  if (name.length > 64) return "Use at most 64 characters.";
  if (!isValidSkillName(name)) {
    return "Use lowercase letters, numbers and single hyphens, like fix-flaky-test.";
  }
  if (taken.has(name)) return `A skill named ${name} already exists.`;
  return null;
}

/** The description as one line, or null when it is missing. */
export function cleanDescription(raw: string): string | null {
  const line = raw.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, MAX_SKILL_DESCRIPTION) : null;
}

/**
 * The folder a skill is saved in, or null when it has none: no project open
 * for a project skill, or home not known yet for a user skill.
 */
export function recordSkillFolder(input: {
  harness: RecordSkillHarness;
  scope: RecordSkillScope;
  home: string | null;
  projectCwd: string;
}): string | null {
  const relative = RECORD_SKILL_FOLDERS[input.harness][input.scope];
  if (input.scope === "user") {
    return input.home ? joinPath(input.home, relative) : null;
  }
  return isLocalProject(input.projectCwd)
    ? joinPath(input.projectCwd, relative)
    : null;
}

/** The one file the agent is asked to write. */
export function recordSkillFile(folder: string, name: string): string {
  return joinPath(folder, `${name.trim()}/SKILL.md`);
}
