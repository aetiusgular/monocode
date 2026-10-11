import {
  HARNESS_TITLE,
  harnessSupportsSkillSwitches,
  type HarnessId,
} from "../../sessions/model/session";

/** Bounds what a saved session can put on a harness command line. */
export const MAX_DISABLED_SKILLS = 64;

/** Fired on `window` to open Settings on the Skills page. */
export const OPEN_SKILLS_SETTINGS_EVENT = "monocode:open-skills-settings";

/**
 * A catalog skill name: lowercase words joined by single dashes, at most 64
 * characters. The same rule the skill scanner and `isValidSkillName` apply,
 * repeated here so the session store does not load the skill catalog.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isSkillName(name: string): boolean {
  return name.length <= 64 && SKILL_NAME.test(name);
}

/**
 * A stored list read back from disk: valid, unique, bounded skill names.
 *
 * A chat's switched-off skills are kept by name, not by file path as the
 * app-wide list in Settings keeps them. The name is what `/name` invokes and
 * what a Claude Code `Skill(name)` rule matches, and it stays the same when
 * the chat moves into a worktree, where every project skill has a new path.
 */
export function sanitizeDisabledSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const entry of value) {
    if (names.length >= MAX_DISABLED_SKILLS) break;
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (isSkillName(name) && !names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

/**
 * Switch one skill on or off for a chat. The list holds the skills that are
 * off. Returns `disabled` itself when nothing changes.
 */
export function setSkillEnabled(
  disabled: readonly string[],
  name: string,
  enabled: boolean,
): string[] {
  const listed = disabled.includes(name);
  if (enabled) {
    return listed
      ? disabled.filter((entry) => entry !== name)
      : (disabled as string[]);
  }
  if (listed || !isSkillName(name) || disabled.length >= MAX_DISABLED_SKILLS) {
    return disabled as string[];
  }
  return [...disabled, name];
}

/**
 * The skills switched off for a chat on this harness, or none where the
 * switches do nothing: the composer's `/` list and prompt expansion go by
 * this.
 */
export function chatDisabledSkills(
  harness: HarnessId,
  disabled: readonly string[] | undefined,
): string[] {
  if (!disabled?.length || !harnessSupportsSkillSwitches(harness)) return [];
  return sanitizeDisabledSkills(disabled) ?? [];
}

/** The same for a session about to send a turn, for prompt preparation. */
export function turnDisabledSkills(session: {
  harness: HarnessId;
  disabledSkills?: string[];
}): string[] {
  return chatDisabledSkills(session.harness, session.disabledSkills);
}

/**
 * The names to hand a harness so the model cannot invoke the skills itself.
 * Only Claude Code takes them, as `Skill(name)` deny rules. The other
 * harnesses have no such rule that MonoCode knows of, so there the switch
 * covers the `/` list and prompt expansion only.
 */
export function harnessDisabledSkills(
  harness: HarnessId,
  disabled: readonly string[] | undefined,
): string[] | undefined {
  if (harness !== "claude") return undefined;
  const names = chatDisabledSkills(harness, disabled);
  return names.length > 0 ? [...names].sort() : undefined;
}

/** A catalog entry, as far as the switches need to know it. */
type CatalogSkill = { kind: string; name: string; description: string };

export type ChatSkillRow = {
  name: string;
  detail: string;
  /** On for this chat. */
  enabled: boolean;
  /** Switched off for this chat but not in the catalog any more. */
  missing?: boolean;
};

/**
 * One row per skill the chat could invoke with `/name`: the catalog for its
 * harness and project, which already leaves out skills disabled in Settings.
 * Names that are switched off but no longer in the catalog follow, so they
 * can still be switched back on.
 */
export function chatSkillRows(
  catalog: readonly CatalogSkill[],
  disabled: readonly string[],
): ChatSkillRow[] {
  const off = new Set(disabled);
  const seen = new Set<string>();
  const rows: ChatSkillRow[] = [];
  for (const skill of catalog) {
    // A harness's own commands are not skills MonoCode expands.
    if (skill.kind === "native" || seen.has(skill.name)) continue;
    seen.add(skill.name);
    rows.push({
      name: skill.name,
      detail: skill.description,
      enabled: !off.has(skill.name),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const missing = disabled
    .filter((name) => !seen.has(name))
    .map((name) => ({
      name,
      detail: "Not found in this project",
      enabled: false,
      missing: true,
    }));
  return [...rows, ...missing];
}

/**
 * What switching a skill off covers on this harness, in one line. On Claude
 * Code the model is also denied the skill. Elsewhere the harness may still
 * load a skill from its own folders: MonoCode only stops offering and
 * expanding it.
 */
export function chatSkillsCaveat(harness: HarnessId): string {
  return harness === "claude"
    ? "Off also stops Claude Code from using the skill on its own."
    : `Off covers this chat's / menu. ${HARNESS_TITLE[harness]} may still load the skill on its own.`;
}
