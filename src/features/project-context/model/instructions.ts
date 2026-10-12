import type { PreamblePart } from "../../session-preamble/model/preamble";

/**
 * #27: three layers of instructions. Global text and private project notes
 * live in MonoCode and reach every harness through the session preamble
 * (F2). Shared project instructions are the repository's `AGENTS.md`, which
 * every harness reads under its own conditions.
 */

/** Global text and private notes as preamble parts; empty ones are left out. */
export function instructionParts(
  global: string | null | undefined,
  notes: string | null | undefined,
): PreamblePart[] {
  const parts: PreamblePart[] = [];
  if (global?.trim())
    parts.push({
      id: "instructions",
      label: "Your instructions",
      text: global.trim(),
    });
  if (notes?.trim())
    parts.push({
      id: "project-notes",
      label: "Private project notes",
      text: notes.trim(),
    });
  return parts;
}

/**
 * Claude Code reads `AGENTS.md` from 2.1.277, and then only when no
 * `CLAUDE.md` sits in the folder or above, unless its built-in plugin is
 * told to read both. The plugin id changed at 2.1.285.
 */
export const AGENTS_MD_SINCE = [2, 1, 277] as const;
export const AGENTS_MD_RENAMED = [2, 1, 285] as const;

export function parseCliVersion(
  text: string | undefined,
): number[] | undefined {
  const match = text?.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function atLeast(version: number[], floor: readonly number[]): boolean {
  for (let index = 0; index < floor.length; index++) {
    const a = version[index] ?? 0;
    if (a !== floor[index]) return a > floor[index];
  }
  return true;
}

/**
 * The plugin id for this Claude Code version, or undefined when MonoCode
 * does not know the version or it predates `AGENTS.md` support. Undefined
 * leaves the setting out, which is what Claude Code does by itself.
 */
export function agentsMdPluginId(
  version: string | undefined,
): string | undefined {
  const parsed = parseCliVersion(version);
  if (!parsed || !atLeast(parsed, AGENTS_MD_SINCE)) return undefined;
  return atLeast(parsed, AGENTS_MD_RENAMED)
    ? "cc-plugin-agents-md@builtin"
    : "agents-md@builtin";
}

/** The `pluginConfigs` entry for Claude Code's `--settings` JSON. */
export function agentsMdPluginConfig(
  pluginId: string | undefined,
): Record<string, { options: { instructionFiles: string } }> | undefined {
  if (
    pluginId !== "cc-plugin-agents-md@builtin" &&
    pluginId !== "agents-md@builtin"
  )
    return undefined;
  return {
    [pluginId]: { options: { instructionFiles: "claude-md-and-agents-md" } },
  };
}

const AGENTS_MD_KEY = "monocode.agentsMdBesideClaudeMd";

/** "Read AGENTS.md beside CLAUDE.md" in Claude Code. On unless turned off. */
export function agentsMdBesideClaudeMd(): boolean {
  try {
    return localStorage.getItem(AGENTS_MD_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAgentsMdBesideClaudeMd(on: boolean): void {
  try {
    if (on) localStorage.removeItem(AGENTS_MD_KEY);
    else localStorage.setItem(AGENTS_MD_KEY, "off");
  } catch {
    // Lasts until reload.
  }
}
