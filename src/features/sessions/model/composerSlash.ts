import { slashTokenAt, type SlashToken } from "../../skills/model/slashCommands";
import type { Skill } from "../../skills/model/skills";

/**
 * When the composer's `/` menu opens, and whether Return may take its pick
 * (Mac finding 2.x: "ls /nope" opened the menu at "/no" and Return replaced
 * the prompt with "/plan").
 *
 * Commands run only at the start of a message, in Claude Code and in
 * MonoCode's own commands (`/plan`, `/compact`, `/btw`, `/session-folder`).
 * Two things still use `/` later in the text: MonoCode expands `/skill`
 * anywhere in a prompt for harnesses without native commands, and `/mcp` adds
 * an MCP tag beside text already typed. So:
 *
 * - At the start of the prompt (only whitespace before it) the menu opens as
 *   before, and Return takes the highlighted entry.
 * - Later in the text it opens only once the typed name is the start of a
 *   listed command or skill (`see /mc` offers `/mcp`; `ls /nope`, `see a/b`
 *   and `path ~/x/` never open it). Even then Return is not taken: it sends,
 *   and Shift+Return adds a line, as with no menu. Tab, the arrows and a
 *   click still pick.
 */
export type ComposerSlashToken = SlashToken & {
  /** The token is the first thing in the prompt. */
  leading: boolean;
};

function names(skill: Skill): string[] {
  const out = [skill.invocation, skill.name];
  if (skill.kind === "native") out.push(...(skill.aliases ?? []));
  return out.map((name) => name.toLowerCase());
}

export function composerSlashToken(
  text: string,
  cursor: number,
  native: boolean,
  items: readonly Skill[],
): ComposerSlashToken | null {
  const token = slashTokenAt(text, cursor, native);
  if (!token) return null;
  const leading = !text.slice(0, token.start).trim();
  if (leading) return { ...token, leading };
  const query = token.query.toLowerCase();
  if (!query) return null;
  const known = items.some((item) =>
    names(item).some((name) => name.startsWith(query)),
  );
  return known ? { ...token, leading } : null;
}

/** Return takes the menu's pick only for a command at the start. */
export function returnTakesSlashPick(token: ComposerSlashToken | null): boolean {
  return token?.leading === true;
}
